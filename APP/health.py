"""Dependency readiness, checked off the request path.

/health used to call Qdrant and make a real chat completion inline. The
endpoint was a coroutine, so that blocking work ran on the event loop of the
single uvicorn process and froze every other request — sign-in included — for
the 2-3 seconds a completion takes, once per cache TTL.

Now a daemon thread probes each dependency on an interval and records the
outcome with a timestamp. Requests only read the cached snapshot, so liveness
(/health) and readiness (/ready) answer instantly no matter how slow a
dependency is.

States are explicit rather than optimistic:
  starting  no probe has completed yet (fresh process)
  up / down the last probe's outcome
  unknown   the last result is older than STALE_FACTOR x interval — the probe
            itself is hanging or the thread died, so the old answer can't be
            trusted either way
"""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as ProbeTimeout
from datetime import datetime, timezone
from time import monotonic
from typing import Any, Callable

logger = logging.getLogger("rag_api.health")

DEPENDENCIES = ("qdrant", "openai")
STALE_FACTOR = 2.0
# A probe that has not answered within this long counts as "down". Without it
# a hung chat completion (the client's own timeout is 10 minutes) kept every
# dependency "starting", and /ready said not-ready for as long as it hung.
PROBE_TIMEOUT_SECONDS = 10.0


def _probe_qdrant(service: Any) -> bool:
    service.qdrant.get_collections()
    return True


def _probe_openai(service: Any) -> bool:
    return bool(service.chat_provider.is_healthy())


_PROBES: dict[str, Callable[[Any], bool]] = {"qdrant": _probe_qdrant, "openai": _probe_openai}


class DependencyMonitor:
    def __init__(self, interval_seconds: float, probes: dict[str, Callable[[Any], bool]] | None = None,
                 probe_timeout: float = PROBE_TIMEOUT_SECONDS):
        self.interval = max(1.0, float(interval_seconds))
        self.probe_timeout = probe_timeout
        self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="dependency-probe")
        self._probes = probes or _PROBES
        self._lock = threading.Lock()
        self._results: dict[str, dict[str, Any]] = {
            name: {"state": "starting", "checked_at": None, "checked_mono": None} for name in self._probes
        }
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def check_once(self, service: Any) -> None:
        for name, probe in self._probes.items():
            try:
                state = "up" if self._pool.submit(probe, service).result(timeout=self.probe_timeout) else "down"
            except ProbeTimeout:
                logger.warning("dependency_probe_timed_out", extra={"dependency": name})
                state = "down"
            except Exception:  # noqa: BLE001 — any failure means the dependency is unusable
                logger.warning("dependency_probe_failed", extra={"dependency": name}, exc_info=True)
                state = "down"
            with self._lock:
                self._results[name] = {
                    "state": state,
                    "checked_at": datetime.now(timezone.utc).isoformat(),
                    "checked_mono": monotonic(),
                }

    def start(self, service_getter: Callable[[], Any]) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()

        def _loop() -> None:
            while not self._stop.is_set():
                try:
                    self.check_once(service_getter())
                except Exception:  # noqa: BLE001 — never let the monitor thread die
                    logger.exception("dependency_monitor_iteration_failed")
                self._stop.wait(self.interval)

        self._thread = threading.Thread(target=_loop, name="dependency-monitor", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def snapshot(self) -> dict[str, Any]:
        now = monotonic()
        dependencies: dict[str, dict[str, Any]] = {}
        with self._lock:
            results = {name: dict(r) for name, r in self._results.items()}
        for name, r in results.items():
            age = None if r["checked_mono"] is None else round(now - r["checked_mono"], 1)
            state = r["state"]
            if age is not None and age > self.interval * STALE_FACTOR:
                state = "unknown"
            dependencies[name] = {"state": state, "checked_at": r["checked_at"], "age_s": age}

        states = [d["state"] for d in dependencies.values()]
        if all(s == "up" for s in states):
            readiness = "ready"
        elif any(s == "down" for s in states):
            readiness = "degraded"
        else:
            readiness = "starting"
        return {"readiness": readiness, "dependencies": dependencies}
