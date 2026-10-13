"""Accounts, the activity log and the admin console API.

Real sign-in tokens (no dependency overrides), so the account-status checks
in get_current_user run exactly as they do in production. Isolated database
and data folder, stubbed email and document service.
"""

import io
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

import APP.rag  # noqa: F401 — import order the app uses
from APP import activity, admin, auth, db, presence
from APP.main import app, limiter

STRONG = "Velvet-Harbor-73x"
SECRET = "test-only-secret-key-not-for-production"
ADMIN = "admin@citely.example"


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        for p in (patch.object(db, "DB_PATH", self.tmp / "data" / "rag.db"),
                  patch.object(admin, "SAMPLES_DIR", self.tmp / "data" / "samples"),
                  patch.dict(os.environ, {"JWT_SECRET_KEY": SECRET, "CITELY_APPROVED_EMAILS": "", "CITELY_ADMIN_EMAILS": ADMIN,
                                          "TURNSTILE_SECRET_KEY": "", "QUOTA_ENABLED": "true",
                                          "CITELY_DEMO_RECIPIENT": ADMIN, "ACS_SENDER_ADDRESS": "noreply@citely.test",
                                          "APP_PUBLIC_URL": "https://citely.example/dev/"}),
                  patch("APP.access_control._domain_receives_mail", return_value=True),
                  patch("APP.main.otp_email.send_otp_email"),
                  patch("APP.demo_access.mail.send_message"),
                  patch("APP.demo_access.mail._get_client")):
            p.start()
            self.addCleanup(p.stop)
        db.init_db()
        limiter.reset()
        import APP.main as main_module
        main_module._otp_last_sent.clear()
        presence.reset()
        admin.storage_walk.clear()
        self.service = Mock()
        # The real service's shape where the admin pages read it.
        self.service.settings = SimpleNamespace(qdrant_collection="chunks_test")
        self.service.qdrant.get_collection.return_value = SimpleNamespace(status="green", points_count=0, indexed_vectors_count=0, segments_count=1)
        self.service.list_documents.return_value = []
        self.service.remove_document.return_value = True
        p = patch.object(app.state, "rag_service", self.service, create=True)
        p.start()
        self.addCleanup(p.stop)
        self.client = TestClient(app)

    def user(self, email, **kw):
        return db.get_user_by_id(db.create_user(email, email_verified=True, **kw))

    def headers(self, user):
        return {"Authorization": "Bearer " + auth.create_access_token(user["id"], user["token_version"])}

    def events(self, type=None):
        return [dict(e) for e in db.list_events(types=[type] if type else None, limit=500)]


class AdminOnlyTest(Base):
    ROUTES = [("get", "/admin/overview"), ("get", "/admin/users"), ("get", "/admin/events"), ("get", "/admin/database"),
              ("get", "/admin/server"), ("get", "/admin/demo-requests"), ("get", "/admin/samples")]

    def test_only_the_citely_address_gets_in(self):
        member = self.user("judge@example.org")
        same_domain = self.user("someone@citely.example")
        admin_user = self.user(ADMIN)
        for method, path in self.ROUTES:
            with self.subTest(path):
                self.assertEqual(getattr(self.client, method)(path).status_code, 401)
                self.assertEqual(getattr(self.client, method)(path, headers=self.headers(member)).status_code, 403)
                self.assertEqual(getattr(self.client, method)(path, headers=self.headers(same_domain)).status_code, 403)
                self.assertEqual(getattr(self.client, method)(path, headers=self.headers(admin_user)).status_code, 200)

    def test_an_unverified_admin_address_is_not_an_admin(self):
        row = db.get_user_by_id(db.create_user(ADMIN, email_verified=False))
        with db._connect() as conn:   # pretend a legacy row survived
            conn.execute("UPDATE users SET email_verified = 0 WHERE id = ?", (row["id"],))
        self.assertEqual(self.client.get("/admin/overview", headers=self.headers(row)).status_code, 403)


