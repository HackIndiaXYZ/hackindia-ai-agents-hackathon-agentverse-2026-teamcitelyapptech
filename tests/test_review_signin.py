"""Sign up with review, the emailed sign-in code, and trusted browsers.

Real tokens, isolated database, stubbed email (each sent message captured).
"""

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import unquote

from fastapi.testclient import TestClient

import APP.rag  # noqa: F401 — import order the app uses
from APP import access_control as ac
from APP import account_access as access
from APP import activity, auth, db, presence
from APP.main import app, limiter

STRONG = "Velvet-Harbor-73x"
SECRET = "test-only-secret-key-not-for-production"
ADMIN = "admin@citely.example"


class Base(unittest.TestCase):
    env: dict = {}

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.sent = []          # (kind, to, extra)
        for p in (patch.object(db, "DB_PATH", Path(tmp.name) / "data" / "rag.db"),
                  patch.dict(os.environ, {"JWT_SECRET_KEY": SECRET, "CITELY_APPROVED_EMAILS": "", "CITELY_ADMIN_EMAILS": ADMIN,
                                          "TURNSTILE_SECRET_KEY": "", "QUOTA_ENABLED": "false", "CITELY_DEMO_RECIPIENT": ADMIN,
                                          "ACS_SENDER_ADDRESS": "noreply@citely.test", "APP_PUBLIC_URL": "https://citely.example/dev/",
                                          "ACCESS_MODE": "review", "LOGIN_EMAIL_CODE": "on", **self.env}),
                  patch("APP.access_control._domain_receives_mail", return_value=True),
                  patch("APP.main.otp_email.send_otp_email", side_effect=lambda to, code: self.sent.append(("signup-code", to, code))),
                  patch("APP.main.otp_email.send_login_code_email", side_effect=lambda to, code: self.sent.append(("login-code", to, code))),
                  patch("APP.demo_access.mail.send_new_account_review_email", side_effect=lambda admin, email, method, url, **kw: self.sent.append(("review", admin, (email, method, url)))),
                  patch("APP.demo_access.mail.send_account_approved_email", side_effect=lambda to: self.sent.append(("approved", to, None))),
                  patch("APP.demo_access.mail.send_account_declined_email", side_effect=lambda to: self.sent.append(("declined", to, None))),
                  patch("APP.demo_access.mail.send_message", side_effect=lambda to, subject, *a, **k: self.sent.append(("invite", to, subject)))):
            p.start()
            self.addCleanup(p.stop)
        db.init_db()
        limiter.reset()
        import APP.main as main_module
        main_module._otp_last_sent.clear()
        presence.reset()
        self.client = TestClient(app)

    def last(self, kind):
        found = [s for s in self.sent if s[0] == kind]
        return found[-1] if found else None

    def member(self, email="judge@example.org", status="approved"):
        return db.get_user_by_id(db.create_user(email, password_hash=auth.hash_password(STRONG), email_verified=True, status=status))

    def headers(self, user):
        user = db.get_user_by_id(user["id"])
        return {"Authorization": "Bearer " + auth.create_access_token(user["id"], user["token_version"])}

    def login(self, email="judge@example.org", **extra):
        return self.client.post("/auth/login", json={"email": email, "password": STRONG, **extra})

    def enter(self, ticket, code, **extra):
        return self.client.post("/auth/login-code", json={"ticket": ticket, "code": code, **extra})

    def signup_and_verify(self, email):
        self.client.post("/auth/signup", json={"email": email, "password": STRONG})
        return self.client.post("/auth/verify-otp", json={"email": email, "code": self.last("signup-code")[2]})


