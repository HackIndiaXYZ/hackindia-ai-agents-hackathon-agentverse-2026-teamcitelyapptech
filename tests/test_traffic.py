"""Website traffic on the admin console, read from Cloudflare Web Analytics.
Cloudflare is stubbed; the query, the shaping and the failure reporting are real."""

import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

from APP import traffic
from tests.test_admin import ADMIN, Base

TODAY = datetime.now(timezone.utc).date()


def cf_answer(**groups):
    body = {"data": {"viewer": {"accounts": [{k: groups.get(k, []) for k in ("daily", "pages", "countries", "referrers", "devices", "browsers")}]}}}
    return Mock(status_code=200, json=Mock(return_value=body))


class TrafficTest(Base):
    def setUp(self):
        super().setUp()
        traffic._cache.clear()
        p = patch.dict(os.environ, {"CLOUDFLARE_ANALYTICS_TOKEN": "read-only-test", "CLOUDFLARE_ACCOUNT_ID": "acct123",
                                    "APP_PUBLIC_URL": "https://dev.citely.example/"})
        p.start()
        self.addCleanup(p.stop)
        self.admin = self.user(ADMIN)

    def get(self, days=14):
        return self.client.get(f"/admin/traffic?days={days}", headers=self.headers(self.admin))

    def test_reports_this_environments_site_day_by_day_with_top_lists(self):
        answer = cf_answer(
            daily=[{"count": 7, "sum": {"visits": 5}, "dimensions": {"date": TODAY.isoformat()}},
                   {"count": 3, "sum": {"visits": 2}, "dimensions": {"date": (TODAY - timedelta(days=3)).isoformat()}}],
            pages=[{"count": 6, "sum": {"visits": 4}, "dimensions": {"requestPath": "/"}}, {"count": 4, "sum": {"visits": 3}, "dimensions": {"requestPath": "/documentation/"}}],
            countries=[{"count": 10, "dimensions": {"countryName": "IN"}}],
            referrers=[{"count": 8, "dimensions": {"refererHost": ""}}, {"count": 2, "dimensions": {"refererHost": "www.google.com"}}],
            devices=[{"count": 10, "dimensions": {"deviceType": "mobile"}}])
        with patch("httpx.post", return_value=answer) as post:
            body = self.get().json()
        query = post.call_args.kwargs["json"]["query"]
        self.assertIn('requestHost: "dev.citely.example"', query)
        self.assertIn("bot: 0", query)
        self.assertIn('accountTag: "acct123"', query)
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer read-only-test")
        self.assertEqual(body["host"], "dev.citely.example")
        self.assertEqual(len(body["per_day"]), 14)
        self.assertEqual(body["per_day"][-1], {"day": TODAY.isoformat(), "views": 7, "visits": 5})
        self.assertEqual(body["per_day"][0]["views"], 0)                      # days without visits are zero, not missing
        self.assertEqual(body["totals"], {"views": 10, "visits": 7})
        self.assertEqual(body["pages"][0], {"name": "/", "views": 6, "share": 0.6})
        self.assertEqual(body["referrers"][0]["name"], "Direct (typed, bookmark or app)")
        self.assertEqual(body["devices"][0]["name"], "Mobile")

    def test_answers_are_kept_for_a_few_minutes(self):
        with patch("httpx.post", return_value=cf_answer()) as post:
            self.get(); self.get()
            self.assertEqual(post.call_count, 1)
            self.get(days=7)
            self.assertEqual(post.call_count, 2)

    def test_a_cloudflare_refusal_is_shown_not_hidden(self):
        refused = Mock(status_code=200, json=Mock(return_value={"data": None, "errors": [{"message": "not authorized for that account"}]}))
        with patch("httpx.post", return_value=refused):
            response = self.get()
        self.assertEqual(response.status_code, 502)
        self.assertIn("not authorized for that account", response.json()["detail"])

    def test_unreachable_cloudflare_is_reported(self):
        import httpx
        with patch("httpx.post", side_effect=httpx.ConnectTimeout("timed out")):
            response = self.get()
        self.assertEqual(response.status_code, 502)
        self.assertIn("Couldn't reach Cloudflare", response.json()["detail"])

    def test_without_a_token_it_says_what_is_missing(self):
        with patch.dict(os.environ, {"CLOUDFLARE_ANALYTICS_TOKEN": ""}), patch("httpx.post") as post:
            body = self.get().json()
        post.assert_not_called()
        self.assertFalse(body["configured"])
        self.assertEqual(body["missing"], ["CLOUDFLARE_ANALYTICS_TOKEN"])

    def test_prod_reads_the_main_address(self):
        with patch.dict(os.environ, {"APP_PUBLIC_URL": "https://citely.example/"}):
            self.assertEqual(traffic.site_host(), "citely.example")

    def test_members_cannot_see_it(self):
        member = self.user("member@example.org")
        self.assertEqual(self.client.get("/admin/traffic", headers=self.headers(member)).status_code, 403)


if __name__ == "__main__":
    unittest.main()
