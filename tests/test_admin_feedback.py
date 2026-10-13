"""Admin feedback batch: editable usage limits (total or per day), admin-sent
password resets, real online status, members-only user list, temporary
addresses refused on every way in, and admin emails that don't hold up the
request."""

import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from APP import auth, db, usage
from tests.test_admin import ADMIN, STRONG, Base

LIMITS = {"enabled": True, "uploads": 2, "questions": 4, "period": "daily", "daily_uploads": 100,
          "daily_questions": 100, "max_upload_mb": 10, "max_pages": 200}


class LimitsTest(Base):
    def setUp(self):
        super().setUp()
        self.admin = self.user(ADMIN)
        self.member = self.user("member@example.org")

    def test_admin_reads_defaults_then_saves_limits_that_apply_at_once(self):
        h = self.headers(self.admin)
        body = self.client.get("/admin/limits", headers=h).json()
        self.assertFalse(body["saved"])
        self.assertEqual(body["limits"]["period"], "total")
        saved = self.client.put("/admin/limits", headers=h, json=LIMITS).json()
        self.assertEqual(saved["limits"], LIMITS)
        self.assertTrue(self.client.get("/admin/limits", headers=h).json()["saved"])
        self.assertEqual(usage.limits()[usage.UPLOAD]["account"], 2)          # no restart needed
        change = json.loads(self.events("admin.limits_changed")[0]["detail"])
        self.assertEqual(change["period"], "total → daily")

    def test_bad_values_are_refused(self):
        h = self.headers(self.admin)
        for bad in ({**LIMITS, "period": "weekly"}, {**LIMITS, "uploads": -1}, {**LIMITS, "max_upload_mb": 0}):
            self.assertEqual(self.client.put("/admin/limits", headers=h, json=bad).status_code, 422)

    def test_a_daily_account_limit_resets_the_next_day(self):
        usage.save_settings(LIMITS)
        with patch.object(usage, "today", return_value="2026-10-11"):
            usage.reserve(self.member, usage.UPLOAD)
            usage.reserve(self.member, usage.UPLOAD)
            with self.assertRaises(db.UsageLimitReached):
                usage.reserve(self.member, usage.UPLOAD)
            snap = usage.snapshot(self.member)
            self.assertEqual((snap["period"], snap["uploads"]["remaining"]), ("daily", 0))
            self.assertIn("reset tomorrow", usage.message(usage.UPLOAD, "account"))
        with patch.object(usage, "today", return_value="2026-10-12"):
            self.assertEqual(usage.reserve(self.member, usage.UPLOAD), "2026-10-12")
            self.assertEqual(usage.snapshot(self.member)["uploads"]["remaining"], 1)

    def test_a_total_account_limit_never_resets(self):
        usage.save_settings({**LIMITS, "period": "total"})
        with patch.object(usage, "today", return_value="2026-10-11"):
            usage.reserve(self.member, usage.UPLOAD)
            usage.reserve(self.member, usage.UPLOAD)
        with patch.object(usage, "today", return_value="2026-10-12"), self.assertRaises(db.UsageLimitReached):
            usage.reserve(self.member, usage.UPLOAD)

    def test_members_cannot_change_limits(self):
        self.assertEqual(self.client.put("/admin/limits", headers=self.headers(self.member), json=LIMITS).status_code, 403)


class AdminPasswordResetTest(Base):
    def test_the_admin_sends_a_reset_link_and_never_sees_the_password(self):
        admin = self.user(ADMIN)
        member = db.get_user_by_id(db.create_user("member@acme-corp.example", password_hash=auth.hash_password(STRONG), email_verified=True))
        with patch("APP.admin.mail.send_password_reset_email") as send:
            r = self.client.post(f"/admin/users/{member['id']}/password-reset", headers=self.headers(admin))
        self.assertEqual(r.json(), {"id": member["id"], "sent_to": "member@acme-corp.example"})
        to, token = send.call_args.args
        self.assertEqual(to, "member@acme-corp.example")
        new = "Another-Harbor-81y"
        done = self.client.post("/auth/reset-password", json={"email": to, "token": token, "new_password": new})
        self.assertEqual(done.status_code, 200)
        self.assertEqual(self.events("admin.password_reset")[0]["detail"], '{"target": "member@acme-corp.example"}')

    def test_accounts_without_a_password_have_nothing_to_reset(self):
        admin, oauth = self.user(ADMIN), self.user("someone@acme-corp.example")
        r = self.client.post(f"/admin/users/{oauth['id']}/password-reset", headers=self.headers(admin))
        self.assertEqual(r.status_code, 400)
        self.assertIn("Google or GitHub", r.json()["detail"])


