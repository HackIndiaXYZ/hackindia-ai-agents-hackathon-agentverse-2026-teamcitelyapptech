"""Admin notifications ("new account awaiting review", "new demo request" and
the admin console's test): every way an account starts pending notifies,
the message carries no stranger's address as Reply-To or in the subject, and
each outcome (sent or failed, with the reason) is recorded and shown in the
admin console.

Real sign-in tokens and the real email code down to the email service
client, which is a stub: the message handed to it is inspected, and its
confirmation is set per test.
"""

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

import APP.rag  # noqa: F401 — import order the app uses
from APP import activity, auth, db, presence
from APP.auth import email_templates as t
from APP.main import app, limiter

STRONG = "Velvet-Harbor-73x"
SECRET = "test-only-secret-key-not-for-production"
ADMIN = "admin@citely.example"


class Poller:
    def __init__(self, result=None, error=None):
        self._result, self._error = result, error

    def result(self, timeout=None):
        if self._error:
            raise self._error
        return self._result


SENT = {"id": "msg-1", "status": "Succeeded"}


class Base(unittest.TestCase):
    env: dict = {}

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.codes = {}
        self.service = Mock()
        self.service.begin_send.return_value = Poller(SENT)
        for p in (patch.object(db, "DB_PATH", Path(tmp.name) / "data" / "rag.db"),
                  patch.dict(os.environ, {"JWT_SECRET_KEY": SECRET, "CITELY_APPROVED_EMAILS": "", "CITELY_ADMIN_EMAILS": ADMIN,
                                          "TURNSTILE_SECRET_KEY": "", "QUOTA_ENABLED": "false", "CITELY_DEMO_RECIPIENT": ADMIN,
                                          "ACS_SENDER_ADDRESS": "hello@citely.test", "APP_PUBLIC_URL": "https://citely.example/",
                                          "ACCESS_MODE": "review", "LOGIN_EMAIL_CODE": "off", **self.env}),
                  patch("APP.access_control._domain_receives_mail", return_value=True),
                  patch("APP.main.otp_email.send_otp_email", side_effect=lambda to, code: self.codes.__setitem__(to, code)),
                  patch("APP.auth.email._get_client", return_value=self.service)):
            p.start()
            self.addCleanup(p.stop)
        db.init_db()
        limiter.reset()
        import APP.main as main_module
        main_module._otp_last_sent.clear()
        presence.reset()
        self.client = TestClient(app)

    def notices(self, count=1, timeout=5.0):
        """The admin.notified events, once `count` exist (the outcome is
        recorded by the background confirmation)."""
        deadline = time.monotonic() + timeout
        while True:
            found = [dict(e) for e in db.list_events(types=["admin.notified"], limit=50)]
            if len(found) >= count or time.monotonic() > deadline:
                import json
                for e in found:
                    e["detail"] = json.loads(e["detail"]) if e["detail"] else None
                return found
            time.sleep(0.02)

    def messages(self):
        return [c.args[0] for c in self.service.begin_send.call_args_list]

    def admin_headers(self):
        user = db.get_user_by_id(db.create_user(ADMIN, password_hash=auth.hash_password(STRONG), email_verified=True, status="approved"))
        return {"Authorization": "Bearer " + auth.create_access_token(user["id"], user["token_version"])}

    def sign_up(self, email):
        self.client.post("/auth/signup", json={"email": email, "password": STRONG})
        return self.client.post("/auth/verify-otp", json={"email": email, "code": self.codes[email]})


