"""Admin console API. Every route here is for the admin only: the verified
account whose address is in CITELY_ADMIN_EMAILS (the Citely address). Anyone
else gets 403, whether signed in or not.

Each environment (prod, dev, hack) serves this from its own database; the
admin page asks each one and combines the answers.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import resource
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from typing import Literal

from pydantic import BaseModel, Field

from APP import access_control as ac
from APP import activity, db, presence, traffic, uptime, usage
from APP.refreshing import Refreshing
from APP.auth import generate_reset_token, get_current_user, hash_reset_token
from APP.auth import email as mail
from APP import demo_access
from APP.account_access import mask_email
from APP.demo_access import _send, approve_email
from APP.rag import originals
from APP.rag.vector_store import document_index_dir

import structlog

logger = structlog.get_logger("rag_api.admin")

SAMPLES_DIR = Path("data/samples")
SAMPLE_KINDS = {".pdf": "PDF", ".docx": "DOCX", ".pptx": "PPTX", ".xlsx": "XLSX"}
MAX_SAMPLE_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))


def require_admin(current_user=Depends(get_current_user)):
    if not current_user["email_verified"] or not ac.is_admin_email(current_user["email"]):
        raise HTTPException(status_code=403, detail="Admin only.")
    return current_user


router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _event(row) -> dict:
    out = dict(row)
    out["detail"] = json.loads(out["detail"]) if out.get("detail") else None
    return out


def _user_summary(row) -> dict:
    out = dict(row)
    out["providers"] = sorted(set((out.get("providers") or "").split(","))) if out.get("providers") else []
    out["has_password"] = bool(out.get("has_password"))
    out["email_verified"] = bool(out.get("email_verified"))
    out["is_admin"] = ac.is_admin_email(out["email"])
    return out


def _environment() -> dict:
    url = os.getenv("APP_PUBLIC_URL", "")
    host_path = url.split("://", 1)[-1]
    name = ("hack" if "/hack" in host_path else "dev" if host_path.startswith("dev.") or "/dev" in host_path
            else "prod" if url else "local")
    return {"name": name, "public_url": url or None}


# --------------------------------------------------------------------------- #
# Overview
# --------------------------------------------------------------------------- #

@router.get("/overview")
def overview(days: int = 14) -> dict:
    days = max(1, min(days, 90))
    now = datetime.now(timezone.utc)
    since_day = (now - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    counts = db.admin_user_counts(presence.online_user_ids(), _iso(now - timedelta(days=1)),
                                  _iso(now - timedelta(days=7)))
    per_day = db.per_day_counts(since_day)
    api_traffic: dict[str, dict] = {}
    for r in db.api_requests_since(since_day):
        t = api_traffic.setdefault(r["day"], {"requests": 0, "errors": 0})
        t["requests"] += r["requests"]
        t["errors"] += r["errors"]
    for (day, _bucket), (n, e) in activity.requests_counter.unflushed().items():
        t = api_traffic.setdefault(day, {"requests": 0, "errors": 0})
        t["requests"] += n
        t["errors"] += e
    series = []
    for i in range(days):
        day = (now - timedelta(days=days - 1 - i)).strftime("%Y-%m-%d")
        series.append({"day": day, **per_day.get(day, {"uploads": 0, "questions": 0, "signups": 0}),
                       **api_traffic.get(day, {"requests": 0, "errors": 0})})
    lim = usage.limits()
    return {
        "environment": _environment(),
        "generated_at": _iso(now),
        "users": counts,
        "per_day": series,
        "limits": {
            "enabled": usage.enabled(), "period": usage.period(),
            "uploads_per_account": lim[usage.UPLOAD]["account"], "questions_per_account": lim[usage.QUESTION]["account"],
            "uploads_per_day": lim[usage.UPLOAD]["daily"], "questions_per_day": lim[usage.QUESTION]["daily"],
            "max_upload_mb": usage.max_upload_bytes() // (1024 * 1024), "max_pages": usage.max_pages(),
        },
        "usage_today": db.usage_counts("", usage.today())["daily"],
    }


# --------------------------------------------------------------------------- #
# Users
# --------------------------------------------------------------------------- #

@router.get("/users")
def users(query: str = "", status: str | None = None, limit: int = 50, offset: int = 0) -> dict:
    if status and status != "members" and status not in db.ACCOUNT_STATUSES:
        raise HTTPException(status_code=400, detail="Unknown status.")
    rows, total = db.admin_user_list(query, status, limit, offset)
    items = []
    for r in rows:
        item = _user_summary(r)
        # online / away / offline from the workspace's presence signals; None
        # (shown "—") for pending and declined accounts.
        item.update(presence.describe(item))
        items.append(item)
    return {"total": total, "items": items}


@router.get("/users/{user_id}")
def user_detail(user_id: str) -> dict:
    detail = db.admin_user_detail(user_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="User not found.")
    user = detail.pop("user")
    user["has_password"] = bool(user.pop("password_hash", None))
    user["is_admin"] = ac.is_admin_email(user["email"])
    user.update(presence.describe(user))
    events = [_event(e) for e in db.list_events(user_id=user_id, limit=100)]
    browsers = [dict(b) for b in db.list_trusted_browsers(user_id)]
    counts = db.usage_counts(user_id, usage.today())
    return {"user": user, **detail, "trusted_browsers": browsers, "events": events,
            "usage": {"total": counts["account"], "today": counts["account_today"]}}


class StatusChange(BaseModel):
    action: str = Field(pattern="^(approve|decline|suspend|unsuspend)$")
    reason: str | None = Field(default=None, max_length=300)


_ACTION_STATUS = {"approve": "approved", "decline": "declined", "suspend": "suspended", "unsuspend": "approved"}


def _target(user_id: str, admin) -> dict:
    user = db.get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    if user["id"] == admin["id"] or ac.is_admin_email(user["email"]):
        raise HTTPException(status_code=400, detail="The admin account can't be changed here.")
    return user


@router.post("/users/{user_id}/status")
def change_status(user_id: str, change: StatusChange, request: Request, admin=Depends(require_admin)) -> dict:
    user = _target(user_id, admin)
    status = _ACTION_STATUS[change.action]
    if change.action == "unsuspend" and user["status"] != "suspended":
        raise HTTPException(status_code=400, detail="This account isn't suspended.")
    db.set_user_status(user_id, status, change.reason if change.action in ("suspend", "decline") else None)
    if change.action == "approve" and user["status"] in ("pending", "declined"):
        db.approve_access(user["email"])
        _send(mail.send_account_approved_email, user["email"])
    elif change.action == "decline" and user["status"] != "declined":
        _send(mail.send_account_declined_email, user["email"])
    elif change.action == "suspend":
        db.forget_trusted_browsers(user_id)
    if status != "approved":
        presence.end(user_id)                     # blocked from now on: offline at once
    activity.record(f"admin.{change.action}", request=request, user=admin,
                    detail={"target": user["email"], **({"reason": change.reason} if change.reason else {})})
    return {"id": user_id, "status": status}


@router.post("/users/{user_id}/revoke-browsers")
def revoke_browsers(user_id: str, request: Request, admin=Depends(require_admin)) -> dict:
    user = db.get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    removed = db.forget_trusted_browsers(user_id)
    activity.record("admin.revoke_browsers", request=request, user=admin, detail={"target": user["email"], "removed": removed})
    return {"id": user_id, "removed": removed}


@router.post("/users/{user_id}/password-reset")
def send_password_reset(user_id: str, request: Request, admin=Depends(require_admin)) -> dict:
    """Emails the account a one-time link to choose a new password. Work
    accounts can only reset this way; the admin never sees the password."""
    user = _target(user_id, admin)
    if not user["password_hash"]:
        raise HTTPException(status_code=400, detail="This account signs in with Google or GitHub, so it has no password to reset.")
    token = generate_reset_token()
    db.create_password_reset_token(user_id, hash_reset_token(token))
    mail.send_password_reset_email(user["email"], token)
    activity.record("admin.password_reset", request=request, user=admin, detail={"target": user["email"]})
    return {"id": user_id, "sent_to": user["email"]}


@router.post("/users/{user_id}/reset-usage")
def reset_usage(user_id: str, request: Request, admin=Depends(require_admin)) -> dict:
    """Gives one account its uploads and questions back (everything it has
    used, in total and today), without touching anyone else's."""
    user = db.get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    cleared = db.reset_user_usage(user_id, usage.today())
    activity.record("admin.usage_reset", request=request, user=admin, detail={"target": user["email"], **{f"{k}_{kind}": n for k, d in cleared.items() for kind, n in d.items()}})
    return {"id": user_id, "email": user["email"], "cleared": cleared, "shared": _shared_today()}


