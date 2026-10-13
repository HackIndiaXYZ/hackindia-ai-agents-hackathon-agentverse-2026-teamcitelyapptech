"""Online status in the admin console: only the workspace's presence signals
count, per tab, with a short online window, and every way of leaving (tab
hidden or closed, signed out here or everywhere, new password, suspended,
declined, deleted) takes effect at once."""

import time
import unittest
from unittest.mock import patch

from APP import auth, db, presence
from tests.test_admin import ADMIN, STRONG, Base

BROWSER, OTHER_BROWSER = "browser-aaaa", "browser-bbbb"


class PresenceApiTest(Base):
    def setUp(self):
        super().setUp()
        self.admin = self.user(ADMIN)
        self.member = self.user("member@example.org", password_hash=auth.hash_password(STRONG))
        self.seq = 0

    def signal(self, state, tab="tab-00001", browser=BROWSER, user=None, **extra):
        self.seq += 1
        body = {"state": state, "browser": browser, "seq": self.seq, **({"tab": tab} if tab else {}), **extra}
        return self.client.post("/me/presence", headers=self.headers(user or self.member), json=body)

    def row(self, email="member@example.org", status="members"):
        items = self.client.get(f"/admin/users?status={status}", headers=self.headers(self.admin)).json()["items"]
        return next(u for u in items if u["email"] == email)

    def state(self, email="member@example.org", status="members"):
        return self.row(email, status)["presence"]

    def online_now(self):
        return self.client.get("/admin/overview", headers=self.headers(self.admin)).json()["users"]["online_now"]

    # -- what counts -----------------------------------------------------------

    def test_ordinary_requests_never_count_as_presence(self):
        """Reading /me (the review page polls it), usage, the admin console's
        own calls: none of them is someone working in the workspace."""
        h = self.headers(self.member)
        self.client.get("/me", headers=h)
        self.client.get("/me/usage", headers=h)
        self.client.get("/admin/overview", headers=self.headers(self.admin))
        self.assertEqual(self.state(), "offline")
        self.assertIsNone(self.row()["last_seen_at"])
        self.assertEqual(self.state(ADMIN), "offline")              # the admin isn't "online" just for using the console
        self.assertEqual(self.online_now(), 0)

    def test_the_previous_releases_heartbeat_records_the_visit_but_not_presence(self):
        r = self.client.post("/me/heartbeat", headers=self.headers(self.member), json={"first": True})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(self.events("session.start")), 1)
        self.assertEqual(self.state(), "offline")

    def test_an_active_tab_is_online_and_sets_last_seen(self):
        self.assertEqual(self.signal("active").status_code, 204)
        row = self.row()
        self.assertEqual((row["presence"], row["online"]), ("online", True))
        self.assertIsNotNone(db.get_user_by_id(self.member["id"])["last_seen_at"])
        self.assertEqual(self.online_now(), 1)

    def test_online_ends_by_itself_when_the_signals_stop(self):
        """A killed browser, lost connection or sleeping laptop sends nothing
        more: offline once the 150-second window passes."""
        self.signal("active")
        later = time.time() + presence.ONLINE_SECONDS + 1
        with patch("APP.presence.time.time", return_value=later):
            self.assertEqual(self.state(), "offline")
            self.assertEqual(self.online_now(), 0)
        with patch("APP.presence.time.time", return_value=time.time() + presence.ONLINE_SECONDS - 5):
            self.assertEqual(self.state(), "online")

    # -- leaving and coming back ----------------------------------------------------

    def test_hiding_the_tab_is_away_and_coming_back_is_online(self):
        self.signal("active")
        self.signal("hidden")
        self.assertEqual(self.state(), "away")
        self.assertEqual(self.online_now(), 0)
        self.signal("active")
        self.assertEqual(self.state(), "online")

    def test_an_idle_tab_is_away(self):
        self.signal("active")
        self.signal("idle")
        self.assertEqual(self.state(), "away")

    def test_away_turns_into_last_seen_after_half_an_hour(self):
        self.signal("active")
        self.signal("hidden")
        with patch("APP.presence.time.time", return_value=time.time() + presence.AWAY_MINUTES * 60 + 1):
            self.assertEqual(self.state(), "offline")

    def test_closing_the_tab_is_offline_at_once(self):
        self.signal("active")
        self.signal("closed")
        self.assertEqual(self.state(), "offline")
        self.assertIsNotNone(self.row()["last_seen_at"])

    def test_a_late_active_signal_cannot_undo_leaving(self):
        """An "active" sent just before the tab was hidden, arriving after."""
        tab = {"browser": BROWSER, "tab": "tab-00001"}
        h = self.headers(self.member)
        self.client.post("/me/presence", headers=h, json={**tab, "state": "active", "seq": 1})
        self.client.post("/me/presence", headers=h, json={**tab, "state": "hidden", "seq": 3})
        self.client.post("/me/presence", headers=h, json={**tab, "state": "active", "seq": 2})   # late
        self.assertEqual(self.state(), "away")

    def test_one_tab_leaving_does_not_take_the_person_offline(self):
        self.signal("active", tab="tab-00001")
        self.signal("active", tab="tab-00002")
        self.signal("hidden", tab="tab-00001")
        self.assertEqual(self.state(), "online")
        self.signal("closed", tab="tab-00002")
        self.assertEqual(self.state(), "away")                       # tab 1 is still open, hidden
        self.signal("closed", tab="tab-00001")
        self.assertEqual(self.state(), "offline")

    # -- signing out --------------------------------------------------------------

    def test_signing_out_is_offline_at_once_and_stays_so(self):
        self.signal("active", tab="tab-00001")
        self.signal("hidden", tab="tab-00002")
        self.assertEqual(self.signal("signed_out", tab=None).status_code, 204)
        self.assertEqual(self.state(), "offline")
        self.signal("active", tab="tab-00001")                       # a request still in flight
        self.assertEqual(self.state(), "offline")

    def test_signing_out_in_one_browser_leaves_the_other_online(self):
        self.signal("active", tab="tab-00001", browser=BROWSER)
        self.signal("active", tab="tab-00002", browser=OTHER_BROWSER)
        self.signal("signed_out", tab="tab-00001", browser=BROWSER)
        self.assertEqual(self.state(), "online")
        self.signal("signed_out", tab=None, browser=OTHER_BROWSER)
        self.assertEqual(self.state(), "offline")

    def test_signing_out_from_a_tab_that_never_reported_blocks_its_late_signal(self):
        self.signal("signed_out", tab="tab-00009")
        self.signal("active", tab="tab-00009")
        self.assertEqual(self.state(), "offline")

    def test_sign_out_everywhere_is_offline_at_once(self):
        self.signal("active", tab="tab-00001", browser=BROWSER)
        self.signal("active", tab="tab-00002", browser=OTHER_BROWSER)
        self.client.post("/me/sign-out-everywhere", headers=self.headers(self.member))
        self.assertEqual(self.state(), "offline")
        # Every token is gone, so nothing can report for the old sessions.
        self.assertEqual(self.signal("active", tab="tab-00001").status_code, 401)

    def test_a_new_password_ends_presence(self):
        self.signal("active")
        token = auth.generate_reset_token()
        db.create_password_reset_token(self.member["id"], auth.hash_reset_token(token))
        r = self.client.post("/auth/reset-password", json={"email": "member@example.org", "token": token, "new_password": "Another-Harbor-81y"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.state(), "offline")

    # -- account status -------------------------------------------------------------

    def test_suspending_is_offline_at_once_and_blocks_every_signal(self):
        self.signal("active")
        r = self.client.post(f"/admin/users/{self.member['id']}/status", headers=self.headers(self.admin), json={"action": "suspend"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.state(), "offline")
        blocked = self.signal("active", tab="tab-00002")
        self.assertEqual((blocked.status_code, blocked.headers.get("X-Citely-Account")), (403, "suspended"))
        self.assertEqual(self.state(), "offline")

    def test_pending_and_declined_accounts_have_no_presence(self):
        pending = db.get_user_by_id(db.create_user("waiting@example.org", email_verified=True, status="pending"))
        declined = db.get_user_by_id(db.create_user("no@example.org", email_verified=True, status="declined"))
        for user in (pending, declined):
            r = self.signal("active", user=user)
            self.assertEqual(r.status_code, 403)                      # can't report presence at all
            self.client.get("/me", headers=self.headers(user))         # the review page polling
        self.assertIsNone(self.state("waiting@example.org", "pending"))
        self.assertIsNone(self.state("no@example.org", "declined"))
        self.assertFalse(self.row("waiting@example.org", "pending")["online"])
        self.assertIsNone(db.get_user_by_id(pending["id"])["last_seen_at"])
        self.assertEqual(self.online_now(), 0)

    def test_declining_an_approved_then_reverted_account_is_offline(self):
        """Declined (even with a tab somehow still reporting): never online."""
        self.signal("active")
        with db._connect() as conn:
            conn.execute("UPDATE users SET status = 'declined' WHERE id = ?", (self.member["id"],))
        self.assertIsNone(self.state(status="declined"))
        self.assertEqual(self.online_now(), 0)

    def test_deleting_the_account_forgets_its_presence(self):
        self.signal("active")
        r = self.client.post(f"/admin/users/{self.member['id']}/delete", headers=self.headers(self.admin), json={"confirm": "member@example.org"})
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(self.member["id"], presence.online_user_ids())

    def test_the_account_drawer_shows_the_same_presence(self):
        self.signal("active")
        self.signal("hidden")
        user = self.client.get(f"/admin/users/{self.member['id']}", headers=self.headers(self.admin)).json()["user"]
        self.assertEqual((user["presence"], user["online"]), ("away", False))
        self.assertIsNotNone(user["last_seen_at"])

    # -- input checks -----------------------------------------------------------------

    def test_bad_signals_are_refused(self):
        h = self.headers(self.member)
        for bad in ({"state": "online", "browser": BROWSER, "tab": "tab-00001"},
                    {"state": "active", "browser": "x", "tab": "tab-00001"},
                    {"state": "active", "browser": BROWSER, "tab": "bad id!"},
                    {"state": "active", "browser": BROWSER}):
            with self.subTest(bad):
                self.assertEqual(self.client.post("/me/presence", headers=h, json=bad).status_code, 422)
        self.assertEqual(self.client.post("/me/presence", json={"state": "active", "browser": BROWSER, "tab": "tab-00001"}).status_code, 401)


class PresenceUnitTest(unittest.TestCase):
    def setUp(self):
        presence.reset()
        patcher = patch("APP.presence.db.touch_last_seen")
        self.touch = patcher.start()
        self.addCleanup(patcher.stop)

    def test_last_seen_is_written_at_most_twice_a_minute_per_account(self):
        for i in range(4):
            presence.signal("u1", f"tab-{i:05d}", BROWSER, 1, "active", now=1000.0 + i)
        self.assertEqual(self.touch.call_count, 1)
        presence.signal("u1", "tab-00000", BROWSER, 2, "active", now=1000.0 + presence.LAST_SEEN_WRITE_SECONDS)
        self.assertEqual(self.touch.call_count, 2)

    def test_leaving_a_working_tab_records_when_they_left(self):
        presence.signal("u1", "tab-00001", BROWSER, 1, "active", now=1000.0)
        presence.signal("u1", "tab-00001", BROWSER, 2, "hidden", now=1040.0)
        self.assertEqual(presence.describe({"id": "u1", "status": "approved"}, now=1041.0)["last_seen_at"],
                         presence._iso(1040.0))

    def test_leaving_a_tab_that_had_already_gone_quiet_does_not_move_last_seen(self):
        presence.signal("u1", "tab-00001", BROWSER, 1, "active", now=1000.0)
        presence.signal("u1", "tab-00001", BROWSER, 2, "hidden", now=1000.0 + presence.ONLINE_SECONDS + 60)
        self.assertEqual(presence.describe({"id": "u1", "status": "approved"}, now=2000.0)["last_seen_at"],
                         presence._iso(1000.0))

    def test_tabs_per_account_are_bounded(self):
        for i in range(presence.MAX_TABS_PER_USER + 10):
            presence.signal("u1", f"tab-{i:05d}", BROWSER, 1, "active", now=1000.0 + i)
        self.assertEqual(len(presence._tabs["u1"]), presence.MAX_TABS_PER_USER)

    def test_suspended_accounts_are_never_online(self):
        presence.signal("u1", "tab-00001", BROWSER, 1, "active", now=1000.0)
        self.assertEqual(presence.describe({"id": "u1", "status": "suspended"}, now=1001.0)["presence"], "offline")
        self.assertEqual(presence.describe({"id": "u1", "status": "approved"}, now=1001.0)["presence"], "online")


if __name__ == "__main__":
    unittest.main()
