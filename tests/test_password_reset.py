"""Password reset: atomic consumption+expiry, session invalidation via
token_version, enumeration safety (including the OAuth-only case), and rate
limiting. No auth-route test coverage existed before this file, so this also
establishes the pattern for pointing APP.db at a throwaway SQLite file rather
than the real data/rag.db.
"""

import os
from unittest.mock import patch

import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

import APP.auth as auth
import APP.db as db
import APP.main as main_module
from APP.main import app


class _FakeRagService:
    """Stands in for the real RAGService so hitting /documents (used to
    exercise get_current_user's token_version check) never lazily constructs
    a real one, which would try to reach Qdrant.
    """

    def list_documents(self, owner_id):
        return []


class PasswordResetTestBase(unittest.TestCase):
    def setUp(self):
        # Tests must not depend on a developer's .env or a production secret.
        jwt_env = patch.dict(os.environ, {"JWT_SECRET_KEY": "citely-tests-only-signing-key-never-for-deployment"})
        jwt_env.start()
        self.addCleanup(jwt_env.stop)
        self._tmpdir = tempfile.TemporaryDirectory()
        self._original_db_path = db.DB_PATH
        db.DB_PATH = Path(self._tmpdir.name) / "test.db"
        db.init_db()
        app.state.rag_service = _FakeRagService()

        self.sent_reset_emails: list[tuple[str, str]] = []
        self.sent_oauth_notices: list[str] = []
        self._original_send_reset = main_module.otp_email.send_password_reset_email
        self._original_send_oauth_notice = main_module.otp_email.send_oauth_only_reset_notice
        main_module.otp_email.send_password_reset_email = (
            lambda to, token: self.sent_reset_emails.append((to, token))
        )
        main_module.otp_email.send_oauth_only_reset_notice = (
            lambda to: self.sent_oauth_notices.append(to)
        )

        main_module._reset_last_sent.clear()
        main_module.limiter.reset()
        self.client = TestClient(app)

    def tearDown(self):
        main_module.otp_email.send_password_reset_email = self._original_send_reset
        main_module.otp_email.send_oauth_only_reset_notice = self._original_send_oauth_notice
        db.DB_PATH = self._original_db_path
        self._tmpdir.cleanup()

    def _create_password_user(self, email="user@gmail.com", password="hunter2222"):
        user_id = db.create_user(email, password_hash=auth.hash_password(password), email_verified=True)
        return user_id

    def _create_oauth_user(self, email="oauth@gmail.com"):
        return db.get_or_create_user_for_oauth(email, "github", "gh-provider-id-123")

    def _request_reset(self, email):
        return self.client.post("/auth/request-password-reset", json={"email": email})

    def _latest_token_for(self, email):
        """Test-only helper: pulls the plaintext token back out via the
        stubbed send function rather than the (hashed) DB row, exactly as a
        real user would receive it via email.
        """
        for sent_email, token in reversed(self.sent_reset_emails):
            if sent_email == email:
                return token
        raise AssertionError(f"no reset email recorded for {email}")