def _shared_today() -> dict:
    """The site-wide daily limits as they stand: used and left today, per kind."""
    lim, used = usage.limits(), db.usage_counts("", usage.today())["daily"]
    return {kind: {"used": used.get(kind, 0), "limit": lim[kind]["daily"], "left": max(0, lim[kind]["daily"] - used.get(kind, 0))}
            for kind in (usage.UPLOAD, usage.QUESTION)}


@router.post("/limits/reset-today")
def reset_today(request: Request, admin=Depends(require_admin)) -> dict:
    """Clears today's site-wide count (shared by everyone), so the daily limit
    starts again from zero. Accounts' own counts are untouched."""
    before = db.reset_daily_usage(usage.today())
    activity.record("admin.daily_reset", request=request, user=admin, detail={f"{k}_before": n for k, n in before.items()})
    return {"cleared": before, "shared": _shared_today()}


class DeleteAccount(BaseModel):
    confirm: str = Field(min_length=3, max_length=254)


@router.post("/users/{user_id}/delete")
def delete_account(user_id: str, body: DeleteAccount, request: Request, admin=Depends(require_admin)) -> dict:
    """Removes the account and everything in it: documents (rows, vectors,
    original files), chats, notes, highlights, workspace state, usage. The
    activity log keeps its history. Confirmed by typing the account's email."""
    user = _target(user_id, admin)
    if body.confirm.strip().lower() != user["email"].lower():
        raise HTTPException(status_code=400, detail="Type the account's email address to confirm.")
    service = request.app.state.rag_service
    removed = 0
    for doc in db.list_documents(user_id):
        if service.remove_document(doc["id"], user_id):
            removed += 1
    owner_dir = document_index_dir(user_id, "x").parent
    if owner_dir.exists():
        originals.remove_tree(owner_dir)
    db.delete_user_rows(user_id)
    presence.forget(user_id)
    activity.record("admin.delete", request=request, user=admin, detail={"target": user["email"], "documents": removed})
    return {"id": user_id, "deleted": True, "documents": removed}


