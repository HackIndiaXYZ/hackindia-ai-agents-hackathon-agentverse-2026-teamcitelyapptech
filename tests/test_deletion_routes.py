"""Route-level checks for the new deletion endpoints: auth is required,
ownership is enforced server-side, and each route actually reaches the db
function it's supposed to — the unit tests in test_annotations.py cover the
db layer directly, this covers the HTTP wiring on top of it.
"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import APP.auth as auth
import APP.db as db
from APP.main import app


class _FakeRagService:
    def list_documents(self, owner_id):
        return []

    def get_document_pages(self, document_id, owner_id):
        return []


class DeletionRouteTests(unittest.TestCase):
    def setUp(self):
        jwt_env = patch.dict(os.environ, {"JWT_SECRET_KEY": "citely-tests-only-signing-key-never-for-deployment"})
        jwt_env.start()
        self.addCleanup(jwt_env.stop)
        self._tmpdir = tempfile.TemporaryDirectory()
        self._original_db_path = db.DB_PATH
        db.DB_PATH = Path(self._tmpdir.name) / "test.db"
        db.init_db()
        app.state.rag_service = _FakeRagService()
        self.client = TestClient(app)

        self.owner_id = db.create_user("owner@example.com", email_verified=True)
        self.other_id = db.create_user("other@example.com", email_verified=True)
        self.document_id = db.create_document(self.owner_id, "report.pdf", pages=3)
        self.conversation_id = "org:" + self.document_id

    def tearDown(self):
        db.DB_PATH = self._original_db_path

    def auth_headers(self, user_id):
        token = auth.create_access_token(user_id, db.get_user_by_id(user_id)["token_version"])
        return {"Authorization": f"Bearer {token}"}

    # --- annotations -------------------------------------------------- #

    def test_delete_conversation_annotations_requires_auth(self):
        response = self.client.delete(f"/conversations/{self.conversation_id}/annotations")
        self.assertEqual(response.status_code, 401)

    def test_delete_conversation_annotations_removes_only_owners_own(self):
        db.create_annotation(
            self.owner_id, workspace_id="org", conversation_id=self.conversation_id,
            document_id=self.document_id, kind="citation", page_number=1, quote="q",
        )
        response = self.client.delete(
            f"/conversations/{self.conversation_id}/annotations", headers=self.auth_headers(self.owner_id)
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"deleted": 1})
        self.assertEqual(db.list_annotations(self.owner_id, self.conversation_id), [])

    def test_delete_conversation_annotations_cannot_be_triggered_by_another_user(self):
        db.create_annotation(
            self.owner_id, workspace_id="org", conversation_id=self.conversation_id,
            document_id=self.document_id, kind="citation", page_number=1, quote="q",
        )
        response = self.client.delete(
            f"/conversations/{self.conversation_id}/annotations", headers=self.auth_headers(self.other_id)
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"deleted": 0})
        self.assertEqual(len(db.list_annotations(self.owner_id, self.conversation_id)), 1)

    # --- notes ---------------------------------------------------------#

    def test_delete_note_route(self):
        self.client.put(
            f"/conversations/{self.conversation_id}/notes",
            json={"content": "hello", "expected_revision": 0, "workspace_id": "org"},
            headers=self.auth_headers(self.owner_id),
        )
        response = self.client.delete(
            f"/conversations/{self.conversation_id}/notes", headers=self.auth_headers(self.owner_id)
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"deleted": True})
        self.assertIsNone(db.get_note(self.owner_id, self.conversation_id))

    def test_delete_note_requires_auth(self):
        response = self.client.delete(f"/conversations/{self.conversation_id}/notes")
        self.assertEqual(response.status_code, 401)

    # --- history ---------------------------------------------------------#

    def test_delete_history_clears_turns_but_not_the_document(self):
        db.create_chat_turn(self.document_id, self.owner_id, "q", "a", "[]")
        response = self.client.delete(
            f"/documents/{self.document_id}/history", headers=self.auth_headers(self.owner_id)
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"deleted": 1})
        self.assertEqual(db.list_chat_turns(self.document_id, self.owner_id), [])
        self.assertIsNotNone(db.get_document(self.document_id, self.owner_id))

    def test_delete_history_for_unowned_document_is_404(self):
        response = self.client.delete(
            f"/documents/{self.document_id}/history", headers=self.auth_headers(self.other_id)
        )
        self.assertEqual(response.status_code, 404)

    def test_delete_history_requires_auth(self):
        response = self.client.delete(f"/documents/{self.document_id}/history")
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