class DbLayerTests(PasswordResetTestBase):
    """Exercises APP.db.reset_password_with_token directly, independent of
    the HTTP layer, since it's the piece carrying the atomicity/expiry
    guarantees.
    """

    def test_valid_token_resets_password_and_bumps_token_version(self):
        user_id = self._create_password_user()
        token = auth.generate_reset_token()
        db.create_password_reset_token(user_id, auth.hash_reset_token(token))

        ok = db.reset_password_with_token(user_id, auth.hash_reset_token(token), auth.hash_password("newpassword1"))
        self.assertTrue(ok)

        user = db.get_user_by_id(user_id)
        self.assertTrue(auth.verify_password("newpassword1", user["password_hash"]))
        self.assertEqual(user["token_version"], 1)

    def test_expired_token_rejected_and_leaves_state_unchanged(self):
        user_id = self._create_password_user(password="originalpassword1")
        original_hash = db.get_user_by_id(user_id)["password_hash"]
        token = auth.generate_reset_token()
        # ttl_minutes=0 with `expires_at > now` in the consuming query means
        # this row is already expired the instant it's created.
        db.create_password_reset_token(user_id, auth.hash_reset_token(token), ttl_minutes=0)
        time.sleep(0.01)

        ok = db.reset_password_with_token(user_id, auth.hash_reset_token(token), auth.hash_password("newpassword1"))
        self.assertFalse(ok)

        user = db.get_user_by_id(user_id)
        self.assertEqual(user["token_version"], 0)
        self.assertEqual(user["password_hash"], original_hash)

    def test_already_consumed_token_rejected(self):
        user_id = self._create_password_user()
        token = auth.generate_reset_token()
        token_hash = auth.hash_reset_token(token)
        db.create_password_reset_token(user_id, token_hash)

        first = db.reset_password_with_token(user_id, token_hash, auth.hash_password("newpassword1"))
        second = db.reset_password_with_token(user_id, token_hash, auth.hash_password("newpassword2"))
        self.assertTrue(first)
        self.assertFalse(second)

        user = db.get_user_by_id(user_id)
        self.assertEqual(user["token_version"], 1)  # only the first reset counted
        self.assertTrue(auth.verify_password("newpassword1", user["password_hash"]))

    def test_wrong_token_rejected(self):
        user_id = self._create_password_user()
        db.create_password_reset_token(user_id, auth.hash_reset_token(auth.generate_reset_token()))

        ok = db.reset_password_with_token(
            user_id, auth.hash_reset_token("not-the-real-token"), auth.hash_password("newpassword1")
        )
        self.assertFalse(ok)

    def test_sibling_tokens_invalidated_on_successful_reset(self):
        user_id = self._create_password_user()
        old_token = auth.generate_reset_token()
        new_token = auth.generate_reset_token()
        db.create_password_reset_token(user_id, auth.hash_reset_token(old_token))
        db.create_password_reset_token(user_id, auth.hash_reset_token(new_token))

        ok = db.reset_password_with_token(
            user_id, auth.hash_reset_token(new_token), auth.hash_password("newpassword1")
        )
        self.assertTrue(ok)

        # The older, never-clicked token must no longer work.
        still_valid = db.reset_password_with_token(
            user_id, auth.hash_reset_token(old_token), auth.hash_password("newpassword2")
        )
        self.assertFalse(still_valid)


class SessionInvalidationTests(PasswordResetTestBase):
    def test_legacy_claim_less_jwt_accepted_before_reset_and_rejected_after(self):
        user_id = self._create_password_user()
        # Hand-encode a token with no `tv` claim, simulating one issued
        # before token_version existed.
        legacy_token = self._encode_legacy(user_id)

        headers = {"Authorization": f"Bearer {legacy_token}"}
        before = self.client.get("/documents", headers=headers)
        self.assertEqual(before.status_code, 200)

        token = auth.generate_reset_token()
        db.create_password_reset_token(user_id, auth.hash_reset_token(token))
        db.reset_password_with_token(user_id, auth.hash_reset_token(token), auth.hash_password("newpassword1"))

        after = self.client.get("/documents", headers=headers)
        self.assertEqual(after.status_code, 401)

    def test_current_token_rejected_after_reset(self):
        user_id = self._create_password_user()
        user = db.get_user_by_id(user_id)
        current_token = auth.create_access_token(user_id, user["token_version"])
        headers = {"Authorization": f"Bearer {current_token}"}

        before = self.client.get("/documents", headers=headers)
        self.assertEqual(before.status_code, 200)

        token = auth.generate_reset_token()
        db.create_password_reset_token(user_id, auth.hash_reset_token(token))
        db.reset_password_with_token(user_id, auth.hash_reset_token(token), auth.hash_password("newpassword1"))

        after = self.client.get("/documents", headers=headers)
        self.assertEqual(after.status_code, 401)

    @staticmethod
    def _encode_legacy(user_id: str) -> str:
        import os

        import jwt

        secret = os.environ["JWT_SECRET_KEY"]
        return jwt.encode({"sub": user_id}, secret, algorithm="HS256")


