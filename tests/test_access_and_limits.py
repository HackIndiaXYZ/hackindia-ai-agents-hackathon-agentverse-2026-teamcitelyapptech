"""Account protection, one-click approvals, the admin, and demo usage limits.

Isolated database, stubbed email, no real DNS or Cloudflare calls.
"""

import os
import re
from urllib.parse import unquote
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import jwt
from fastapi.testclient import TestClient

import APP.rag  # noqa: F401 — import order the app uses
from APP import access_control as ac
from APP import db, usage
from APP.auth import get_current_user
from APP.main import app, limiter

STRONG = "Velvet-Harbor-73x"
SECRET = "test-only-secret-key-not-for-production"


class Isolated(unittest.TestCase):
    env: dict = {}

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for p in (patch.object(db, "DB_PATH", Path(tmp.name) / "test.db"),
                  patch.dict(os.environ, {"JWT_SECRET_KEY": SECRET, "CITELY_APPROVED_EMAILS": "", "CITELY_ADMIN_EMAILS": "",
                                          "TURNSTILE_SECRET_KEY": "", "QUOTA_ENABLED": "false",
                                          "CITELY_DEMO_RECIPIENT": "admin@citely.example",
                                          "ACS_SENDER_ADDRESS": "noreply@citely.test", **self.env}),
                  patch("APP.access_control._domain_receives_mail", return_value=True)):
            p.start()
            self.addCleanup(p.stop)
        db.init_db()
        limiter.reset()
        import APP.main as main_module
        main_module._otp_last_sent.clear()           # the resend cooldown is process-wide


# --------------------------------------------------------------------------- #
# Rules
# --------------------------------------------------------------------------- #

class PasswordRulesTest(unittest.TestCase):
    def test_weak_passwords_are_refused_with_a_reason(self):
        cases = {
            "Short-1a": "at least 12",
            "alllowercaseletters": "Mix at least three",
            "Password2024!": "too common",
            "P@ssword12345": "too common",
            "Qwerty-Lane-88": "sequences",
            "Moon-aaaa-Field-7": "sequences",
            "Dragon-Fly-1234x": "sequences",
            "Jane.Doe-River-9": "email address",
        }
        for password, reason in cases.items():
            with self.subTest(password):
                problem = ac.password_problem(password, "jane.doe@gmail.com" if "Doe" in password else "x@y.com")
                self.assertIsNotNone(problem)
                self.assertIn(reason, problem)

    def test_strong_passwords_pass(self):
        for password in (STRONG, "Copper-Lantern-58q", "correct HORSE battery 9"):
            with self.subTest(password):
                self.assertIsNone(ac.password_problem(password, "someone@gmail.com"))


class EmailRulesTest(unittest.TestCase):
    def setUp(self):
        p = patch("APP.access_control._domain_receives_mail", return_value=True)
        p.start()
        self.addCleanup(p.stop)

    def test_malformed_addresses_are_refused(self):
        for bad in ("plainaddress", "a@b", "a..b@gmail.com", ".a@gmail.com", "a@-gmail.com", "a b@gmail.com", "x" * 65 + "@gmail.com"):
            with self.subTest(bad), self.assertRaises(ac.EmailRejected):
                ac.check_signup_email(bad)

    def test_disposable_domains_and_their_subdomains_are_refused(self):
        for bad in ("someone@mailinator.com", "x@yopmail.com", "y@10minutemail.com", "z@inbox.mailinator.com"):
            with self.subTest(bad), self.assertRaisesRegex(ac.EmailRejected, "Temporary or disposable"):
                ac.check_signup_email(bad)

    def test_real_providers_pass_and_are_normalized(self):
        self.assertEqual(ac.check_signup_email("  Person@Gmail.com "), "person@gmail.com")
        for ok in ("a@outlook.com", "b@proton.me", "c.d@solarion.ai"):
            self.assertEqual(ac.check_signup_email(ok), ok)

    def test_a_domain_that_receives_no_mail_is_refused(self):
        with patch("APP.access_control._domain_receives_mail", return_value=False):
            with self.assertRaisesRegex(ac.EmailRejected, "doesn't receive mail"):
                ac.check_signup_email("x@made-up-domain.com")

    def test_aliases_of_one_inbox_share_a_canonical_address(self):
        same = ["john.doe@gmail.com", "JohnDoe@gmail.com", "j.o.h.n.d.o.e+hackathon@gmail.com", "johndoe@googlemail.com"]
        self.assertEqual({ac.canonical_email(e) for e in same}, {"johndoe@gmail.com"})
        self.assertEqual(ac.canonical_email("first.last+x@outlook.com"), "first.last@outlook.com")   # dots matter outside Gmail


