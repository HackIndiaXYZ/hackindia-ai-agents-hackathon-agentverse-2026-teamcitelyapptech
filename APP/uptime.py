"""Uptime of the production site and API, for the admin console.

UptimeRobot checks citely.example every hour and the API once a day (each
API check can wake a sleeping server, so it is kept rare). This reads those
checks with a read-only key (UPTIMEROBOT_READONLY_KEY, set on production
only), and runs an on-demand check of the website for the console's
"Check now". Answers are kept for two minutes.
"""

from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timedelta, timezone

import structlog

logger = structlog.get_logger("rag_api.uptime")

API_URL = "https://api.uptimerobot.com/v2/getMonitors"
SITE_URL = "https://citely.example/"
DAYS = 30
CACHE_SECONDS = 120
STATUS = {0: "paused", 1: "not checked yet", 2: "up", 8: "seems down", 9: "down"}
LOG_TYPES = {1: "down", 2: "up", 98: "started", 99: "paused"}

_cache: tuple[float, dict] | None = None
_lock = threading.Lock()


class UptimeUnavailable(Exception):
    """UptimeRobot couldn't be asked or refused; the message says why."""


def configured() -> bool:
    return bool(os.getenv("UPTIMEROBOT_READONLY_KEY"))


def _day_ranges(now: datetime) -> tuple[str, list[str]]:
    """UptimeRobot's custom_uptime_ranges for the last DAYS UTC days, oldest first."""
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    days = [today - timedelta(days=DAYS - 1 - i) for i in range(DAYS)]
    ranges = []
    for start in days:
        end = min(start + timedelta(days=1), now)
        ranges.append(f"{int(start.timestamp())}_{int(end.timestamp())}")
    return "-".join(ranges), [d.date().isoformat() for d in days]


def _ask(params: dict) -> dict:
    import httpx
    try:
        response = httpx.post(API_URL, data={"api_key": os.environ["UPTIMEROBOT_READONLY_KEY"], "format": "json", **params}, timeout=20)
        body = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise UptimeUnavailable(f"Couldn't reach UptimeRobot: {type(exc).__name__}") from exc
    if body.get("stat") != "ok":
        message = (body.get("error") or {}).get("message") or f"HTTP {response.status_code}"
        raise UptimeUnavailable(f"UptimeRobot refused the request: {message}"[:300])
    return body


def _monitor(m: dict, day_labels: list[str]) -> dict:
    # create_datetime comes back in the account's timezone (e.g. +5:30), not
    # UTC, so it can name the next day; the earliest UTC date it could mean
    # is used (UTC-14 h), which never hides the day checks really began.
    created = datetime.fromtimestamp(int(m.get("create_datetime") or 0) - 14 * 3600, timezone.utc).date().isoformat()
    ratios = (m.get("custom_uptime_ranges") or "").split("-")
    daily = []
    for label, ratio in zip(day_labels, ratios):
        # Days before the check existed have no data (UptimeRobot reports 100).
        daily.append({"day": label, "uptime": None if label < created else round(float(ratio), 3)})
    week, month = (m.get("custom_uptime_ratio") or "-").split("-") if m.get("custom_uptime_ratio") else (None, None)
    times = m.get("response_times") or []
    url = m.get("url") or ""
    incidents = [{"started_at": datetime.fromtimestamp(int(log["datetime"]), timezone.utc).isoformat(),
                  "duration_s": int(log.get("duration") or 0),
                  "reason": ((log.get("reason") or {}).get("detail") or (log.get("reason") or {}).get("code") or "")}
                 for log in (m.get("logs") or []) if int(log.get("type", 0)) == 1]
    return {
        "id": m.get("id"),
        "name": m.get("friendly_name"),
        "url": url,
        "kind": "api" if "/health" in url else "website",
        "status": STATUS.get(int(m.get("status", 1)), "unknown"),
        "interval_s": int(m.get("interval") or 0),
        "created": created,
        "uptime_7d": float(week) if week not in (None, "") else None,
        "uptime_30d": float(month) if month not in (None, "") else None,
        "last_check_at": datetime.fromtimestamp(int(times[0]["datetime"]), timezone.utc).isoformat() if times else None,
        "last_response_ms": int(times[0]["value"]) if times else None,
        "daily": daily,
        "incidents": incidents,
    }


def report() -> dict:
    global _cache
    if not configured():
        return {"configured": False, "monitors": []}
    with _lock:
        if _cache and time.monotonic() - _cache[0] < CACHE_SECONDS:
            return _cache[1]
    now = datetime.now(timezone.utc)
    ranges, labels = _day_ranges(now)
    since = int((now - timedelta(days=DAYS)).timestamp())
    body = _ask({"custom_uptime_ratios": "7-30", "custom_uptime_ranges": ranges, "logs": 1, "logs_limit": 50,
                 "logs_start_date": since, "logs_end_date": int(now.timestamp()), "response_times": 1, "response_times_limit": 1})
    monitors = sorted((_monitor(m, labels) for m in body.get("monitors") or []), key=lambda x: x["kind"] != "website")
    out = {"configured": True, "generated_at": now.isoformat(), "days": DAYS, "monitors": monitors}
    with _lock:
        _cache = (time.monotonic(), out)
    return out


def check_site() -> dict:
    """The console's "Check now" for the website, from this server: the API
    half is the console's own request reaching here."""
    import httpx
    started = time.monotonic()
    try:
        response = httpx.get(SITE_URL, timeout=15, follow_redirects=True, headers={"User-Agent": "Citely admin uptime check"})
        ok = response.status_code < 400
        return {"url": SITE_URL, "ok": ok, "status_code": response.status_code,
                "ms": round((time.monotonic() - started) * 1000), "error": None if ok else f"HTTP {response.status_code}"}
    except httpx.HTTPError as exc:
        logger.warning("uptime_site_check_failed", error=f"{type(exc).__name__}: {exc}"[:200])
        return {"url": SITE_URL, "ok": False, "status_code": None, "ms": round((time.monotonic() - started) * 1000),
                "error": f"{type(exc).__name__}: {exc}"[:200]}