class MembersListTest(Base):
    def test_the_members_list_leaves_out_pending_and_declined(self):
        admin = self.user(ADMIN)
        self.user("member@example.org")
        db.create_user("waiting@example.org", email_verified=True, status="pending")
        db.create_user("no@example.org", email_verified=True, status="declined")
        h = self.headers(admin)
        members = {u["email"] for u in self.client.get("/admin/users?status=members", headers=h).json()["items"]}
        self.assertEqual(members, {ADMIN, "member@example.org"})
        declined = [u["email"] for u in self.client.get("/admin/users?status=declined", headers=h).json()["items"]]
        self.assertEqual(declined, ["no@example.org"])
        self.assertEqual(self.client.get("/admin/overview", headers=h).json()["users"]["members"], 2)


class TemporaryAddressTest(Base):
    def test_google_cannot_create_an_account_for_a_temporary_address(self):
        with patch("APP.main.auth.exchange_google_code", return_value={"email": "x@calirona.com", "provider_user_id": "g1"}):
            r = self.client.post("/auth/google/callback", json={"code": "c", "redirect_uri": "https://citely.example/auth/callback/"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("Temporary or disposable", r.json()["detail"])
        self.assertIsNone(db.get_user_by_email("x@calirona.com"))
        self.assertEqual(self.events("auth.signup_refused")[0]["email"], "x@calirona.com")


class AdminEmailSpeedTest(Base):
    def test_declining_does_not_wait_for_the_email_service(self):
        admin = self.user(ADMIN)
        pending = db.get_user_by_id(db.create_user("waiting@example.org", email_verified=True, status="pending"))
        with patch("APP.auth.email.send_message") as send:
            r = self.client.post(f"/admin/users/{pending['id']}/status", headers=self.headers(admin), json={"action": "decline"})
        self.assertEqual(r.json()["status"], "declined")
        self.assertIs(send.call_args.kwargs["wait"], False)


if __name__ == "__main__":
    unittest.main()


class UnverifiedAnswerTest(Base):
    def test_an_answer_that_fails_the_evidence_check_does_not_use_up_a_question(self):
        from APP.rag.evidence import UNVERIFIED_ANSWER
        from APP import usage
        from APP.schemas import QueryResponse
        usage.save_settings({"enabled": True, "uploads": 3, "questions": 2, "period": "total", "daily_uploads": 100,
                             "daily_questions": 100, "max_upload_mb": 10, "max_pages": 200})
        member = self.user("member@example.org")
        h = self.headers(member)
        def respond(answer):
            return QueryResponse(request_id="r", answer=answer, sources=[], model="m", collection_name="c")
        body = {"document_id": "d1", "question": "give me a detailed summary"}
        self.service.answer.return_value = respond(UNVERIFIED_ANSWER)
        for _ in range(4):                                             # more failures than the limit of 2
            self.assertEqual(self.client.post("/query", headers=h, json=body).status_code, 200)
        self.assertEqual(usage.snapshot(member)["questions"]["remaining"], 2)
        self.assertEqual(len(self.events("question.unverified")), 4)
        self.service.answer.return_value = respond("A real answer [1]")
        for _ in range(2):
            self.assertEqual(self.client.post("/query", headers=h, json=body).status_code, 200)
        self.assertEqual(self.client.post("/query", headers=h, json=body).status_code, 429)   # real answers still count


class UnansweredAndResetTest(Base):
    LIMITS = {"enabled": True, "uploads": 3, "questions": 2, "period": "total", "daily_uploads": 100,
              "daily_questions": 100, "max_upload_mb": 10, "max_pages": 200}
    BODY = {"document_id": "d1", "question": "what is the price of the enterprise plan"}

    def respond(self, answer):
        from APP.schemas import QueryResponse
        return QueryResponse(request_id="r", answer=answer, sources=[], model="m", collection_name="c")

    def test_not_enough_information_is_given_back_too_but_not_without_limit(self):
        from APP.rag.evidence import LIMITED_CONTEXT
        from APP.main import FREE_UNANSWERED_PER_DAY
        usage.save_settings({**self.LIMITS, "questions": 50})
        member = self.user("member@example.org")
        h = self.headers(member)
        self.service.answer.return_value = self.respond(LIMITED_CONTEXT)
        for _ in range(FREE_UNANSWERED_PER_DAY):
            self.assertEqual(self.client.post("/query", headers=h, json=self.BODY).status_code, 200)
        self.assertEqual(usage.snapshot(member)["questions"]["used"], 0)                 # all given back
        self.client.post("/query", headers=h, json=self.BODY)                              # one more than the daily allowance of free tries
        self.assertEqual(usage.snapshot(member)["questions"]["used"], 1)
        events = self.events("question.unanswered")
        self.assertEqual(len(events), FREE_UNANSWERED_PER_DAY + 1)
        self.assertIn('"refunded": false', events[0]["detail"])

    def test_the_admin_resets_one_account_and_nobody_elses(self):
        admin = self.user(ADMIN)
        a, b = self.user("a@example.org"), self.user("b@example.org")
        usage.save_settings(self.LIMITS)
        for who in (a, b):
            usage.reserve(who, usage.UPLOAD); usage.reserve(who, usage.UPLOAD); usage.reserve(who, usage.QUESTION)
        before = db.usage_counts("", usage.today())["daily"]
        r = self.client.post(f"/admin/users/{a['id']}/reset-usage", headers=self.headers(admin))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["cleared"]["total"], {"upload": 2, "question": 1})
        self.assertEqual(usage.snapshot(a)["uploads"]["remaining"], 3)
        self.assertEqual(usage.snapshot(a)["questions"]["remaining"], 2)
        self.assertEqual(usage.snapshot(b)["uploads"]["remaining"], 1)                      # untouched
        after = db.usage_counts("", usage.today())["daily"]
        self.assertEqual((after["upload"], after["question"]), (before["upload"] - 2, before["question"] - 1))   # the site-wide count gets it back too
        detail = self.client.get(f"/admin/users/{b['id']}", headers=self.headers(admin)).json()
        self.assertEqual(detail["usage"]["total"], {"upload": 2, "question": 1})
        self.assertEqual(json.loads(self.events("admin.usage_reset")[0]["detail"])["target"], "a@example.org")

    def test_only_the_admin_can_reset_and_unknown_accounts_are_404(self):
        member = self.user("member@example.org")
        self.assertEqual(self.client.post(f"/admin/users/{member['id']}/reset-usage", headers=self.headers(member)).status_code, 403)
        admin = self.user(ADMIN)
        self.assertEqual(self.client.post("/admin/users/nobody/reset-usage", headers=self.headers(admin)).status_code, 404)


class SharedDailyResetTest(Base):
    LIMITS = {"enabled": True, "uploads": 3, "questions": 5, "period": "total", "daily_uploads": 100,
              "daily_questions": 10, "max_upload_mb": 10, "max_pages": 200}

    def test_a_reset_says_how_much_the_shared_daily_limit_still_allows_and_that_can_be_cleared(self):
        admin = self.user(ADMIN)
        usage.save_settings(self.LIMITS)
        target = self.user("target@example.org")
        others = [self.user(f"o{i}@example.org") for i in range(4)]
        for who in others:                                   # 8 of the shared 10 questions used by others
            usage.reserve(who, usage.QUESTION); usage.reserve(who, usage.QUESTION)
        usage.reserve(target, usage.QUESTION)
        r = self.client.post(f"/admin/users/{target['id']}/reset-usage", headers=self.headers(admin)).json()
        self.assertEqual(r["shared"]["question"], {"used": 8, "limit": 10, "left": 2})
        snap = usage.snapshot(target)["questions"]
        self.assertEqual((snap["used"], snap["remaining"]), (0, 2))          # the account is reset; the shared limit holds it to 2
        r = self.client.post("/admin/limits/reset-today", headers=self.headers(admin))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["cleared"]["question"], 8)
        self.assertEqual(usage.snapshot(target)["questions"]["remaining"], 5)
        self.assertEqual(usage.snapshot(others[0])["questions"]["used"], 2)  # accounts' own counts untouched
        self.assertEqual(len(self.events("admin.daily_reset")), 1)

    def test_only_the_admin_can_clear_the_shared_count(self):
        member = self.user("member@example.org")
        self.assertEqual(self.client.post("/admin/limits/reset-today", headers=self.headers(member)).status_code, 403)