class EveryPendingAccountNotifiesTest(Base):
    def assert_clean_notice(self, message, about):
        self.assertEqual(message["recipients"]["to"], [{"address": ADMIN}])
        self.assertEqual(message["content"]["subject"], "New Citely account awaiting review")
        self.assertNotIn(about, message["content"]["subject"])
        # Replies go to the Citely inbox, as on every other Citely email; the
        # new account's address is never the Reply-To.
        self.assertEqual(message["replyTo"], [{"address": t.CONTACT_EMAIL}])
        self.assertIn(about, message["content"]["plainText"])
        self.assertIn("https://admin.citely.example/#prod/pending", message["content"]["html"])

    def test_an_email_sign_up_notifies_and_records_that_it_was_sent(self):
        self.assertEqual(self.sign_up("new.person@work.example").json()["status"], "pending")
        self.assert_clean_notice(self.messages()[-1], "new.person@work.example")
        [event] = self.notices()
        self.assertEqual(event["email"], "new.person@work.example")
        self.assertEqual(event["detail"], {"kind": "new account", "outcome": "sent", "message_id": "msg-1"})
        # Recorded once, as the notice's outcome: no generic "email.failed".
        self.assertEqual(db.list_events(types=["email.failed"], limit=5), [])

    def test_google_and_github_sign_ups_notify(self):
        for n, provider in enumerate(["google", "github"]):
            email = f"social{n}@work.example"
            with self.subTest(provider), patch(f"APP.main.auth.exchange_{provider}_code", return_value={"email": email, "provider_user_id": str(n)}):
                r = self.client.post(f"/auth/{provider}/callback", json={"code": "c", "redirect_uri": "https://citely.example/auth/callback/"})
                self.assertEqual(r.json()["status"], "pending")
                self.assert_clean_notice(self.messages()[-1], email)
        self.assertEqual({e["email"] for e in self.notices(2)}, {"social0@work.example", "social1@work.example"})

    def test_signing_in_again_does_not_notify_twice(self):
        with patch("APP.main.auth.exchange_google_code", return_value={"email": "again@work.example", "provider_user_id": "g"}):
            for _ in range(2):
                self.client.post("/auth/google/callback", json={"code": "c", "redirect_uri": "https://citely.example/auth/callback/"})
        self.assertEqual(len(self.notices(1)), 1)
        self.assertEqual(len(self.messages()), 1)

    def test_a_demo_request_notifies_without_the_visitors_address_as_reply_to(self):
        r = self.client.post("/demo-requests", json={"name": "Free money <b>now</b>", "email": "visitor@work.example",
                                                     "phone": "+91 98765 43210", "comment": "For our research group"})
        self.assertEqual(r.status_code, 202)
        message = self.messages()[-1]
        self.assertEqual(message["content"]["subject"], "New Citely demo request")     # no visitor text in the subject
        self.assertEqual(message["replyTo"], [{"address": t.CONTACT_EMAIL}])
        self.assertIn("visitor@work.example", message["content"]["plainText"])
        self.assertNotIn("<b>now</b>", message["content"]["html"])
        [event] = self.notices()
        self.assertEqual((event["email"], event["detail"]["kind"], event["detail"]["outcome"]), ("visitor@work.example", "demo request", "sent"))


class FailuresAreRecordedTest(Base):
    def test_a_send_the_service_fails_later_is_recorded_with_its_reason_and_shown(self):
        self.service.begin_send.return_value = Poller({"id": "msg-2", "status": "Failed", "error": {"code": "EmailDroppedAllRecipientsSuppressed"}})
        self.assertEqual(self.sign_up("new.person@work.example").status_code, 200)    # the sign-up itself is unaffected
        [event] = self.notices()
        self.assertEqual(event["detail"]["outcome"], "failed")
        self.assertIn("Suppressed", event["detail"]["reason"])
        self.assertEqual(event["detail"]["message_id"], "msg-2")
        body = self.client.get("/admin/notifications", headers=self.admin_headers()).json()
        self.assertEqual(body["failed"], 1)
        self.assertEqual(body["last_failed"]["email"], "new.person@work.example")
        self.assertIsNone(body["last_sent"])

    def test_a_confirmation_that_never_comes_is_a_failure(self):
        self.service.begin_send.return_value = Poller(error=TimeoutError("no answer"))
        self.sign_up("new.person@work.example")
        self.assertIn("TimeoutError", self.notices()[0]["detail"]["reason"])

    def test_a_refused_send_keeps_the_account_and_is_recorded(self):
        self.service.begin_send.side_effect = RuntimeError("sender not verified")
        r = self.sign_up("new.person@work.example")
        self.assertEqual((r.status_code, r.json()["status"]), (200, "pending"))
        [event] = self.notices()
        self.assertEqual(event["detail"]["outcome"], "failed")
        self.assertIn("Refused by the email service", event["detail"]["reason"])
        self.assertIn("sender not verified", event["detail"]["reason"])

    def test_a_refused_demo_request_says_so_and_is_recorded(self):
        self.service.begin_send.side_effect = RuntimeError("private secret")
        r = self.client.post("/demo-requests", json={"name": "A", "email": "visitor@work.example", "phone": "+91 98765 43210", "comment": "x"})
        self.assertEqual(r.status_code, 503)
        self.assertNotIn("private secret", r.text)
        self.assertEqual(self.notices()[0]["detail"]["outcome"], "failed")