# --------------------------------------------------------------------------- #
# Demo requests
# --------------------------------------------------------------------------- #

@router.get("/demo-requests")
def demo_requests(status: str | None = None) -> dict:
    rows = db.list_demo_requests(status)
    return {"items": [dict(r) for r in rows]}


@router.post("/demo-requests/{request_id}/approve")
def approve_demo_request(request_id: str, request: Request, admin=Depends(require_admin)) -> dict:
    row = db.get_demo_request(request_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Request not found.")
    result = approve_email(row["email"])
    activity.record("admin.approve_request", request=request, user=admin, detail={"target": row["email"]})
    return {"email": row["email"], "approved": True, **result}


# --------------------------------------------------------------------------- #
# Activity
# --------------------------------------------------------------------------- #

@router.get("/events")
def events(type: str | None = None, user_id: str | None = None, since: str | None = None,
           before_id: int | None = None, limit: int = 100) -> dict:
    types = [t.strip() for t in type.split(",") if t.strip()] if type else None
    rows = db.list_events(types=types, user_id=user_id, since=since, before_id=before_id, limit=limit)
    return {"items": [_event(r) for r in rows]}


# --------------------------------------------------------------------------- #
# Admin notifications (new account, demo request): where they go, how the
# recent ones went, and a test
# --------------------------------------------------------------------------- #

NOTICE_DAYS = 7


@router.get("/notifications")
def notifications(test_id: str | None = None) -> dict:
    """The configured address (masked), the recent notifications with their
    outcome, the failures in the last NOTICE_DAYS days (the console's warning
    banner), and, with test_id, how that test went (null while the email
    service hasn't confirmed it yet)."""
    now = datetime.now(timezone.utc)
    recipient = demo_access.admin_recipient()
    recent = [_event(e) for e in db.list_events(types=["admin.notified"], since=_iso(now - timedelta(days=30)), limit=20)]
    # The warning counts every failure in the window, not just the 20 shown:
    # on a busy server an older failure must not drop out of sight.
    failed, last_failed, last_sent = db.admin_notice_summary(_iso(now - timedelta(days=NOTICE_DAYS)))
    out = {"recipient": mask_email(recipient) if recipient else None, "sender": os.getenv("ACS_SENDER_ADDRESS") or None,
           "recent": recent, "days": NOTICE_DAYS, "failed": failed, "last_failed": _event(last_failed) if last_failed else None,
           "last_sent": _event(last_sent) if last_sent else None}
    if test_id:
        found = [_event(e) for e in db.list_events(types=["admin.notified"], since=_iso(now - timedelta(days=1)), limit=200)]
        out["test"] = next((e for e in found if (e["detail"] or {}).get("test_id") == test_id), None)
    return out


@router.post("/notifications/test", status_code=202)
def test_notification(request: Request, admin=Depends(require_admin)) -> dict:
    """Sends a sample "new account awaiting review" to the configured
    address. 202 once the email service accepted it; poll GET
    /admin/notifications?test_id=... for sent or failed."""
    result = demo_access.send_test_notification()
    activity.record("admin.notification_test", request=request, user=admin, detail={"test_id": result["test_id"]})
    if result["failed"]:
        raise HTTPException(status_code=502, detail=result["failed"])
    recipient = demo_access.admin_recipient()
    return {"test_id": result["test_id"], "state": "accepted", "recipient": mask_email(recipient) if recipient else None}


# --------------------------------------------------------------------------- #
# Website traffic (Cloudflare Web Analytics)
# --------------------------------------------------------------------------- #

@router.get("/traffic")
def site_traffic(days: int = 14) -> dict:
    try:
        return traffic.report(days)
    except traffic.TrafficUnavailable as exc:
        # Shown on the page as the reason, and logged: never an empty chart.
        logger.warning("admin_traffic_unavailable", error=str(exc))
        raise HTTPException(status_code=502, detail=str(exc)) from None


# --------------------------------------------------------------------------- #
# Usage limits (editable; saved settings take precedence over the environment)
# --------------------------------------------------------------------------- #

class Limits(BaseModel):
    enabled: bool
    uploads: int = Field(ge=0, le=10_000)
    questions: int = Field(ge=0, le=100_000)
    period: Literal["total", "daily"]
    daily_uploads: int = Field(ge=0, le=1_000_000)
    daily_questions: int = Field(ge=0, le=1_000_000)
    max_upload_mb: int = Field(ge=1, le=max(1, MAX_SAMPLE_BYTES // (1024 * 1024)))
    max_pages: int = Field(ge=1, le=5_000)


@router.get("/limits")
def get_limits() -> dict:
    saved = db.get_setting(usage.SETTING_KEY)
    return {"limits": usage.settings(), "defaults": usage.defaults(), "saved": saved is not None,
            "max_upload_mb_cap": MAX_SAMPLE_BYTES // (1024 * 1024)}


@router.put("/limits")
def put_limits(body: Limits, request: Request, admin=Depends(require_admin)) -> dict:
    before = usage.settings()
    after = usage.save_settings(body.model_dump())
    changed = {k: [before.get(k), v] for k, v in after.items() if before.get(k) != v}
    activity.record("admin.limits_changed", request=request, user=admin, detail={k: f"{a} → {b}" for k, (a, b) in changed.items()} or None)
    return {"limits": after, "defaults": usage.defaults(), "saved": True, "max_upload_mb_cap": MAX_SAMPLE_BYTES // (1024 * 1024)}


# --------------------------------------------------------------------------- #
# Uptime (UptimeRobot; production only)
# --------------------------------------------------------------------------- #

@router.get("/uptime")
def uptime_report() -> dict:
    try:
        return uptime.report()
    except uptime.UptimeUnavailable as exc:
        logger.warning("admin_uptime_unavailable", error=str(exc))
        raise HTTPException(status_code=502, detail=str(exc)) from None


@router.post("/uptime/check")
def uptime_check(request: Request, admin=Depends(require_admin)) -> dict:
    """On-demand check: this request reaching the API is the API check; the
    website is fetched from here."""
    site = uptime.check_site()
    activity.record("admin.uptime_check", request=request, user=admin, detail={"website_ok": site["ok"], "website_ms": site["ms"]})
    return {"checked_at": datetime.now(timezone.utc).isoformat(), "api": {"ok": True, "started_at": _iso(activity.STARTED_AT),
            "uptime_seconds": activity.uptime_seconds()}, "website": site}


# --------------------------------------------------------------------------- #
# Database and server
# --------------------------------------------------------------------------- #

def _tree_size(path: Path) -> tuple[int, int]:
    total = files = 0
    for root, _dirs, names in os.walk(path):
        for name in names:
            try:
                total += os.path.getsize(os.path.join(root, name))
                files += 1
            except OSError:
                pass
    return total, files


def _storage_areas(data_dir: Path) -> dict:
    areas = {}
    if data_dir.exists():
        for child in sorted(data_dir.iterdir()):
            if child.is_dir():
                size, files = _tree_size(child)
                areas[child.name] = {"bytes": size, "files": files}
    return areas


# Walking every file on the share takes most of a second and the totals move
# slowly: kept 5 minutes, then refreshed in the background (an hour at most).
storage_walk = Refreshing("storage_walk", fresh_s=300, stale_s=3600)


@router.get("/database")
def database(request: Request) -> dict:
    data_dir = db.DB_PATH.parent
    stat = db.DB_PATH.stat() if db.DB_PATH.exists() else None
    areas, walked = storage_walk.get(str(data_dir), lambda: _storage_areas(data_dir))
    disk = None
    try:
        du = shutil.disk_usage(data_dir if data_dir.exists() else ".")
        disk = {"total_bytes": du.total, "used_bytes": du.used, "free_bytes": du.free}
    except OSError:
        pass
    vectors = None
    service = getattr(request.app.state, "rag_service", None)
    if service is not None:
        name = service.settings.qdrant_collection
        try:
            info = service.qdrant.get_collection(name)
            vectors = {"collection": name, "status": str(info.status), "points": info.points_count,
                       "indexed": info.indexed_vectors_count, "segments": info.segments_count}
        except Exception as exc:  # noqa: BLE001
            # Qdrant down or unreachable is exactly what this page must show,
            # so it is reported (and logged) rather than failing the whole page.
            logger.exception("admin_vectors_unavailable", collection=name)
            vectors = {"collection": name, "status": "error", "error": f"{type(exc).__name__}: {exc}"[:300]}
    return {
        "environment": _environment(),
        "database": {"engine": "SQLite", "path": str(db.DB_PATH), "bytes": stat.st_size if stat else 0,
                     "modified_at": _iso(datetime.fromtimestamp(stat.st_mtime, timezone.utc)) if stat else None,
                     "tables": db.table_counts()},
        "storage": {"areas": areas, "disk": disk, "measured_at": walked["computed_at"],
                    "refresh_error": walked["refresh_error"]},
        "vectors": vectors,
    }


@router.get("/server")
def server(request: Request) -> dict:
    now = datetime.now(timezone.utc)
    monitor = getattr(request.app.state, "dependency_monitor", None)
    snap = monitor.snapshot() if monitor is not None else {"readiness": "unknown", "dependencies": {}}
    starts = [_event(e) for e in db.list_events(types=["server.start"], since=_iso(now - timedelta(days=7)), limit=500)]
    startup_ms = [s["detail"]["startup_ms"] for s in starts if s.get("detail") and s["detail"].get("startup_ms") is not None]
    since_day = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    errors_24h = sum(r["errors"] for r in db.api_requests_since(since_day)) + sum(e for _n, e in activity.requests_counter.unflushed().values())
    rss_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "environment": _environment(),
        "status": "up",
        "readiness": snap.get("readiness"),
        "dependencies": snap.get("dependencies"),
        "started_at": _iso(activity.STARTED_AT),
        "uptime_seconds": activity.uptime_seconds(),
        "version": os.getenv("IMAGE_VERSION") or os.getenv("GIT_SHA", "unknown"),
        "commit": os.getenv("DEPLOYED_COMMIT", "unknown"),
        "revision": os.getenv("CONTAINER_APP_REVISION"),
        "replica": os.getenv("CONTAINER_APP_REPLICA_NAME"),
        "warm": bool(getattr(request.app.state, "warm", False)),
        "cold_starts_7d": len(starts),
        "cold_starts_24h": sum(1 for s in starts if s["at"] >= _iso(now - timedelta(days=1))),
        "average_startup_ms": round(sum(startup_ms) / len(startup_ms)) if startup_ms else None,
        "requests_since_start": activity.requests_counter.totals(),
        "errors_24h": errors_24h,
        "country_lookup": activity.country_lookup_status(),
        "python": platform.python_version(),
        "memory_peak_mb": round(rss_kb / 1024, 1) if platform.system() == "Linux" else round(rss_kb / 1024 / 1024, 1),
    }


# --------------------------------------------------------------------------- #
# Sample documents (managed here; offered to everyone in Upload)
# --------------------------------------------------------------------------- #

def sample_kind(filename: str) -> str | None:
    return SAMPLE_KINDS.get(Path(filename).suffix.lower())


def _sample_out(row) -> dict:
    out = dict(row)
    out.pop("path", None)
    return out


@router.get("/samples")
def admin_samples() -> dict:
    return {"items": [_sample_out(r) for r in db.list_samples()]}


@router.post("/samples", status_code=201)
def add_sample(request: Request, file: UploadFile = File(...), name: str | None = Form(None, max_length=120),
               admin=Depends(require_admin)) -> dict:
    filename = Path(file.filename or "").name
    kind = sample_kind(filename)
    if not kind:
        raise HTTPException(status_code=400, detail="Samples can be PDF, Word, PowerPoint or Excel files.")
    if file.size is not None and file.size > MAX_SAMPLE_BYTES:
        raise HTTPException(status_code=413, detail="This file is too large.")
    sample_id = db._new_id()
    folder = SAMPLES_DIR / sample_id
    folder.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^\w.\- ()]+", "_", filename)[:150] or f"sample{Path(filename).suffix}"
    target = folder / safe
    digest, size = hashlib.sha256(), 0
    try:
        with target.open("wb") as out:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_SAMPLE_BYTES:
                    raise HTTPException(status_code=413, detail="This file is too large.")
                digest.update(chunk)
                out.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="The file is empty.")
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    display = (name or Path(filename).stem).strip()[:120] or Path(filename).stem
    db.create_sample(display, safe, kind, size, digest.hexdigest(), str(target), sample_id=sample_id)
    activity.record("admin.sample_added", request=request, user=admin, detail={"kind": kind, "bytes": size})
    return _sample_out(db.get_sample(sample_id))


class SampleRename(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@router.post("/samples/{sample_id}/rename")
def rename_sample(sample_id: str, body: SampleRename) -> dict:
    if not db.rename_sample(sample_id, body.name.strip()):
        raise HTTPException(status_code=404, detail="Sample not found.")
    return _sample_out(db.get_sample(sample_id))


@router.post("/samples/{sample_id}/delete")
def delete_sample(sample_id: str, request: Request, admin=Depends(require_admin)) -> dict:
    row = db.delete_sample(sample_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Sample not found.")
    shutil.rmtree(Path(row["path"]).parent, ignore_errors=True)
    activity.record("admin.sample_deleted", request=request, user=admin, detail={"kind": row["kind"]})
    return {"id": sample_id, "deleted": True}


def spool_sample(sample_id: str) -> tuple[str, str]:
    """Copies a sample to a local temp file for the normal upload path.
    Returns (spool path, filename)."""
    row = db.get_sample(sample_id)
    if row is None or not Path(row["path"]).exists():
        raise HTTPException(status_code=404, detail="Sample not found.")
    spool = tempfile.NamedTemporaryFile(prefix="citely-sample-", delete=False)
    with spool, open(row["path"], "rb") as src:
        shutil.copyfileobj(src, spool, length=1024 * 1024)
    return spool.name, row["filename"]