class VisitorAddressTest(unittest.TestCase):
    def test_the_last_forwarded_hop_is_the_visitor(self):
        request = SimpleNamespace(headers={"x-forwarded-for": "6.6.6.6, 203.0.113.7"}, client=SimpleNamespace(host="100.100.0.144"))
        self.assertEqual(ac.client_ip(request), "203.0.113.7")   # the spoofable first entry is ignored
        self.assertEqual(ac.client_ip(SimpleNamespace(headers={}, client=SimpleNamespace(host="10.0.0.1"))), "10.0.0.1")


class TurnstileTest(unittest.TestCase):
    def test_off_unless_configured_and_fails_closed(self):
        with patch.dict(os.environ, {"TURNSTILE_SECRET_KEY": ""}):
            self.assertTrue(ac.turnstile_passed(None, None))
        with patch.dict(os.environ, {"TURNSTILE_SECRET_KEY": "s"}):
            self.assertFalse(ac.turnstile_passed(None, "1.2.3.4"))
            with patch("APP.access_control.httpx.post", return_value=Mock(json=lambda: {"success": True})) as post:
                self.assertTrue(ac.turnstile_passed("tok", "1.2.3.4"))
                self.assertEqual(post.call_args.kwargs["data"]["remoteip"], "1.2.3.4")
            with patch("APP.access_control.httpx.post", return_value=Mock(json=lambda: {"success": False})):
                self.assertFalse(ac.turnstile_passed("tok", None))
            with patch("APP.access_control.httpx.post", side_effect=OSError("unreachable")):
                self.assertFalse(ac.turnstile_passed("tok", None))


class ApprovalTokenTest(unittest.TestCase):
    def setUp(self):
        p = patch.dict(os.environ, {"JWT_SECRET_KEY": SECRET})
        p.start()
        self.addCleanup(p.stop)

    def test_round_trip_and_rejections(self):
        self.assertEqual(ac.email_from_approval_token(ac.approval_token("Judge@Example.org")), "judge@example.org")
        self.assertIsNone(ac.email_from_approval_token("garbage"))
        token = ac.approval_token("a@b.org")
        self.assertIsNone(ac.email_from_approval_token(token[:-2] + ("aa" if token[-2:] != "aa" else "bb")))
        expired = jwt.encode({"purpose": "citely-access-approval", "email": "a@b.org",
                              "exp": datetime.now(timezone.utc) - timedelta(seconds=1)}, SECRET, algorithm="HS256")
        self.assertIsNone(ac.email_from_approval_token(expired))
        session = jwt.encode({"sub": "user-1", "email": "a@b.org"}, SECRET, algorithm="HS256")   # a sign-in token is not an approval
        self.assertIsNone(ac.email_from_approval_token(session))


# --------------------------------------------------------------------------- #
# Sign-up, approvals and the admin over HTTP
# --------------------------------------------------------------------------- #

def _mail_client():
    client = Mock()
    client.begin_send.return_value.result.return_value = {"status": "Succeeded"}
    return client