class NoRecipientTest(Base):
    env = {"CITELY_DEMO_RECIPIENT": ""}

    def test_a_missing_address_is_a_recorded_failure_not_silence(self):
        self.assertEqual(self.sign_up("new.person@work.example").json()["status"], "pending")
        [event] = self.notices()
        self.assertEqual(event["detail"]["outcome"], "failed")
        self.assertIn("CITELY_DEMO_RECIPIENT", event["detail"]["reason"])
        self.assertEqual(self.messages(), [])
        h = self.admin_headers()
        body = self.client.get("/admin/notifications", headers=h).json()
        self.assertIsNone(body["recipient"])
        r = self.client.post("/admin/notifications/test", headers=h)
        self.assertEqual(r.status_code, 502)
        self.assertIn("CITELY_DEMO_RECIPIENT", r.json()["detail"])


class TestNotificationTest(Base):
    def test_the_admin_sends_a_test_and_sees_it_accepted_then_sent(self):
        h = self.admin_headers()
        body = self.client.get("/admin/notifications", headers=h).json()
        self.assertEqual(body["recipient"], "a••••@citely.example")
        self.assertNotIn(ADMIN, str(body))                                    # masked
        r = self.client.post("/admin/notifications/test", headers=h)
        self.assertEqual(r.status_code, 202)
        test = r.json()
        self.assertEqual((test["state"], test["recipient"]), ("accepted", "a••••@citely.example"))
        message = self.messages()[-1]
        self.assertEqual(message["recipients"]["to"], [{"address": ADMIN}])
        self.assertEqual(message["content"]["subject"], "Test: New Citely account awaiting review")
        self.assertIn("This is a test", message["content"]["plainText"])
        self.notices()
        result = self.client.get("/admin/notifications", params={"test_id": test["test_id"]}, headers=h).json()
        self.assertEqual(result["test"]["detail"]["outcome"], "sent")
        self.assertEqual(result["last_sent"]["detail"]["kind"], "test")

    def test_a_test_the_service_refuses_says_why(self):
        self.service.begin_send.side_effect = RuntimeError("DomainNotLinked")
        r = self.client.post("/admin/notifications/test", headers=self.admin_headers())
        self.assertEqual(r.status_code, 502)
        self.assertIn("DomainNotLinked", r.json()["detail"])
        self.assertEqual(self.notices()[0]["detail"]["kind"], "test")

    def test_failures_are_counted_over_the_whole_week_not_just_the_latest_page(self):
        activity.record("admin.notified", email="old@example.org", detail={"kind": "new account", "outcome": "failed", "reason": "service down"})
        for i in range(30):
            activity.record("admin.notified", email=f"n{i}@example.org", detail={"kind": "new account", "outcome": "sent"})
        body = self.client.get("/admin/notifications", headers=self.admin_headers()).json()
        self.assertEqual(len(body["recent"]), 20)                                   # the list shown stays short
        self.assertEqual(body["failed"], 1)                                         # but the old failure still counts
        self.assertEqual(body["last_failed"]["email"], "old@example.org")
        self.assertEqual(body["last_sent"]["email"], "n29@example.org")

    def test_only_the_admin(self):
        member = db.get_user_by_id(db.create_user("member@work.example", password_hash=auth.hash_password(STRONG), email_verified=True, status="approved"))
        h = {"Authorization": "Bearer " + auth.create_access_token(member["id"], member["token_version"])}
        self.assertEqual(self.client.post("/admin/notifications/test", headers=h).status_code, 403)
        self.assertEqual(self.client.get("/admin/notifications", headers=h).status_code, 403)
        self.assertEqual(self.messages(), [])


if __name__ == "__main__":
    unittest.main()