class RouteEnumerationSafetyTests(PasswordResetTestBase):
    def test_unknown_and_oauth_only_responses_are_identical(self):
        self._create_oauth_user("oauthonly@gmail.com")

        unknown_resp = self._request_reset("no-such-account@gmail.com")
        main_module._reset_last_sent.clear()
        main_module.limiter.reset()
        oauth_resp = self._request_reset("oauthonly@gmail.com")

        self.assertEqual(unknown_resp.status_code, oauth_resp.status_code)
        self.assertEqual(unknown_resp.json(), oauth_resp.json())

    def test_password_account_gets_same_response_shape(self):
        self._create_password_user("haspassword@gmail.com")
        resp = self._request_reset("haspassword@gmail.com")
        self.assertEqual(resp.status_code, 202)
        self.assertEqual(resp.json(), {"detail": "If that account exists, a password reset email has been sent"})

    def test_password_account_actually_gets_a_reset_email_oauth_does_not(self):
        self._create_password_user("realuser@gmail.com")
        self._create_oauth_user("oauthuser@gmail.com")

        self._request_reset("realuser@gmail.com")
        main_module._reset_last_sent.clear()
        main_module.limiter.reset()
        self._request_reset("oauthuser@gmail.com")

        self.assertEqual(len(self.sent_reset_emails), 1)
        self.assertEqual(self.sent_reset_emails[0][0], "realuser@gmail.com")
        self.assertEqual(self.sent_oauth_notices, ["oauthuser@gmail.com"])

    def test_work_addresses_are_reset_by_the_admin_and_the_answer_reveals_nothing(self):
        # Self-service reset is for personal addresses; a work account's
        # password is reset from the admin console. The answer depends only
        # on the address, so it says nothing about whether an account exists.
        self._create_password_user("member@acme-corp.example")
        existing = self._request_reset("member@acme-corp.example")
        main_module._reset_last_sent.clear()
        main_module.limiter.reset()
        unknown = self._request_reset("nobody@acme-corp.example")
        self.assertEqual(existing.status_code, 202)
        self.assertEqual(existing.json(), unknown.json())
        self.assertTrue(existing.json()["admin_reset"])
        self.assertIn("Citely administrator", existing.json()["detail"])
        self.assertEqual(self.sent_reset_emails, [])

    def test_unknown_email_sends_nothing(self):
        self._request_reset("nobody@gmail.com")
        self.assertEqual(self.sent_reset_emails, [])
        self.assertEqual(self.sent_oauth_notices, [])


class RateLimitingTests(PasswordResetTestBase):
    def test_repeated_requests_are_rate_limited(self):
        self._create_password_user("ratelimited@gmail.com")
        statuses = [self._request_reset("ratelimited@gmail.com").status_code for _ in range(8)]
        self.assertIn(429, statuses)


class FullRoundTripTests(PasswordResetTestBase):
    def test_request_then_reset_then_sign_in_with_new_password(self):
        email = "roundtrip@gmail.com"
        self._create_password_user(email, password="originalpass1")

        req = self._request_reset(email)
        self.assertEqual(req.status_code, 202)
        token = self._latest_token_for(email)

        reset_resp = self.client.post(
            "/auth/reset-password",
            json={"email": email, "token": token, "new_password": "Velvet-Harbor-73x"},
        )
        self.assertEqual(reset_resp.status_code, 200)
        # No auto-sign-in: the success response carries no access token.
        self.assertNotIn("access_token", reset_resp.json())

        old_login = self.client.post("/auth/login", json={"email": email, "password": "originalpass1"})
        self.assertEqual(old_login.status_code, 401)

        new_login = self.client.post("/auth/login", json={"email": email, "password": "Velvet-Harbor-73x"})
        self.assertEqual(new_login.status_code, 200)
        self.assertIn("access_token", new_login.json())

    def test_reused_token_rejected_via_http(self):
        email = "reuse@gmail.com"
        self._create_password_user(email, password="originalpass1")
        self._request_reset(email)
        token = self._latest_token_for(email)

        first = self.client.post(
            "/auth/reset-password", json={"email": email, "token": token, "new_password": "Copper-Lantern-58q"}
        )
        second = self.client.post(
            "/auth/reset-password", json={"email": email, "token": token, "new_password": "Granite-Willow-29k"}
        )
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 400)

    def test_expired_token_rejected_via_http(self):
        email = "expired@gmail.com"
        user_id = self._create_password_user(email, password="originalpass1")
        token = auth.generate_reset_token()
        db.create_password_reset_token(user_id, auth.hash_reset_token(token), ttl_minutes=0)
        time.sleep(0.01)

        resp = self.client.post(
            "/auth/reset-password", json={"email": email, "token": token, "new_password": "Copper-Lantern-58q"}
        )
        self.assertEqual(resp.status_code, 400)


if __name__ == "__main__":
    unittest.main()
