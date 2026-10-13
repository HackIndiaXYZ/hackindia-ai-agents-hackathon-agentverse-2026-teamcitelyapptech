"""Request handling must not stall behind slow work.

These pin the fixes for intermittent sign-in and workspace failures: blocking
work inside coroutine endpoints froze the single uvicorn process, /health made a
real chat completion inline, and every upload got its own unbounded thread.
"""

import asyncio
import threading
import time
import unittest
from unittest import mock

import httpx
from fastapi.testclient import TestClient

from APP import db, jobs
from APP import main as main_module
from APP.auth import get_current_user
from APP.health import DependencyMonitor
from APP.main import app


class _Service:
    """Just enough of RAGService for the health probes."""

    def __init__(self, qdrant_ok=True, chat_ok=True, delay=0.0):
        self.qdrant = mock.Mock()
        if not qdrant_ok:
            self.qdrant.get_collections.side_effect = RuntimeError("qdrant down")
        self.chat_provider = mock.Mock()
        self.chat_provider.is_healthy.side_effect = lambda: (time.sleep(delay), chat_ok)[1]
        self.settings = mock.Mock(qdrant_collection="test_collection")


class DependencyMonitorTests(unittest.TestCase):
    def test_starts_in_starting_state_never_optimistic(self):
        snap = DependencyMonitor(60).snapshot()
        self.assertEqual(snap["readiness"], "starting")
        self.assertTrue(all(d["state"] == "starting" for d in snap["dependencies"].values()))
        self.assertTrue(all(d["checked_at"] is None for d in snap["dependencies"].values()))

    def test_all_up_is_ready_with_freshness(self):
        m = DependencyMonitor(60)
        m.check_once(_Service())
        snap = m.snapshot()
        self.assertEqual(snap["readiness"], "ready")
        for d in snap["dependencies"].values():
            self.assertEqual(d["state"], "up")
            self.assertIsNotNone(d["checked_at"])
            self.assertLess(d["age_s"], 5)

    def test_any_down_is_degraded(self):
        m = DependencyMonitor(60)
        m.check_once(_Service(qdrant_ok=False))
        snap = m.snapshot()
        self.assertEqual(snap["readiness"], "degraded")
        self.assertEqual(snap["dependencies"]["qdrant"]["state"], "down")
        self.assertEqual(snap["dependencies"]["openai"]["state"], "up")

    def test_a_hanging_probe_is_down_within_the_timeout(self):
        hang = threading.Event()
        m = DependencyMonitor(60, probes={"qdrant": lambda s: True, "openai": lambda s: hang.wait(30)}, probe_timeout=0.3)
        started = time.monotonic()
        m.check_once(object())
        hang.set()
        self.assertLess(time.monotonic() - started, 2.0)
        snap = m.snapshot()
        self.assertEqual(snap["dependencies"]["openai"]["state"], "down")
        self.assertEqual(snap["dependencies"]["qdrant"]["state"], "up")

    def test_stale_result_degrades_to_unknown(self):
        m = DependencyMonitor(1)
        m.check_once(_Service())
        with mock.patch("APP.health.monotonic", return_value=time.monotonic() + 10):
            snap = m.snapshot()
        self.assertEqual(snap["readiness"], "starting")
        self.assertTrue(all(d["state"] == "unknown" for d in snap["dependencies"].values()))

    def test_background_thread_probes_and_stops(self):
        m = DependencyMonitor(1)
        m.start(lambda: _Service())
        deadline = time.monotonic() + 3
        while m.snapshot()["readiness"] != "ready" and time.monotonic() < deadline:
            time.sleep(0.05)
        m.stop()
        self.assertEqual(m.snapshot()["readiness"], "ready")


class HealthEndpointTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: getattr(app.state, k, None) for k in ("rag_service", "dependency_monitor")}
        app.state.rag_service = _Service()
        self.client = TestClient(app)

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(app.state, k, v)

    def test_health_is_live_while_dependencies_are_starting(self):
        app.state.dependency_monitor = DependencyMonitor(60)
        r = self.client.get("/health")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["readiness"], "starting")
        self.assertFalse(body["ready"])

    def test_health_reports_the_build_it_is_running(self):
        # Lets a deploy prove the new revision, not the previous one, answers.
        app.state.dependency_monitor = DependencyMonitor(60)
        with mock.patch.dict("os.environ", {"IMAGE_VERSION": "content-abc", "DEPLOYED_COMMIT": "f00d"}):
            body = self.client.get("/health").json()
        self.assertEqual((body["version"], body["commit"]), ("content-abc", "f00d"))
        with mock.patch.dict("os.environ", {"IMAGE_VERSION": "", "GIT_SHA": "abc123"}):
            self.assertEqual(self.client.get("/health").json()["version"], "abc123")   # images built before the change

    def test_ready_is_503_until_dependencies_are_up(self):
        m = DependencyMonitor(60)
        app.state.dependency_monitor = m
        self.assertEqual(self.client.get("/ready").status_code, 503)
        m.check_once(_Service())
        r = self.client.get("/ready")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["ready"])

    def test_ready_is_503_when_degraded_with_reason(self):
        m = DependencyMonitor(60)
        m.check_once(_Service(chat_ok=False))
        app.state.dependency_monitor = m
        r = self.client.get("/ready")
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["dependencies"]["openai"]["state"], "down")

    def test_health_never_calls_a_dependency(self):
        service = _Service(delay=5)  # a probe that would take 5 s
        app.state.rag_service = service
        app.state.dependency_monitor = DependencyMonitor(60)
        started = time.monotonic()
        self.assertEqual(self.client.get("/health").status_code, 200)
        self.assertLess(time.monotonic() - started, 1.0)
        service.chat_provider.is_healthy.assert_not_called()
        service.qdrant.get_collections.assert_not_called()


class EventLoopIsNotBlockedTests(unittest.IsolatedAsyncioTestCase):
    """A slow handler must not delay an unrelated request in the same process."""

    async def asyncSetUp(self):
        self._saved = {k: getattr(app.state, k, None) for k in ("rag_service", "dependency_monitor")}
        app.state.rag_service = _Service()
        app.state.dependency_monitor = DependencyMonitor(60)
        app.dependency_overrides[get_current_user] = lambda: {"id": "owner-1"}

    async def asyncTearDown(self):
        app.dependency_overrides.clear()
        for k, v in self._saved.items():
            setattr(app.state, k, v)

    async def test_slow_state_read_does_not_stall_health(self):
        entered = threading.Event()

        def slow_read(owner_id, key):
            entered.set()
            time.sleep(1.5)          # stands in for SQLite on a slow SMB mount
            return None, 0

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            with mock.patch.object(db, "read_state", side_effect=slow_read):
                # Timed from BEFORE the slow request starts. If the handler blocks
                # the event loop, this test's own coroutine is frozen too, so the
                # only honest clock is one that started before the block.
                t0 = time.monotonic()
                slow = asyncio.create_task(client.get("/state/catalog"))
                while not entered.is_set():           # slow handler is now running
                    await asyncio.sleep(0.005)
                fast = await client.get("/health")
                fast_elapsed = time.monotonic() - t0
                slow_response = await slow

        self.assertEqual(fast.status_code, 200)
        self.assertEqual(slow_response.status_code, 200)
        # A blocking handler on the loop makes this >= 1.5 s.
        self.assertLess(fast_elapsed, 0.75, f"/health completed {fast_elapsed:.2f}s after a slow handler began")


class BoundedIngestTests(unittest.TestCase):
    def test_at_most_concurrency_ingests_run_at_once(self):
        running, peak, lock = 0, 0, threading.Lock()
        release = threading.Event()

        def work():
            nonlocal running, peak
            with lock:
                running += 1
                peak = max(peak, running)
            release.wait(5)
            with lock:
                running -= 1

        futures = [main_module._ingest_pool.submit(work) for _ in range(main_module.INGEST_CONCURRENCY + 3)]
        time.sleep(0.3)
        with lock:
            in_flight = running
        release.set()
        for f in futures:
            f.result(5)
        self.assertEqual(in_flight, main_module.INGEST_CONCURRENCY)
        self.assertEqual(peak, main_module.INGEST_CONCURRENCY)

    def test_queued_jobs_stay_queued_until_a_worker_starts_them(self):
        job = jobs.job_store.create("owner-q", "x.pdf")
        self.assertEqual(job.status, jobs.QUEUED)


if __name__ == "__main__":
    unittest.main()
