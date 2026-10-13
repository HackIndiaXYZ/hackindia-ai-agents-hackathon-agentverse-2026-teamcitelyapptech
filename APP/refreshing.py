"""The last answer of a slow call, kept and refreshed in the background.

For admin figures that are slow to work out and change slowly (the storage
walk over the Azure Files share takes most of a second): an answer younger
than `fresh_s` is served as it is; an older one, up to `stale_s`, is served at
once while a background thread works out a new one; with nothing usable the
caller waits for the call. A background refresh that fails is logged and its
message is returned with the old answer, so the page shows both its age and
why it is old instead of hiding the failure.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

import structlog

logger = structlog.get_logger("rag_api.refreshing")


@dataclass
class _Entry:
    value: Any = None
    at: float | None = None            # time.monotonic() when worked out
    computed_at: str | None = None     # the same moment, for people
    error: str | None = None           # why the last background refresh failed
    refreshing: bool = False
    compute_lock: threading.Lock = field(default_factory=threading.Lock)


class Refreshing:
    def __init__(self, name: str, fresh_s: float, stale_s: float,
                 start: Callable[[Callable[[], None]], None] | None = None):
        self.name, self.fresh_s, self.stale_s = name, fresh_s, stale_s
        self._start = start or (lambda job: threading.Thread(target=job, name=f"refresh-{name}", daemon=True).start())
        self._entries: dict[Any, _Entry] = {}
        self._lock = threading.Lock()

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def _entry(self, key) -> _Entry:
        with self._lock:
            return self._entries.setdefault(key, _Entry())

    @staticmethod
    def _info(entry: _Entry) -> dict:
        return {"computed_at": entry.computed_at, "age_s": round(time.monotonic() - entry.at),
                "refresh_error": entry.error}

    def _store(self, entry: _Entry, value) -> None:
        with self._lock:
            entry.value, entry.at, entry.error = value, time.monotonic(), None
            entry.computed_at = datetime.now(timezone.utc).isoformat()

    def get(self, key, compute: Callable[[], Any]) -> tuple[Any, dict]:
        """(answer, {computed_at, age_s, refresh_error}). Errors from a call the
        caller waits for are raised to it."""
        entry = self._entry(key)
        with self._lock:
            age = None if entry.at is None else time.monotonic() - entry.at
            if age is not None and age < self.fresh_s:
                return entry.value, self._info(entry)
            if age is not None and age < self.stale_s:
                if not entry.refreshing:
                    entry.refreshing = True
                    self._start(lambda: self._refresh(key, entry, compute))
                return entry.value, self._info(entry)
        with entry.compute_lock:          # one call at a time; a second caller uses the first's answer
            if entry.at is not None and time.monotonic() - entry.at < self.fresh_s:
                return entry.value, self._info(entry)
            value = compute()
            self._store(entry, value)
            return value, self._info(entry)

    def _refresh(self, key, entry: _Entry, compute: Callable[[], Any]) -> None:
        try:
            with entry.compute_lock:
                value = compute()
            self._store(entry, value)
        except Exception as exc:  # noqa: BLE001 - reported with the old answer and logged
            message = f"{type(exc).__name__}: {exc}"[:300]
            logger.warning("background_refresh_failed", cache=self.name, key=str(key), error=message)
            with self._lock:
                entry.error = message
        finally:
            with self._lock:
                entry.refreshing = False