class ReviewTest(Base):
    def test_anyone_can_sign_up_and_the_account_waits_for_review(self):
        r = self.signup_and_verify("new.person@example.org")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual((body["status"], body["code_required"]), ("pending", False))
        self.assertIsNotNone(body["access_token"])                     # signed in, to see the review screen
        h = {"Authorization": "Bearer " + body["access_token"]}
        self.assertEqual(self.client.get("/me", headers=h).json()["status"], "pending")
        blocked = self.client.get("/documents", headers=h)
        self.assertEqual((blocked.status_code, blocked.headers["X-Citely-Account"]), (403, "pending"))
        kind, to, (email, method, url) = self.last("review")
        self.assertEqual((to, email, method), (ADMIN, "new.person@example.org", "email"))
        self.assertEqual(url, "https://admin.citely.example/#dev/pending")   # straight to Pending review, this environment

    def test_a_pending_account_signs_in_without_a_code(self):
        self.member(status="pending")
        r = self.login().json()
        self.assertEqual((r["status"], r["code_required"]), ("pending", False))
        self.assertIsNone(self.last("login-code"))

    def test_the_approve_link_approves_the_account_and_tells_them(self):
        self.signup_and_verify("new.person@example.org")
        token = ac.approval_token("new.person@example.org")       # links in emails sent before the admin console
        self.assertEqual(self.client.get("/access/approval", params={"token": token}).json(),
                         {"email": "new.person@example.org", "approved": False, "account": True})
        r = self.client.post("/access/approval", json={"token": token}).json()
        self.assertEqual((r["newly"], r["account"]), (True, True))
        self.assertEqual(db.get_user_by_email("new.person@example.org")["status"], "approved")
        self.assertEqual(self.last("approved")[1], "new.person@example.org")
        self.assertIsNone(self.last("invite"))                          # not the "create your account" email

    def test_pre_approved_addresses_and_the_admin_start_approved(self):
        db.approve_access("asked.first@example.org")
        with patch.dict(os.environ, {"CITELY_APPROVED_EMAILS": "listed@example.org"}):
            for email in ("asked.first@example.org", "listed@example.org"):
                with self.subTest(email):
                    self.assertEqual(self.signup_and_verify(email).json()["status"], "approved")
        self.assertEqual(access.initial_status(ADMIN), "approved")
        self.assertIsNone(self.last("review"))

    def test_admin_approve_and_decline_send_their_emails(self):
        admin = self.member(ADMIN)
        a, b = self.member("one@gmail.com", "pending"), self.member("two@gmail.com", "pending")
        h = self.headers(admin)
        self.client.post(f"/admin/users/{a['id']}/status", headers=h, json={"action": "approve"})
        self.client.post(f"/admin/users/{b['id']}/status", headers=h, json={"action": "decline"})
        self.assertEqual(self.last("approved")[1], "one@gmail.com")
        self.assertEqual(self.last("declined")[1], "two@gmail.com")
        declined = self.login("two@gmail.com").json()
        self.assertEqual(declined["status"], "declined")
        self.assertEqual(self.client.get("/documents", headers={"Authorization": "Bearer " + declined["access_token"]}).headers["X-Citely-Account"], "declined")


class OpenModeTest(Base):
    env = {"ACCESS_MODE": "open", "LOGIN_EMAIL_CODE": "off"}

    def test_open_mode_approves_everyone_and_asks_for_no_code(self):
        r = self.signup_and_verify("judge.one@example.org").json()
        self.assertEqual(r["status"], "approved")
        self.assertIsNone(self.last("review"))
        r = self.login("judge.one@example.org").json()
        self.assertEqual((r["code_required"], bool(r["access_token"])), (False, True))


