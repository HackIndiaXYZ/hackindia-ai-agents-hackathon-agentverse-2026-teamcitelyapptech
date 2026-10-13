"""Demo usage limits: how many documents and questions an account gets, and
how many the whole app serves per day.

Everything is counted on the server before any cost is incurred (parsing,
embedding, the chat model), so the limits hold however the API is called.
The admin (CITELY_ADMIN_EMAILS) is never limited.

Settings (environment):
  QUOTA_ENABLED           "true" to apply the limits (default off)
  QUOTA_UPLOADS           documents per account, in total        (3)
  QUOTA_QUESTIONS         questions per account, in total        (5)
  QUOTA_DAILY_UPLOADS     documents across everyone, per day     (3)
  QUOTA_DAILY_QUESTIONS   questions across everyone, per day     (10)
  QUOTA_MAX_UPLOAD_MB     largest file a limited account may send (10)
  QUOTA_MAX_PAGES         most pages/slides/sheets per document   (30)
  QUOTA_TIMEZONE          when "a day" starts                     (Asia/Kolkata)

These are defaults. Once the admin saves limits in the admin console they
are kept in the database (app_settings "limits") and take precedence,
including whether an account's limit is a total ("total") or resets every
day ("daily").
"""

from __future__ import annotations

import io
import os
import re
import threading
import time
import zipfile
from datetime import datetime
from zoneinfo import ZoneInfo

from APP import db
from APP.access_control import is_admin_email

UPLOAD, QUESTION = "upload", "question"


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


PERIODS = ("total", "daily")
SETTING_KEY = "limits"
# Saved settings, per database file, re-read every few seconds.
_saved: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()


def defaults() -> dict:
    """The limits from the environment, used until the admin saves others."""
    return {
        "enabled": os.getenv("QUOTA_ENABLED", "false").strip().lower() in ("1", "true", "yes"),
        "uploads": _int("QUOTA_UPLOADS", 3),
        "questions": _int("QUOTA_QUESTIONS", 5),
        "period": "total",
        "daily_uploads": _int("QUOTA_DAILY_UPLOADS", 3),
        "daily_questions": _int("QUOTA_DAILY_QUESTIONS", 10),
        "max_upload_mb": _int("QUOTA_MAX_UPLOAD_MB", 10),
        "max_pages": _int("QUOTA_MAX_PAGES", 30),
    }


def _saved_settings() -> dict:
    key = str(db.DB_PATH)
    with _cache_lock:
        hit = _saved.get(key)
        if hit and time.monotonic() - hit[0] < 5:
            return hit[1]
    saved = db.get_setting(SETTING_KEY) or {}
    with _cache_lock:
        _saved[key] = (time.monotonic(), saved)
    return saved


def settings() -> dict:
    """The limits in force: saved ones over the defaults. Saved settings are
    re-read every few seconds (and right after a save), so a change applies
    without a restart."""
    return {**defaults(), **_saved_settings()}


def save_settings(values: dict) -> dict:
    db.set_setting(SETTING_KEY, values)
    with _cache_lock:
        _saved.pop(str(db.DB_PATH), None)
    return settings()


def enabled() -> bool:
    return bool(settings()["enabled"])


def period() -> str:
    """"total": an account's uploads/questions are for good; "daily": they reset each day."""
    return settings()["period"] if settings()["period"] in PERIODS else "total"


def limits() -> dict:
    s = settings()
    return {
        UPLOAD: {"account": int(s["uploads"]), "daily": int(s["daily_uploads"])},
        QUESTION: {"account": int(s["questions"]), "daily": int(s["daily_questions"])},
    }


def max_upload_bytes() -> int:
    return int(settings()["max_upload_mb"]) * 1024 * 1024


def max_pages() -> int:
    return int(settings()["max_pages"])


def today() -> str:
    try:
        zone = ZoneInfo(os.getenv("QUOTA_TIMEZONE", "Asia/Kolkata"))
    except Exception:  # noqa: BLE001 — unknown zone name: fall back to UTC
        zone = ZoneInfo("UTC")
    return datetime.now(zone).date().isoformat()


def _email(user) -> str | None:
    try:
        return user["email"]
    except (KeyError, IndexError, TypeError):
        return None


def is_limited(user) -> bool:
    return enabled() and not is_admin_email(_email(user))


MESSAGES = {
    (UPLOAD, "account_daily"): "You've used today's {limit} document uploads. They reset tomorrow.",
    (QUESTION, "account_daily"): "You've used today's {limit} questions. They reset tomorrow.",
    (UPLOAD, "account"): "You've used all {limit} document uploads in this demo. Thank you for trying Citely!",
    (UPLOAD, "daily"): "The live demo has reached today's upload limit. Please try again tomorrow, or explore the guided demo.",
    (QUESTION, "account"): "You've used all {limit} questions in this demo. Thank you for trying Citely!",
    (QUESTION, "daily"): "The live demo has reached today's question limit. Please try again tomorrow, or explore the guided demo.",
}


def message(kind: str, scope: str) -> str:
    key = "account_daily" if scope == "account" and period() == "daily" else scope
    return MESSAGES[(kind, key)].format(limit=limits()[kind][scope])


def reserve(user, kind: str) -> str | None:
    """Counts one use for a limited account and returns the day it was
    counted against (needed to give it back); None if not limited. Raises
    db.UsageLimitReached when a limit is reached."""
    if not is_limited(user):
        return None
    day = today()
    lim = limits()[kind]
    db.reserve_usage(user["id"], kind, per_account=lim["account"], daily=lim["daily"], day=day,
                     account_resets_daily=period() == "daily")
    return day


def release(user, kind: str, day: str | None) -> None:
    if day is not None:
        db.release_usage(user["id"], kind, day=day)


def snapshot(user) -> dict:
    """What the workspace shows: remaining uses, or unlimited."""
    if not is_limited(user):
        return {"limited": False}
    day = today()
    counts = db.usage_counts(user["id"], day)
    lim = limits()
    daily_account = period() == "daily"
    out = {"limited": True, "period": period(), "max_upload_mb": max_upload_bytes() // (1024 * 1024), "max_pages": max_pages()}
    for kind in (UPLOAD, QUESTION):
        used = (counts["account_today"] if daily_account else counts["account"]).get(kind, 0)
        daily_used = counts["daily"].get(kind, 0)
        out[kind + "s"] = {"used": used, "limit": lim[kind]["account"],
                           "remaining": max(0, min(lim[kind]["account"] - used, lim[kind]["daily"] - daily_used)),
                           "daily_exhausted": daily_used >= lim[kind]["daily"]}
    return out


def page_count(raw: bytes, filename: str) -> int | None:
    """A cheap page count taken before parsing, so a document over the limit
    is refused before it costs anything (Word files and scans are parsed by a
    paid service). None when the format doesn't say; the parsed page count is
    checked afterwards in that case."""
    name = filename.lower()
    try:
        if name.endswith(".pdf"):
            from pypdf import PdfReader
            return len(PdfReader(io.BytesIO(raw)).pages)
        if name.endswith((".pptx", ".xlsx", ".docx")):
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                names = archive.namelist()
                if name.endswith(".pptx"):
                    return sum(1 for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n))
                if name.endswith(".xlsx"):
                    return sum(1 for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
                if "docProps/app.xml" in names:
                    found = re.search(rb"<Pages>(\d+)</Pages>", archive.read("docProps/app.xml"))
                    return int(found.group(1)) if found else None
                return None
        if name.endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp", ".heif")):
            return 1
    except Exception:  # noqa: BLE001 — unreadable here; the parser decides
        return None
    return None