class HeldSignupTest(Base):
    def setUp(self):
        super().setUp()
        db.approve_access("judge@example.org")

    def signup(self, code="123456"):
        with patch("APP.main.auth.generate_otp_code", return_value=code):
            return self.client.post("/auth/signup", json={"email": "judge@example.org", "password": STRONG})

    def verify(self, code):
        return self.client.post("/auth/verify-otp", json={"email": "judge@example.org", "code": code})

    def test_no_account_exists_until_the_code_is_entered(self):
        self.assertEqual(self.signup().status_code, 201)
        self.assertIsNone(db.get_user_by_email("judge@example.org"))
        self.assertEqual(self.client.post("/auth/login", json={"email": "judge@example.org", "password": STRONG}).status_code, 401)
        r = self.verify("123456")
        self.assertEqual(r.status_code, 200)
        user = db.get_user_by_email("judge@example.org")
        self.assertTrue(user["email_verified"])
        self.assertEqual(user["status"], "approved")
        self.assertEqual(self.client.post("/auth/login", json={"email": "judge@example.org", "password": STRONG}).status_code, 200)
        self.assertEqual([e["type"] for e in self.events("auth.signup")], ["auth.signup"])

    def test_an_expired_sign_up_is_discarded(self):
        self.signup()
        with db._connect() as conn:
            conn.execute("UPDATE pending_signups SET expires_at = ?", ((datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(),))
        self.assertEqual(self.verify("123456").status_code, 400)
        with db._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM pending_signups").fetchone()[0], 0)
        self.assertIsNone(db.get_user_by_email("judge@example.org"))

    def test_five_wrong_codes_discard_the_sign_up(self):
        self.signup()
        for _ in range(4):
            self.assertEqual(self.verify("000000").json()["detail"], "Invalid or expired code")
        self.assertIn("Too many wrong codes", self.verify("000000").json()["detail"])
        self.assertEqual(self.verify("123456").status_code, 400)          # the right code no longer works
        self.assertIsNone(db.get_user_by_email("judge@example.org"))

    def test_resend_issues_a_new_code_for_a_held_sign_up_only(self):
        self.signup("111111")
        import APP.main as main_module
        main_module._otp_last_sent.clear()
        with patch("APP.main.auth.generate_otp_code", return_value="222222"):
            self.assertEqual(self.client.post("/auth/resend-otp", json={"email": "judge@example.org"}).status_code, 202)
        self.assertEqual(self.verify("111111").status_code, 400)
        self.assertEqual(self.verify("222222").status_code, 200)

    def test_legacy_unverified_accounts_are_removed(self):
        legacy = db.create_user("old@example.org", email_verified=False)
        db.create_otp(legacy, "x")
        kept = db.create_user("kept@example.org", email_verified=True)
        db.init_db()
        self.assertIsNone(db.get_user_by_id(legacy))
        self.assertIsNotNone(db.get_user_by_id(kept))


class AccountStatusTest(Base):
    def setUp(self):
        super().setUp()
        self.admin = self.user(ADMIN)
        self.member = self.user("judge@example.org", password_hash=auth.hash_password(STRONG))

    def act(self, action, target=None, reason=None):
        return self.client.post(f"/admin/users/{(target or self.member)['id']}/status", headers=self.headers(self.admin),
                                json={"action": action, **({"reason": reason} if reason else {})})

    def test_existing_and_new_accounts_start_approved(self):
        self.assertEqual(self.member["status"], "approved")

    def test_suspending_blocks_every_request_and_sign_in_until_undone(self):
        h = self.headers(self.member)
        self.assertEqual(self.client.get("/me/usage", headers=h).status_code, 200)
        self.assertEqual(self.act("suspend", reason="abuse").json()["status"], "suspended")
        for path in ("/me/usage", "/documents"):
            r = self.client.get(path, headers=h)
            self.assertEqual((r.status_code, r.headers.get("X-Citely-Account")), (403, "suspended"))
        r = self.client.post("/auth/login", json={"email": "judge@example.org", "password": STRONG})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(db.get_user_by_id(self.member["id"])["status_reason"], "abuse")
        blocked = self.events("auth.login_blocked")
        self.assertEqual((len(blocked), blocked[0]["email"]), (1, "judge@example.org"))
        self.assertEqual(self.act("unsuspend").json()["status"], "approved")
        self.assertEqual(self.client.get("/me/usage", headers=h).status_code, 200)
        self.assertEqual([e["type"] for e in self.events("admin.")], ["admin.unsuspend", "admin.suspend"])

    def test_pending_and_declined_accounts_reach_only_their_own_account(self):
        h = self.headers(self.member)
        for state in ("pending", "declined"):
            db.set_user_status(self.member["id"], state)
            self.assertEqual(self.client.get("/me/usage", headers=h).status_code, 200)
            r = self.client.get("/documents", headers=h)
            self.assertEqual((r.status_code, r.headers.get("X-Citely-Account")), (403, state))

    def test_the_admin_account_cannot_be_changed_or_deleted_here(self):
        self.assertEqual(self.act("suspend", target=self.admin).status_code, 400)
        r = self.client.post(f"/admin/users/{self.admin['id']}/delete", headers=self.headers(self.admin), json={"confirm": ADMIN})
        self.assertEqual(r.status_code, 400)

    def test_unsuspend_needs_a_suspended_account(self):
        self.assertEqual(self.act("unsuspend").status_code, 400)


class DeleteAccountTest(Base):
    def test_delete_removes_everything_and_needs_the_email_typed(self):
        admin_user = self.user(ADMIN)
        member = self.user("judge@example.org")
        doc = db.create_document(member["id"], "a.pdf", pages=1)
        db.create_chat_turn(doc, member["id"], "q", "a", "[]")
        db.write_state(member["id"], "catalog", "{}", 0)
        db.approve_access("judge@example.org")
        self.service.remove_document.side_effect = lambda d, o: db.delete_document(d, o)
        url, h = f"/admin/users/{member['id']}/delete", self.headers(admin_user)
        self.assertEqual(self.client.post(url, headers=h, json={"confirm": "someone@else.org"}).status_code, 400)
        r = self.client.post(url, headers=h, json={"confirm": "Judge@Example.org"})
        self.assertEqual(r.json(), {"id": member["id"], "deleted": True, "documents": 1})
        self.assertIsNone(db.get_user_by_id(member["id"]))
        counts = db.table_counts()
        for table in ("documents", "chat_turns", "user_state", "access_approvals"):
            self.assertEqual(counts[table], 0, table)
        self.assertEqual(self.client.get("/me/usage", headers=self.headers(member)).status_code, 401)
        self.assertEqual(self.events("admin.delete")[0]["detail"], '{"target": "judge@example.org", "documents": 1}')


class ActivityTest(Base):
    def setUp(self):
        super().setUp()
        self.admin = self.user(ADMIN)
        self.member = self.user("judge@example.org", password_hash=auth.hash_password(STRONG))

    def test_presence_marks_online_and_the_first_signal_records_the_visit(self):
        h = self.headers(self.member)
        tab = {"browser": "browser-1", "tab": "tab-00001"}
        with patch("APP.activity.country_of", return_value="IN"):
            self.client.post("/me/presence", headers=h, json={**tab, "state": "active", "seq": 1, "first": True, "timezone": "Asia/Kolkata", "path": "/studio.html"})
            self.client.post("/me/presence", headers=h, json={**tab, "state": "active", "seq": 2, "timezone": "Asia/Kolkata"})
        visits = self.events("session.start")
        self.assertEqual(len(visits), 1)
        self.assertEqual((visits[0]["country"], visits[0]["timezone"], visits[0]["email"]), ("IN", "Asia/Kolkata", "judge@example.org"))
        body = self.client.get("/admin/overview", headers=self.headers(self.admin)).json()
        self.assertGreaterEqual(body["users"]["online_now"], 1)
        users = self.client.get("/admin/users", headers=self.headers(self.admin)).json()["items"]
        self.assertTrue(next(u for u in users if u["email"] == "judge@example.org")["online"])

    def test_sign_ins_are_recorded_without_passwords_or_addresses(self):
        self.client.post("/auth/login", json={"email": "judge@example.org", "password": "Wrong-Password-99"})
        self.client.post("/auth/login", json={"email": "judge@example.org", "password": STRONG})
        types = [e["type"] for e in self.events("auth.")]
        self.assertEqual(types, ["auth.login", "auth.login_failed"])
        with db._connect() as conn:
            dump = " ".join(str(tuple(r)) for r in conn.execute("SELECT * FROM events"))
        self.assertNotIn(STRONG, dump)
        self.assertNotIn("testclient", dump)        # no client address stored

    def test_a_question_is_recorded_but_not_its_text(self):
        from APP.schemas import QueryResponse
        self.service.answer.return_value = QueryResponse(request_id="r", answer="secret answer", sources=[], model="m", collection_name="c")
        r = self.client.post("/query", headers=self.headers(self.member), json={"document_id": "d1", "document_ids": ["d2"], "question": "private question"})
        self.assertEqual(r.status_code, 200)
        q = self.events("question")[0]
        self.assertEqual(q["detail"], '{"documents": 2}')
        self.assertNotIn("private question", str(q))

    def test_overview_counts_uploads_questions_and_traffic_per_day(self):
        doc = db.create_document(self.member["id"], "a.pdf", pages=1)
        db.create_chat_turn(doc, self.member["id"], "q", "a", "[]")
        self.client.get("/health")
        body = self.client.get("/admin/overview", headers=self.headers(self.admin)).json()
        today = body["per_day"][-1]
        self.assertEqual((today["uploads"], today["questions"]), (1, 1))
        self.assertGreaterEqual(today["requests"], 1)
        self.assertEqual(body["environment"]["name"], "dev")
        self.assertEqual(body["limits"]["max_upload_mb"], 10)

    def test_request_counts_flush_to_the_database_and_keep_failures(self):
        counter = activity.RequestCounter()
        counter.add("/query", 200)
        counter.add("/query", 500)
        counter.add("/auth/login", 200)
        counter.flush()
        rows = {r["bucket"]: (r["requests"], r["errors"]) for r in db.api_requests_since("2000-01-01")}
        self.assertEqual(rows, {"questions": (2, 1), "auth": (2 - 1, 0)})
        counter.add("/documents", 200)
        with patch("APP.db.add_api_requests", side_effect=RuntimeError("busy")):
            counter.flush()
        self.assertEqual(sum(n for n, _ in counter.unflushed().values()), 1)   # kept for the next flush

    def test_events_never_fail_the_request_that_caused_them(self):
        with patch("APP.db.record_event", side_effect=RuntimeError("disk full")):
            r = self.client.post("/auth/login", json={"email": "judge@example.org", "password": STRONG})
        self.assertEqual(r.status_code, 200)


class DemoRequestsTest(Base):
    def test_requests_are_kept_and_approving_one_approves_the_email(self):
        admin_user = self.user(ADMIN)
        with patch("APP.main.deliver_demo_request"):
            r = self.client.post("/demo-requests", json={"name": "Asha", "email": "Asha@Example.org", "phone": "+91 98765 43210", "comment": "Judging"})
        self.assertEqual(r.status_code, 202)
        items = self.client.get("/admin/demo-requests", headers=self.headers(admin_user)).json()["items"]
        self.assertEqual((len(items), items[0]["status"], items[0]["email"]), (1, "pending", "asha@example.org"))
        r = self.client.post(f"/admin/demo-requests/{items[0]['id']}/approve", headers=self.headers(admin_user))
        self.assertEqual(r.json()["approved"], True)
        self.assertTrue(db.is_access_approved("asha@example.org"))
        self.assertEqual(db.get_demo_request(items[0]["id"])["status"], "approved")


class DatabaseAndServerTest(Base):
    def test_database_and_server_details(self):
        admin_user = self.user(ADMIN)
        self.service.qdrant.get_collection.return_value = SimpleNamespace(status="green", points_count=42, indexed_vectors_count=40, segments_count=2)
        body = self.client.get("/admin/database", headers=self.headers(admin_user)).json()
        self.assertEqual(body["database"]["engine"], "SQLite")
        self.assertEqual(body["database"]["tables"]["users"], 1)
        self.assertIn("events", body["database"]["tables"])
        self.assertEqual(body["vectors"]["points"], 42)
        server = self.client.get("/admin/server", headers=self.headers(admin_user)).json()
        self.assertEqual(server["status"], "up")
        self.assertGreaterEqual(server["uptime_seconds"], 0)
        self.assertIn("errors_24h", server)

    def test_each_environment_names_itself_from_its_public_address(self):
        for url, name in (("https://citely.example/", "prod"), ("https://dev.citely.example/", "dev"),
                          ("https://citely.example/dev/", "dev"), ("https://citely.example/hack/", "hack"), ("", "local")):
            with patch.dict(os.environ, {"APP_PUBLIC_URL": url}):
                self.assertEqual(admin._environment()["name"], name, url)

    def test_account_detail_says_how_they_sign_in_without_the_password_hash(self):
        admin_user = self.user(ADMIN)
        member = db.get_user_by_id(db.create_user("member@example.org", password_hash=auth.hash_password(STRONG), email_verified=True))
        body = self.client.get(f"/admin/users/{member['id']}", headers=self.headers(admin_user)).json()
        self.assertTrue(body["user"]["has_password"])
        self.assertNotIn("password_hash", body["user"])

    def test_a_missing_country_database_is_reported_on_the_server_page(self):
        admin_user = self.user(ADMIN)
        activity._geo_reader.cache_clear()
        self.addCleanup(activity._geo_reader.cache_clear)
        with patch.object(activity, "GEO_DB", str(self.tmp / "missing.mmdb")):
            lookup = self.client.get("/admin/server", headers=self.headers(admin_user)).json()["country_lookup"]
        self.assertFalse(lookup["loaded"])
        self.assertIn("not found", lookup["error"])

    def test_an_unreachable_vector_store_is_reported_not_hidden(self):
        admin_user = self.user(ADMIN)
        self.service.qdrant.get_collection.side_effect = ConnectionError("qdrant timed out")
        body = self.client.get("/admin/database", headers=self.headers(admin_user)).json()
        self.assertEqual(body["vectors"]["status"], "error")
        self.assertEqual(body["vectors"]["error"], "ConnectionError: qdrant timed out")
        self.assertEqual(body["database"]["tables"]["users"], 1)       # the rest of the page still answers


class SamplesTest(Base):
    def setUp(self):
        super().setUp()
        self.admin = self.user(ADMIN)
        self.member = self.user("judge@example.org")

    def add(self, name, data=b"PK\x03\x04 sample bytes", who=None):
        return self.client.post("/admin/samples", headers=self.headers(who or self.admin), files={"file": (name, io.BytesIO(data))})

    def test_admin_adds_samples_sorted_by_type_and_members_see_them(self):
        self.assertEqual(self.add("Board update.pptx").json()["kind"], "PPTX")
        self.assertEqual(self.add("Annual report.docx").json()["kind"], "DOCX")
        self.assertEqual(self.add("Q3.pdf", b"%PDF-1.7 x").json()["kind"], "PDF")
        self.assertEqual(self.add("notes.exe").status_code, 400)
        self.assertEqual(self.add("x.pdf", who=self.member).status_code, 403)
        groups = self.client.get("/samples", headers=self.headers(self.member)).json()["groups"]
        self.assertEqual([g["kind"] for g in groups], ["DOCX", "PDF", "PPTX"])
        self.assertNotIn("path", groups[0]["items"][0])

    def test_using_a_sample_is_a_normal_upload_and_counts(self):
        sample = self.add("Q3.pdf", b"%PDF-1.7 x").json()
        seen = {}

        def ingest(**kw):
            seen.update(kw)
            return SimpleNamespace(model_dump=lambda: {"document_id": "doc", "pages": 1}, file_type="pdf", pages=1)
        self.service.ingest.side_effect = ingest
        with patch("APP.usage.page_count", return_value=1):
            r = self.client.post(f"/samples/{sample['id']}/use", headers=self.headers(self.member))
        self.assertEqual(r.status_code, 202)
        for _ in range(100):
            if self.client.get("/me/usage", headers=self.headers(self.member)).json()["uploads"]["used"] == 1 and seen:
                break
            time.sleep(0.02)
        self.assertEqual(seen["filename"], "Q3.pdf")
        self.assertEqual(seen["raw_bytes"], b"%PDF-1.7 x")
        self.assertEqual(self.client.get("/me/usage", headers=self.headers(self.member)).json()["uploads"]["used"], 1)
        for _ in range(50):
            if self.events("upload"):
                break
            time.sleep(0.02)
        self.assertIn('"source": "sample"', self.events("upload")[0]["detail"])

    def test_rename_and_delete(self):
        sample = self.add("Q3.pdf", b"%PDF-1.7 x").json()
        h = self.headers(self.admin)
        self.assertEqual(self.client.post(f"/admin/samples/{sample['id']}/rename", headers=h, json={"name": "Quarterly"}).json()["name"], "Quarterly")
        folder = admin.SAMPLES_DIR / sample["id"]
        self.assertTrue(folder.exists())
        self.assertEqual(self.client.post(f"/admin/samples/{sample['id']}/delete", headers=h).status_code, 200)
        self.assertFalse(folder.exists())
        self.assertEqual(self.client.post(f"/samples/{sample['id']}/use", headers=self.headers(self.member)).status_code, 404)


if __name__ == "__main__":
    unittest.main()
