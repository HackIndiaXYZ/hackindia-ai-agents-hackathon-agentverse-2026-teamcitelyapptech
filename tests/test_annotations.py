"""Saved evidence and notes must survive reload, and must not silently
overwrite each other.

Highlights and kept citations previously lived only in browser storage, so
they vanished on another device and could not be attributed to anyone. Notes
were a single overwritable value, so two writers lost each other's work.
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from APP import db


class AnnotationStoreTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        patcher = patch.object(db, "DB_PATH", Path(self._dir.name) / "test.db")
        patcher.start()
        self.addCleanup(patcher.stop)
        db.init_db()
        self.owner = db.create_user("owner@example.com")
        self.other = db.create_user("other@example.com")
        self.document = db.create_document(self.owner, "report.pdf", pages=4)

    def annotate(self, **overrides):
        payload = dict(
            workspace_id="ws-1", conversation_id="conv-1", document_id=self.document,
            kind="citation", page_number=2, quote="Revenue increased by 24%.",
            page_char_start=34, page_char_end=182, extraction_version="1",
        )
        payload.update(overrides)
        return db.create_annotation(self.owner, **payload)

    def test_saved_annotation_is_readable_after_reload(self):
        created = self.annotate()
        rows = db.list_annotations(self.owner, "conv-1")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], created["id"])
        # The exact range is what makes the highlight precise rather than page-wide.
        self.assertEqual((rows[0]["page_char_start"], rows[0]["page_char_end"]), (34, 182))
        self.assertEqual(rows[0]["extraction_version"], "1")

    def test_annotations_are_scoped_to_their_owner(self):
        self.annotate()
        self.assertEqual(db.list_annotations(self.other, "conv-1"), [])

    def test_removal_persists(self):
        created = self.annotate()
        self.assertTrue(db.delete_annotation(created["id"], self.owner))
        self.assertEqual(db.list_annotations(self.owner, "conv-1"), [])

    def test_another_user_cannot_delete_someone_elses_annotation(self):
        created = self.annotate()
        self.assertFalse(db.delete_annotation(created["id"], self.other))
        self.assertEqual(len(db.list_annotations(self.owner, "conv-1")), 1)

    def test_citations_and_manual_highlights_coexist(self):
        self.annotate(kind="citation", citation_id="cit-1")
        self.annotate(kind="manual-highlight", page_char_start=200, page_char_end=260)
        kinds = {r["kind"] for r in db.list_annotations(self.owner, "conv-1")}
        self.assertEqual(kinds, {"citation", "manual-highlight"})

    def test_deleting_the_document_removes_its_annotations(self):
        self.annotate()
        db.delete_document(self.document, self.owner)
        self.assertEqual(db.list_annotations(self.owner, "conv-1"), [])

    def test_deleting_a_conversation_leaves_other_conversations_on_the_same_document_alone(self):
        self.annotate(conversation_id="conv-1")
        self.annotate(conversation_id="conv-2")
        removed = db.delete_annotations_for_conversation("conv-1", self.owner)
        self.assertEqual(removed, 1)
        self.assertEqual(db.list_annotations(self.owner, "conv-1"), [])
        self.assertEqual(len(db.list_annotations(self.owner, "conv-2")), 1)


class NoteRevisionTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        patcher = patch.object(db, "DB_PATH", Path(self._dir.name) / "test.db")
        patcher.start()
        self.addCleanup(patcher.stop)
        db.init_db()
        self.owner = db.create_user("owner@example.com")

    def test_first_save_creates_revision_one(self):
        saved = db.save_note(self.owner, "conv-1", "ws-1", "First thoughts", 0)
        self.assertEqual(saved["revision"], 1)
        self.assertEqual(db.get_note(self.owner, "conv-1")["content"], "First thoughts")

    def test_sequential_saves_advance_the_revision(self):
        db.save_note(self.owner, "conv-1", "ws-1", "one", 0)
        second = db.save_note(self.owner, "conv-1", "ws-1", "two", 1)
        self.assertEqual(second["revision"], 2)

    def test_stale_revision_is_rejected_rather_than_overwriting(self):
        db.save_note(self.owner, "conv-1", "ws-1", "mine", 0)
        db.save_note(self.owner, "conv-1", "ws-1", "theirs", 1)
        # A writer still holding revision 1 must not clobber revision 2.
        self.assertIsNone(db.save_note(self.owner, "conv-1", "ws-1", "stale", 1))
        self.assertEqual(db.get_note(self.owner, "conv-1")["content"], "theirs")

    def test_history_is_retained_and_restorable(self):
        db.save_note(self.owner, "conv-1", "ws-1", "original", 0)
        db.save_note(self.owner, "conv-1", "ws-1", "replaced", 1)
        revisions = db.list_note_revisions(self.owner, "conv-1")
        self.assertEqual([r["revision"] for r in revisions], [2, 1])

        earlier = db.get_note_revision(self.owner, "conv-1", 1)
        restored = db.save_note(self.owner, "conv-1", "ws-1", earlier["content"], 2)
        # Restoring appends rather than rewinding, so nothing written is lost.
        self.assertEqual(restored["revision"], 3)
        self.assertEqual(db.get_note(self.owner, "conv-1")["content"], "original")
        self.assertEqual(len(db.list_note_revisions(self.owner, "conv-1")), 3)

    def test_notes_are_scoped_to_their_owner(self):
        other = db.create_user("other@example.com")
        db.save_note(self.owner, "conv-1", "ws-1", "private", 0)
        self.assertIsNone(db.get_note(other, "conv-1"))

    def test_missing_note_reads_as_empty_revision_zero(self):
        self.assertIsNone(db.get_note(self.owner, "never-written"))

    def test_deleting_a_note_removes_its_full_history(self):
        db.save_note(self.owner, "conv-1", "ws-1", "one", 0)
        db.save_note(self.owner, "conv-1", "ws-1", "two", 1)
        self.assertTrue(db.delete_note(self.owner, "conv-1"))
        self.assertIsNone(db.get_note(self.owner, "conv-1"))
        self.assertEqual(db.list_note_revisions(self.owner, "conv-1"), [])

    def test_deleting_a_note_that_never_existed_reports_false(self):
        self.assertFalse(db.delete_note(self.owner, "never-written"))

    def test_recreating_a_deleted_note_starts_at_revision_one_again(self):
        db.save_note(self.owner, "conv-1", "ws-1", "one", 0)
        db.delete_note(self.owner, "conv-1")
        saved = db.save_note(self.owner, "conv-1", "ws-1", "fresh start", 0)
        self.assertEqual(saved["revision"], 1)


class ChatHistoryDeletionTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        patcher = patch.object(db, "DB_PATH", Path(self._dir.name) / "test.db")
        patcher.start()
        self.addCleanup(patcher.stop)
        db.init_db()
        self.owner = db.create_user("owner@example.com")
        self.document = db.create_document(self.owner, "report.pdf", pages=4)
        db.create_chat_turn(self.document, self.owner, "q1", "a1", "[]")
        db.create_chat_turn(self.document, self.owner, "q2", "a2", "[]")

    def test_clearing_history_does_not_delete_the_document(self):
        removed = db.delete_chat_turns_for_document(self.document, self.owner)
        self.assertEqual(removed, 2)
        self.assertEqual(db.list_chat_turns(self.document, self.owner), [])
        # The document itself, and therefore its index, is untouched.
        self.assertIsNotNone(db.get_document(self.document, self.owner))

    def test_another_owner_cannot_clear_someone_elses_history(self):
        other = db.create_user("other@example.com")
        removed = db.delete_chat_turns_for_document(self.document, other)
        self.assertEqual(removed, 0)
        self.assertEqual(len(db.list_chat_turns(self.document, self.owner)), 2)


if __name__ == "__main__":
    unittest.main()
