"""What keeps the admin console quick: slow figures kept and refreshed in the
background (never hiding a failure), and preflights cached for two hours."""

import unittest
from unittest.mock import patch

from APP import admin
from APP.refreshing import Refreshing
from tests.test_admin import ADMIN, Base


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class RefreshingTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        p = patch("APP.refreshing.time.monotonic", self.clock)
        p.start()
        self.addCleanup(p.stop)
        self.jobs = []
        self.cache = Refreshing("test", fresh_s=60, stale_s=600, start=self.jobs.append)
        self.calls = 0

    def compute(self):
        self.calls += 1
        return self.calls

    def test_a_fresh_answer_is_served_without_working_it_out_again(self):
        self.assertEqual(self.cache.get("k", self.compute)[0], 1)
        self.clock.t += 30
        value, info = self.cache.get("k", self.compute)
        self.assertEqual((value, self.calls, info["age_s"], info["refresh_error"]), (1, 1, 30, None))
        self.assertTrue(info["computed_at"])

    def test_an_old_answer_is_served_at_once_and_refreshed_in_the_background(self):
        self.cache.get("k", self.compute)
        self.clock.t += 120
        self.assertEqual(self.cache.get("k", self.compute)[0], 1)          # no waiting
        self.assertEqual(self.cache.get("k", self.compute)[0], 1)
        self.assertEqual(len(self.jobs), 1)                                 # one refresh, however many callers
        self.jobs.pop()()
        value, info = self.cache.get("k", self.compute)
        self.assertEqual((value, info["age_s"]), (2, 0))

    def test_a_failed_refresh_keeps_the_old_answer_and_says_why(self):
        self.cache.get("k", self.compute)
        self.clock.t += 120
        self.cache.get("k", lambda: 1 / 0)
        with patch("APP.refreshing.logger") as log:
            self.jobs.pop()()
        log.warning.assert_called_once()
        value, info = self.cache.get("k", self.compute)
        self.assertEqual(value, 1)
        self.assertIn("ZeroDivisionError", info["refresh_error"])
        self.assertEqual(info["age_s"], 120)

    def test_too_old_or_missing_means_waiting_and_errors_reach_the_caller(self):
        with self.assertRaises(ZeroDivisionError):
            self.cache.get("k", lambda: 1 / 0)
        self.cache.get("k", self.compute)
        self.clock.t += 601
        self.assertEqual(self.cache.get("k", self.compute)[0], 2)          # worked out while the caller waits
        self.assertEqual(self.jobs, [])


class DatabaseSpeedTest(Base):
    def test_the_storage_walk_is_kept_and_its_age_shown(self):
        admin_user = self.user(ADMIN)
        (self.tmp / "data" / "originals").mkdir(parents=True)
        (self.tmp / "data" / "originals" / "a.pdf").write_bytes(b"x" * 100)
        with patch.object(admin, "_tree_size", wraps=admin._tree_size) as walk:
            first = self.client.get("/admin/database", headers=self.headers(admin_user)).json()
            calls = walk.call_count
            second = self.client.get("/admin/database", headers=self.headers(admin_user)).json()
            self.assertEqual(walk.call_count, calls)                         # not walked again
        self.assertEqual(first["storage"]["areas"]["originals"], {"bytes": 100, "files": 1})
        self.assertEqual(second["storage"]["areas"], first["storage"]["areas"])
        self.assertTrue(second["storage"]["measured_at"])
        self.assertIsNone(second["storage"]["refresh_error"])
        self.assertEqual(second["database"]["tables"]["users"], 1)         # the rest stays live


class PreflightTest(Base):
    def test_preflights_are_cached_for_two_hours(self):
        response = self.client.options("/admin/overview", headers={
            "Origin": "http://localhost:3000", "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["access-control-max-age"], "7200")


if __name__ == "__main__":
    unittest.main()
