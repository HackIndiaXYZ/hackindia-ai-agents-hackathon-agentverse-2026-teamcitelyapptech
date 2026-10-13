"""Activity for the admin console: an event log, per-day API traffic, and this
server's own lifetime.

Privacy: an event never stores an IP address, a document name, a question or
an answer. The visitor's address is looked up in an offline country database
(DB-IP Lite, CC BY 4.0: "IP Geolocation by DB-IP") and only the country code
is kept, with the timezone the browser reports.

Recording is best effort: a failed write is logged and never fails the
request that caused it.
"""

from __future__ import annotations

import os
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from functools import lru_cache

import structlog

from APP import access_control as ac
from APP import db

logger = structlog.get_logger("rag_api.activity")

GEO_DB = os.getenv("GEOIP_DB", "/opt/models/geo/dbip-country-lite.mmdb")
STARTED_AT = datetime.now(timezone.utc)
_STARTED_MONOTONIC = time.monotonic()


# --------------------------------------------------------------------------- #
# Country lookup
# --------------------------------------------------------------------------- #

@lru_cache(maxsize=1)
def _geo_reader():
    try:
        import maxminddb
        return maxminddb.open_database(GEO_DB)
    except Exception:  # missing file or library: countries are simply unknown
        return None


def country_lookup_status() -> dict:
    """Shown on the admin server page, so a missing database is visible."""
    reader = _geo_reader()
    if reader is not None:
        return {"loaded": True, "database": GEO_DB, "built": getattr(reader.metadata(), "build_epoch", None)}
    return {"loaded": False, "database": GEO_DB,
            "error": "Country database not found or unreadable; visitor countries are recorded as unknown."}


@lru_cache(maxsize=4096)
def country_of(ip: str | None) -> str | None:
    if not ip:
        return None
    reader = _geo_reader()
    if reader is None:
        return None
    try:
        found = reader.get(ip) or {}
        return (found.get("country") or {}).get("iso_code")
    except Exception:
        return None


def clean_timezone(value) -> str | None:
    """A browser-reported IANA name such as "Asia/Kolkata", or None."""
    if not isinstance(value, str):
        return None
    value = value.strip()[:64]
    return value if value and all(c.isalnum() or c in "/_-+" for c in value) else None


# --------------------------------------------------------------------------- #
# Events
# --------------------------------------------------------------------------- #

def record(type: str, *, request=None, user=None, email: str | None = None, timezone_name: str | None = None,
           detail: dict | None = None, country: str | None = None) -> None:
    try:
        if country is None and request is not None:
            country = country_of(ac.client_ip(request))
        db.record_event(
            type,
            user_id=user["id"] if user is not None else None,
            email=(user["email"] if user is not None else None) or email,
            country=country,
            timezone_name=clean_timezone(timezone_name),
            detail=detail,
        )
    except Exception:
        logger.exception("event_record_failed", type=type)


# --------------------------------------------------------------------------- #
# Request counts
# --------------------------------------------------------------------------- #

_BUCKETS = (
    ("/query", "questions"), ("/ingest", "uploads"), ("/samples", "uploads"), ("/auth", "auth"),
    ("/access", "auth"), ("/demo-requests", "demo"), ("/state", "workspace"), ("/conversations", "workspace"),
    ("/annotations", "workspace"), ("/documents", "documents"), ("/me", "account"), ("/admin", "admin"),
    ("/health", "health"), ("/ready", "health"), ("/warmup", "health"),
)


def bucket_of(path: str) -> str:
    for prefix, name in _BUCKETS:
        if path == prefix or path.startswith(prefix + "/") or path.startswith(prefix + "?"):
            return name
    return "other"


class RequestCounter:
    """Counts in memory; flush() adds the totals to the database. A flush
    that fails keeps its counts for the next one."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pending: Counter = Counter()
        self._errors: Counter = Counter()
        self._totals: Counter = Counter()      # this process's lifetime, for /admin/server
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def add(self, path: str, status_code: int) -> None:
        key = (datetime.now(timezone.utc).strftime("%Y-%m-%d"), bucket_of(path))
        with self._lock:
            self._pending[key] += 1
            self._totals["requests"] += 1
            if status_code >= 500:
                self._errors[key] += 1
                self._totals["errors"] += 1

    def unflushed(self) -> dict[tuple[str, str], tuple[int, int]]:
        with self._lock:
            return {k: (n, self._errors.get(k, 0)) for k, n in self._pending.items()}

    def totals(self) -> dict[str, int]:
        with self._lock:
            return {"requests": self._totals["requests"], "errors": self._totals["errors"]}

    def flush(self) -> None:
        with self._lock:
            rows = {k: (n, self._errors.get(k, 0)) for k, n in self._pending.items()}
            self._pending.clear()
            self._errors.clear()
        if not rows:
            return
        try:
            db.add_api_requests(rows)
        except Exception:
            logger.exception("request_count_flush_failed")
            with self._lock:   # keep them for the next flush
                for k, (n, e) in rows.items():
                    self._pending[k] += n
                    if e:
                        self._errors[k] += e

    def start(self, every_seconds: float = 60) -> None:
        if self._thread is not None:
            return
        self._stop.clear()

        def _loop() -> None:
            while not self._stop.wait(every_seconds):
                self.flush()

        self._thread = threading.Thread(target=_loop, name="request-counter", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None
        self.flush()


requests_counter = RequestCounter()


def uptime_seconds() -> int:
    return int(time.monotonic() - _STARTED_MONOTONIC)