class SignupApiTest(Isolated):
    env = {"CITELY_ADMIN_EMAILS": "admin@citely.example"}

    def setUp(self):
        super().setUp()
        self.client = TestClient(app)
        p = patch("APP.main.otp_email.send_otp_email")
        self.sent = p.start()
        self.addCleanup(p.stop)

    def signup(self, email, password=STRONG, **extra):
        return self.client.post("/auth/signup", json={"email": email, "password": password, **extra})

    def test_unapproved_people_can_sign_up_and_no_account_exists_before_the_code(self):
        # Review mode: anyone may sign up; the account will start pending.
        self.assertEqual(self.signup("judge@example.org").status_code, 201)
        self.assertIsNone(db.get_user_by_email("judge@example.org"))

    def test_bad_email_or_weak_password_is_refused_before_anything_else(self):
        db.approve_access("judge@example.org")
        r = self.signup("judge@mailinator.com")
        self.assertEqual((r.status_code, "disposable" in r.json()["detail"]), (400, True))
        r = self.signup("judge@example.org", "password123")
        self.assertEqual(r.status_code, 400)
        self.assertIn("characters", r.json()["detail"])
        self.assertIsNone(db.get_user_by_email("judge@example.org"))
        self.sent.assert_not_called()

    def test_the_admin_needs_no_approval(self):
        with patch.dict(os.environ, {"CITELY_ADMIN_EMAILS": "admin@citely-test.org"}):
            self.assertEqual(self.signup("admin@citely-test.org").status_code, 201)
        self.sent.assert_called_once()

    def test_personal_addresses_sign_up_with_google_or_github(self):
        r = self.signup("john.doe@gmail.com")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Google or GitHub", r.json()["detail"])
        self.sent.assert_not_called()
        with db._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM pending_signups").fetchone()[0], 0)

    def test_temporary_addresses_are_refused_before_any_code(self):
        r = self.signup("sociro8819@calirona.com")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Temporary or disposable", r.json()["detail"])
        self.sent.assert_not_called()

    def test_one_inbox_cannot_hold_two_accounts(self):
        db.approve_access("john.doe@example.org")
        with patch("APP.main.auth.generate_otp_code", return_value="123456"):
            self.assertEqual(self.signup("john.doe@example.org").status_code, 201)
        self.assertEqual(self.client.post("/auth/verify-otp", json={"email": "john.doe@example.org", "code": "123456"}).status_code, 200)
        self.sent.reset_mock()
        r = self.signup("john.doe+again@example.org")
        self.assertEqual(r.status_code, 201)               # same answer, so it can't probe which inboxes exist
        self.sent.assert_not_called()                      # but no code, and no second account
        with db._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0], 1)

    def test_pressing_sign_up_twice_at_once_holds_one_sign_up_and_sends_one_code(self):
        db.approve_access("judge@example.org")
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.signup("judge@example.org").status_code)) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(results, [201] * 4)
        with db._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0], 0)            # none until the code is entered
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM pending_signups").fetchone()[0], 1)
        self.assertEqual(self.sent.call_count, 1)

    def test_the_bot_check_is_required_when_configured(self):
        db.approve_access("judge@example.org")
        with patch.dict(os.environ, {"TURNSTILE_SECRET_KEY": "s"}):
            self.assertEqual(self.signup("judge@example.org").status_code, 400)
            with patch("APP.access_control.httpx.post", return_value=Mock(json=lambda: {"success": True})):
                self.assertEqual(self.signup("judge@example.org", turnstile_token="ok").status_code, 201)

    def test_verification_and_sign_in_work_however_the_address_is_spelled(self):
        db.approve_access("john.doe@example.org")
        with patch("APP.main.auth.generate_otp_code", return_value="123456"):
            self.signup("john.doe@example.org")
        r = self.client.post("/auth/verify-otp", json={"email": "John.Doe@Example.org", "code": "123456"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["email"], "john.doe@example.org")
        r = self.client.post("/auth/login", json={"email": "john.doe+work@example.org", "password": STRONG})
        self.assertEqual(r.status_code, 200)

    def test_resetting_to_a_weak_password_is_refused(self):
        uid = db.create_user("member@example.org", email_verified=True)
        r = self.client.post("/auth/reset-password", json={"email": "member@example.org", "token": "x" * 32, "new_password": "short"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("characters", r.json()["detail"])
        self.assertIsNotNone(uid)


class ApprovalFlowTest(Isolated):
    def setUp(self):
        super().setUp()
        self.client = TestClient(app)
        self.mail = _mail_client()
        for target in ("APP.demo_access.mail._get_client", "APP.main.otp_email._get_client"):
            p = patch(target, return_value=self.mail)
            p.start()
            self.addCleanup(p.stop)
        p = patch("APP.main.otp_email.send_otp_email")
        p.start()
        self.addCleanup(p.stop)

    def request_access(self):
        """Sends a demo request; returns the approval token older emails carried
        (the /approve links in emails already sent keep working)."""
        r = self.client.post("/demo-requests", json={"name": "Judge", "email": "judge@example.org", "phone": "+91 9876543210", "comment": "Hackathon judging"})
        self.assertEqual(r.status_code, 202)
        message = self.mail.begin_send.call_args.args[0]
        self.assertEqual(message["recipients"]["to"], [{"address": "admin@citely.example"}])
        return ac.approval_token("judge@example.org")

    def test_the_request_email_links_straight_to_the_admin_console(self):
        with patch.dict(os.environ, {"APP_PUBLIC_URL": "https://dev.citely.example/"}):
            self.request_access()
        message = self.mail.begin_send.call_args.args[0]
        self.assertIn("https://admin.citely.example/#dev/requests", message["content"]["plainText"])
        self.assertIn("https://admin.citely.example/#dev/requests", message["content"]["html"])
        self.assertNotIn("/approve/?token=", message["content"]["plainText"])
        self.assertNotIn("azurecontainerapps", message["content"]["html"])

    def test_temporary_addresses_cannot_request_a_demo(self):
        r = self.client.post("/demo-requests", json={"name": "X", "email": "sociro8819@calirona.com", "phone": "+91 9876543210", "comment": "hi"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("Temporary or disposable", r.json()["detail"])
        self.mail.begin_send.assert_not_called()
        self.assertEqual(db.list_demo_requests(None), [])

    def test_site_approval_end_to_end(self):
        token = self.request_access()
        status = self.client.get("/access/approval", params={"token": token})
        self.assertEqual(status.json(), {"email": "judge@example.org", "approved": False, "account": False})
        self.assertFalse(db.is_access_approved("judge@example.org"))       # looking approves nobody
        done = self.client.post("/access/approval", json={"token": token})
        self.assertEqual(done.json(), {"email": "judge@example.org", "approved": True, "newly": True, "account": False})
        self.assertTrue(db.is_access_approved("judge@example.org"))
        invite = self.mail.begin_send.call_args.args[0]
        self.assertEqual(invite["recipients"]["to"], [{"address": "judge@example.org"}])
        again = self.client.post("/access/approval", json={"token": token})
        self.assertFalse(again.json()["newly"])                             # a second press sends nothing more
        self.assertTrue(self.client.get("/access/approval", params={"token": token}).json()["approved"])
        for bad in ("forged", jwt.encode({"purpose": "citely-access-approval", "email": "x@y.org", "exp": 1}, SECRET, algorithm="HS256")):
            self.assertEqual(self.client.get("/access/approval", params={"token": bad}).status_code, 400)
            self.assertEqual(self.client.post("/access/approval", json={"token": bad}).status_code, 400)

    def test_one_click_approval_end_to_end(self):
        # Links already sent before the move to the site still work.
        token = self.request_access()
        page = self.client.get("/access/approve", params={"token": token})
        self.assertEqual(page.status_code, 200)
        self.assertIn("Approve access?", page.text)
        self.assertIn("judge@example.org", page.text)
        self.assertFalse(db.is_access_approved("judge@example.org"))       # opening the link approves nobody
        done = self.client.post("/access/approve", data={"token": token})
        self.assertIn("can now create an account", done.text)
        self.assertTrue(db.is_access_approved("judge@example.org"))
        invite = self.mail.begin_send.call_args.args[0]
        self.assertEqual(invite["recipients"]["to"], [{"address": "judge@example.org"}])
        self.assertIn("/signin/?mode=signup", invite["content"]["plainText"])
        self.assertEqual(self.client.post("/auth/signup", json={"email": "judge@example.org", "password": STRONG}).status_code, 201)
        again = self.client.post("/access/approve", data={"token": token})
        self.assertIn("already approved", again.text)

    def test_forged_or_expired_links_approve_nobody(self):
        for token in ("", "forged", jwt.encode({"purpose": "citely-access-approval", "email": "x@y.org", "exp": 1}, SECRET, algorithm="HS256")):
            with self.subTest(token=token[:12]):
                self.assertEqual(self.client.get("/access/approve", params={"token": token}).status_code, 400)
                self.assertEqual(self.client.post("/access/approve", data={"token": token}).status_code, 400)
        with db._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM access_approvals").fetchone()[0], 0)

    def test_approval_page_escapes_the_address(self):
        token = ac.approval_token("<script>alert(1)</script>@x.org")
        page = self.client.get("/access/approve", params={"token": token})
        self.assertNotIn("<script>alert(1)", page.text)


# --------------------------------------------------------------------------- #
# Usage limits
# --------------------------------------------------------------------------- #

class UsageLimitsTest(Isolated):
    env = {"QUOTA_ENABLED": "true", "CITELY_ADMIN_EMAILS": "admin@citely.example"}

    def setUp(self):
        super().setUp()
        self.user = db.get_user_by_id(db.create_user("judge@example.org", email_verified=True))

    def test_per_account_limit(self):
        for _ in range(5):
            usage.reserve(self.user, usage.QUESTION)
        with self.assertRaises(db.UsageLimitReached) as caught:
            usage.reserve(self.user, usage.QUESTION)
        self.assertEqual(caught.exception.scope, "account")

    def test_daily_limit_across_everyone(self):
        others = [db.get_user_by_id(db.create_user(f"p{i}@example.org", email_verified=True)) for i in range(3)]
        for user in others:
            usage.reserve(user, usage.UPLOAD)
        with self.assertRaises(db.UsageLimitReached) as caught:
            usage.reserve(self.user, usage.UPLOAD)          # this person has used nothing, but today's 3 are gone
        self.assertEqual(caught.exception.scope, "daily")
        with patch("APP.usage.today", return_value="2999-01-01"):
            usage.reserve(self.user, usage.UPLOAD)          # a new day, a new allowance

    def test_simultaneous_requests_never_exceed_a_limit(self):
        granted = []

        def ask():
            try:
                usage.reserve(self.user, usage.QUESTION)
                granted.append(1)
            except db.UsageLimitReached:
                pass
        threads = [threading.Thread(target=ask) for _ in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(granted), 5)

    def test_released_uses_come_back(self):
        day = usage.reserve(self.user, usage.QUESTION)
        usage.release(self.user, usage.QUESTION, day)
        self.assertEqual(usage.snapshot(self.user)["questions"]["used"], 0)

    def test_admin_and_disabled_limits_are_unlimited(self):
        admin = db.get_user_by_id(db.create_user("admin@citely.example", email_verified=True))
        for _ in range(50):
            self.assertIsNone(usage.reserve(admin, usage.QUESTION))
        self.assertEqual(usage.snapshot(admin), {"limited": False})
        with patch.dict(os.environ, {"QUOTA_ENABLED": "false"}):
            self.assertIsNone(usage.reserve(self.user, usage.UPLOAD))

    def test_page_counts_come_from_the_file_without_parsing(self):
        from io import BytesIO
        from pypdf import PdfWriter
        writer = PdfWriter()
        for _ in range(31):
            writer.add_blank_page(width=200, height=200)
        buffer = BytesIO()
        writer.write(buffer)
        self.assertEqual(usage.page_count(buffer.getvalue(), "big.pdf"), 31)
        fixtures = Path(__file__).resolve().parents[1] / "Citely-Modernist-Next-Final" / "tests" / "fixtures"
        self.assertEqual(usage.page_count((fixtures / "pptx" / "atlas_board_update.pptx").read_bytes(), "a.pptx"), 8)
        self.assertEqual(usage.page_count((fixtures / "xlsx" / "northwind_operations.xlsx").read_bytes(), "n.xlsx"), 5)
        self.assertIsNone(usage.page_count(b"not a zip", "x.docx"))


class UsageApiTest(Isolated):
    env = {"QUOTA_ENABLED": "true", "CITELY_ADMIN_EMAILS": "admin@citely.example"}

    def setUp(self):
        super().setUp()
        self.user = db.get_user_by_id(db.create_user("judge@example.org", email_verified=True))
        from APP.schemas import QueryResponse
        self.service = Mock()
        self.service.answer.return_value = QueryResponse(request_id="r", answer="ok", sources=[], model="m", collection_name="c")
        p = patch.object(app.state, "rag_service", self.service, create=True)
        p.start()
        self.addCleanup(p.stop)
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app)

    def ask(self):
        return self.client.post("/query", json={"document_id": "d1", "question": "What?"})

    def test_five_questions_then_a_thank_you(self):
        for _ in range(5):
            self.assertEqual(self.ask().status_code, 200)
        r = self.ask()
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.json()["detail"], "You've used all 5 questions in this demo. Thank you for trying Citely!")
        self.assertEqual(r.headers["X-Citely-Limit"], "question-account")
        self.assertEqual(self.service.answer.call_count, 5)          # the 6th never reached the model

    def test_a_question_that_fails_does_not_count(self):
        self.service.answer.side_effect = RuntimeError("model unavailable")
        self.assertEqual(self.ask().status_code, 422)
        self.assertEqual(self.client.get("/me/usage").json()["questions"]["used"], 0)

    def test_usage_endpoint(self):
        self.ask()
        body = self.client.get("/me/usage").json()
        self.assertEqual(body["questions"], {"used": 1, "limit": 5, "remaining": 4, "daily_exhausted": False})
        self.assertEqual((body["uploads"]["remaining"], body["max_upload_mb"], body["max_pages"]), (3, 10, 30))

    def test_uploads_count_once_and_failed_ones_come_back(self):
        def ingest(**kw):
            return SimpleNamespace(model_dump=lambda: {"document_id": "doc", "pages": 1})
        self.service.ingest.side_effect = ingest
        send = lambda key: self.client.post("/ingest/async", data={"client_upload_id": key}, files={"file": ("a.txt", b"hello world " * 20, "text/plain")})
        self.assertEqual(send("row-1").status_code, 202)
        self.assertEqual(send("row-1").status_code, 202)              # a resend of the same upload
        for _ in range(50):
            if self.client.get("/me/usage").json()["uploads"]["used"] == 1 and not self.service.ingest.call_count < 1:
                break
            time.sleep(0.02)
        self.assertEqual(self.client.get("/me/usage").json()["uploads"]["used"], 1)
        self.service.ingest.side_effect = RuntimeError("parse failed")
        self.assertEqual(send("row-2").status_code, 202)
        for _ in range(100):
            if self.service.ingest.call_count >= 2:
                break
            time.sleep(0.02)
        time.sleep(0.1)
        self.assertEqual(self.client.get("/me/usage").json()["uploads"]["used"], 1)   # the failed one was given back

    def test_oversized_files_and_documents_are_refused_before_any_work(self):
        r = self.client.post("/ingest/async", files={"file": ("big.txt", b"x" * (11 * 1024 * 1024), "text/plain")})
        self.assertEqual(r.status_code, 413)
        self.assertIn("up to 10 MB", r.json()["detail"])
        from io import BytesIO
        from pypdf import PdfWriter
        writer = PdfWriter()
        for _ in range(31):
            writer.add_blank_page(width=200, height=200)
        buffer = BytesIO()
        writer.write(buffer)
        r = self.client.post("/ingest/async", files={"file": ("long.pdf", buffer.getvalue(), "application/pdf")})
        self.assertEqual(r.status_code, 413)
        self.assertIn("up to 30 pages", r.json()["detail"])
        self.service.ingest.assert_not_called()
        self.assertEqual(self.client.get("/me/usage").json()["uploads"]["used"], 0)

    def test_the_admin_is_never_limited(self):
        self.user = db.get_user_by_id(db.create_user("admin@citely.example", email_verified=True))
        for _ in range(8):
            self.assertEqual(self.ask().status_code, 200)
        self.assertEqual(self.client.get("/me/usage").json(), {"limited": False})


if __name__ == "__main__":
    unittest.main()
