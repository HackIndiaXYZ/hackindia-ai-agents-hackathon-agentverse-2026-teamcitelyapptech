"""Production uptime on the admin console, read from UptimeRobot with a
read-only key, plus the console's on-demand check. UptimeRobot and the
website are stubbed; the shaping and failure reporting are real."""

import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

from APP import uptime
from tests.test_admin import ADMIN, Base

NOW = datetime.now(timezone.utc)


def monitor(**kw):
    created = NOW - timedelta(days=3)
    m = {"id": 1, "friendly_name": "Citely website (prod)", "url": "https://citely.example/", "interval": 3600, "status": 2,
         "create_datetime": int(created.timestamp()) + 19800,               # account timezone (+5:30), as UptimeRobot sends it
         "custom_uptime_ratio": "99.500-99.900", "custom_uptime_ranges": "-".join(["100.000"] * 29 + ["98.000"]),
         "logs": [{"type": 98, "datetime": int(created.timestamp()), "duration": 0},
                  {"type": 1, "datetime": int((NOW - timedelta(hours=5)).timestamp()), "duration": 420, "reason": {"code": "522", "detail": "Connection Timeout"}},
                  {"type": 2, "datetime": int((NOW - timedelta(hours=5) + timedelta(seconds=420)).timestamp()), "duration": 0}],
         "response_times": [{"datetime": int((NOW - timedelta(minutes=12)).timestamp()), "value": 87}]}
    m.update(kw)
    return m


def ur_answer(monitors, stat="ok"):
    return Mock(status_code=200, json=Mock(return_value={"stat": stat, "monitors": monitors} if stat == "ok" else {"stat": "fail", "error": {"message": "api_key is invalid"}}))


class UptimeTest(Base):
    def setUp(self):
        super().setUp()
        uptime._cache = None
        p = patch.dict(os.environ, {"UPTIMEROBOT_READONLY_KEY": "ur-read-only-test"})
        p.start()
        self.addCleanup(p.stop)
        self.admin = self.user(ADMIN)

    def get(self):
        return self.client.get("/admin/uptime", headers=self.headers(self.admin))

    def test_reports_each_check_with_daily_history_and_problems(self):
        api = monitor(id=2, friendly_name="Citely API (prod)", url="https://rag-api.example/health", interval=86400, status=9, logs=[], response_times=[])
        with patch("httpx.post", return_value=ur_answer([api, monitor()])) as post:
            body = self.get().json()
        sent = post.call_args.kwargs["data"]
        self.assertEqual(sent["api_key"], "ur-read-only-test")
        self.assertEqual(len(sent["custom_uptime_ranges"].split("-")), 30)
        site, api_ = body["monitors"]                                           # website first
        self.assertEqual((site["kind"], site["status"], site["interval_s"]), ("website", "up", 3600))
        self.assertEqual((site["uptime_7d"], site["uptime_30d"]), (99.5, 99.9))
        self.assertEqual(site["last_response_ms"], 87)
        self.assertEqual(site["incidents"], [{"started_at": site["incidents"][0]["started_at"], "duration_s": 420, "reason": "Connection Timeout"}])
        with_data = [d for d in site["daily"] if d["uptime"] is not None]
        self.assertEqual(len(site["daily"]), 30)
        self.assertGreaterEqual(len(with_data), 4)                               # the creation day counts, despite the timezone shift
        self.assertLessEqual(len(with_data), 5)
        self.assertEqual(site["daily"][0]["uptime"], None)                      # before the check existed: no data, not "100%"
        self.assertEqual(site["daily"][-1]["uptime"], 98.0)
        self.assertEqual((api_["kind"], api_["status"], api_["last_check_at"]), ("api", "down", None))

    def test_answers_are_kept_briefly(self):
        with patch("httpx.post", return_value=ur_answer([monitor()])) as post:
            self.get(); self.get()
        self.assertEqual(post.call_count, 1)

    def test_a_refusal_is_shown_not_hidden(self):
        with patch("httpx.post", return_value=ur_answer([], stat="fail")):
            response = self.get()
        self.assertEqual(response.status_code, 502)
        self.assertIn("api_key is invalid", response.json()["detail"])

    def test_environments_without_the_key_say_so(self):
        with patch.dict(os.environ, {"UPTIMEROBOT_READONLY_KEY": ""}), patch("httpx.post") as post:
            self.assertEqual(self.get().json(), {"configured": False, "monitors": []})
        post.assert_not_called()

    def test_check_now_fetches_the_website_and_records_it(self):
        with patch("httpx.get", return_value=Mock(status_code=200)) as fetch:
            body = self.client.post("/admin/uptime/check", headers=self.headers(self.admin)).json()
        self.assertEqual(fetch.call_args.args[0], "https://citely.example/")
        self.assertTrue(body["api"]["ok"])
        self.assertEqual((body["website"]["ok"], body["website"]["status_code"]), (True, 200))
        self.assertEqual(self.events("admin.uptime_check")[0]["email"], ADMIN)

    def test_check_now_reports_a_website_failure(self):
        import httpx
        with patch("httpx.get", side_effect=httpx.ConnectError("no route")):
            site = self.client.post("/admin/uptime/check", headers=self.headers(self.admin)).json()["website"]
        self.assertFalse(site["ok"])
        self.assertIn("ConnectError", site["error"])
        with patch("httpx.get", return_value=Mock(status_code=503)):
            site = self.client.post("/admin/uptime/check", headers=self.headers(self.admin)).json()["website"]
        self.assertEqual((site["ok"], site["error"]), (False, "HTTP 503"))

    def test_members_cannot_see_or_run_it(self):
        member = self.user("member@example.org")
        self.assertEqual(self.client.get("/admin/uptime", headers=self.headers(member)).status_code, 403)
        self.assertEqual(self.client.post("/admin/uptime/check", headers=self.headers(member)).status_code, 403)


if __name__ == "__main__":
    unittest.main()