class LoginCodeTest(Base):
    def setUp(self):
        super().setUp()
        self.user = self.member()

    def test_an_approved_account_confirms_with_a_code(self):
        r = self.login().json()
        self.assertEqual((r["code_required"], r["access_token"], r["sent_to"]), (True, None, "j••••@example.org"))
        code = self.last("login-code")[2]
        done = self.enter(r["ticket"], code)
        self.assertEqual(done.status_code, 200)
        self.assertEqual(self.client.get("/me", headers={"Authorization": "Bearer " + done.json()["access_token"]}).status_code, 200)
        self.assertEqual(self.enter(r["ticket"], code).status_code, 400)    # a code works once

    def test_five_wrong_codes_end_the_attempt(self):
        r = self.login().json()
        right = self.last("login-code")[2]
        wrong = "000000" if right != "000000" else "111111"
        for _ in range(4):
            self.assertIn("isn't right", self.enter(r["ticket"], wrong).json()["detail"])
        self.assertIn("Too many wrong codes", self.enter(r["ticket"], wrong).json()["detail"])
        self.assertEqual(self.enter(r["ticket"], right).status_code, 400)

    def test_a_forged_or_expired_ticket_is_refused(self):
        self.assertEqual(self.enter("not-a-real-ticket-at-all", "123456").status_code, 400)

    def test_resend_waits_a_minute_and_replaces_the_code(self):
        r = self.login().json()
        first = self.last("login-code")[2]
        self.assertEqual(self.client.post("/auth/login-code/resend", json={"ticket": r["ticket"]}).status_code, 429)
        import APP.main as main_module
        main_module._otp_last_sent.clear()
        again = self.client.post("/auth/login-code/resend", json={"ticket": r["ticket"]}).json()
        second = self.last("login-code")[2]
        if first != second:
            self.assertEqual(self.enter(again["ticket"], first).status_code, 400)
        self.assertEqual(self.enter(again["ticket"], second).status_code, 200)

    def test_a_trusted_browser_skips_the_code_for_this_account_only(self):
        r = self.login().json()
        done = self.enter(r["ticket"], self.last("login-code")[2], trust_browser=True, browser_label="Chrome on Mac").json()
        trusted = done["trusted_browser"]
        self.assertTrue(trusted)
        self.sent.clear()
        again = self.login(trusted_browser=trusted).json()
        self.assertEqual((again["code_required"], bool(again["access_token"])), (False, True))
        self.assertIsNone(self.last("login-code"))
        other = self.member("other@example.org")
        self.assertTrue(self.login("other@example.org", trusted_browser=trusted).json()["code_required"])
        listed = self.client.get("/me/trusted-browsers", headers=self.headers(self.user)).json()["items"]
        self.assertEqual((len(listed), listed[0]["label"]), (1, "Chrome on Mac"))
        self.assertNotIn("token_hash", listed[0])

    def test_an_expired_trust_needs_the_code_again(self):
        r = self.login().json()
        trusted = self.enter(r["ticket"], self.last("login-code")[2], trust_browser=True).json()["trusted_browser"]
        with db._connect() as conn:
            conn.execute("UPDATE trusted_browsers SET expires_at = '2000-01-01T00:00:00+00:00'")
        self.assertTrue(self.login(trusted_browser=trusted).json()["code_required"])

    def test_trust_is_forgotten_on_reset_suspend_and_sign_out_everywhere(self):
        def trust():
            r = self.login().json()
            return self.enter(r["ticket"], self.last("login-code")[2], trust_browser=True).json()
        # sign out everywhere: old sessions stop, trust is forgotten
        session = trust()
        r = self.client.post("/me/sign-out-everywhere", headers={"Authorization": "Bearer " + session["access_token"]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.client.get("/me", headers={"Authorization": "Bearer " + session["access_token"]}).status_code, 401)
        self.assertTrue(self.login(trusted_browser=session["trusted_browser"]).json()["code_required"])
        # suspension
        trusted = trust()["trusted_browser"]
        db.set_user_status(self.user["id"], "suspended")
        admin = self.member(ADMIN)
        self.client.post(f"/admin/users/{self.user['id']}/status", headers=self.headers(admin), json={"action": "unsuspend"})
        db.set_user_status(self.user["id"], "approved")
        trusted = trust()["trusted_browser"]
        self.client.post(f"/admin/users/{self.user['id']}/status", headers=self.headers(admin), json={"action": "suspend"})
        self.assertEqual(db.list_trusted_browsers(self.user["id"]), [])
        self.client.post(f"/admin/users/{self.user['id']}/status", headers=self.headers(admin), json={"action": "unsuspend"})
        self.assertTrue(self.login(trusted_browser=trusted).json()["code_required"])
        # password reset
        trust()
        token = auth.generate_reset_token()
        db.create_password_reset_token(self.user["id"], auth.hash_reset_token(token))
        self.assertTrue(db.reset_password_with_token(self.user["id"], auth.hash_reset_token(token), auth.hash_password("New-Harbor-Lane-84")))
        self.assertEqual(db.list_trusted_browsers(self.user["id"]), [])

    def test_admin_can_revoke_trusted_browsers(self):
        r = self.login().json()
        self.enter(r["ticket"], self.last("login-code")[2], trust_browser=True)
        admin = self.member(ADMIN)
        detail = self.client.get(f"/admin/users/{self.user['id']}", headers=self.headers(admin)).json()
        self.assertEqual(len(detail["trusted_browsers"]), 1)
        self.assertEqual(self.client.post(f"/admin/users/{self.user['id']}/revoke-browsers", headers=self.headers(admin)).json()["removed"], 1)

    def test_social_sign_in_asks_for_the_code_too_unless_trusted(self):
        db.link_identity(self.user["id"], "google", "g-1")
        with patch("APP.main.auth.exchange_google_code", return_value={"email": "judge@example.org", "provider_user_id": "g-1"}):
            r = self.client.post("/auth/google/callback", json={"code": "c", "redirect_uri": "http://localhost/cb"}).json()
            self.assertTrue(r["code_required"])
            trusted = self.enter(r["ticket"], self.last("login-code")[2], trust_browser=True).json()["trusted_browser"]
            again = self.client.post("/auth/google/callback", json={"code": "c", "redirect_uri": "http://localhost/cb", "trusted_browsers": ["x" * 40, trusted]}).json()
        self.assertEqual((again["code_required"], bool(again["access_token"])), (False, True))

    def test_suspended_accounts_get_no_code_and_no_token(self):
        db.set_user_status(self.user["id"], "suspended")
        r = self.login()
        self.assertEqual(r.status_code, 403)
        self.assertIsNone(self.last("login-code"))

    def test_with_codes_off_sign_in_is_direct(self):
        with patch.dict(os.environ, {"LOGIN_EMAIL_CODE": "off"}):
            r = self.login().json()
        self.assertEqual((r["code_required"], bool(r["access_token"])), (False, True))


class EmailTemplatesTest(unittest.TestCase):
    def test_new_emails_use_the_citely_layout_and_say_the_right_thing(self):
        from APP.auth import email_templates as t
        cases = {
            "login": (t.login_code_html("482913"), "482913", "Confirm it"),
            "review": (t.new_account_html(email="a@b.com", method="Google", review_url="https://admin.citely.example/#prod/pending"), "Review in admin", "a@b.com"),
            "approved": (t.account_approved_html(email="a@b.com"), "You're in.", "Sign in to Citely"),
            "declined": (t.account_declined_html(email="a@b.com"), "Thank you for your interest.", "Try the demo"),
        }
        for name, (html, *needles) in cases.items():
            with self.subTest(name):
                for needle in needles:
                    self.assertIn(needle.replace("'", "&#x27;") if "'" in needle and needle not in html else needle, html)
                self.assertIn("Dwarka, New Delhi, India", html)               # the shared footer
                self.assertIn("#E52B15", html)                                # Citely red


if __name__ == "__main__":
    unittest.main()
