"""Retained original files: storage, serving, cleanup, quota and recovery.

Runs ingest end to end with stubbed parsing, embedding and Qdrant, against a
temporary database and data directory.
"""

import glob
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fastapi.testclient import TestClient
from langchain_core.documents import Document

from APP import db
from APP.auth import get_current_user
from APP.main import app
from APP.rag import originals
from APP.rag.service import RAGService
from APP.rag.vector_store import document_index_dir

MB = 1024 * 1024
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _text_for(raw: bytes) -> str:
    # Stub parser: extracted text depends on the bytes, like a real one.
    return "Extracted: " + raw[:40].decode("latin-1") + " " + str(len(raw))


class OriginalsTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cwd = os.getcwd()
        os.chdir(self.tmp.name)                      # data/documents/... is relative
        self.addCleanup(os.chdir, self.cwd)
        p = mock.patch.object(db, "DB_PATH", Path(self.tmp.name) / "test.db"); p.start(); self.addCleanup(p.stop)
        db.init_db()
        self.owner = db.create_user("owner@example.com")
        self.other = db.create_user("other@example.com")
        self.enable(True, cap=10 * MB)
        self.index = mock.patch("APP.rag.service.build_hybrid_indices"); self.build = self.index.start(); self.addCleanup(self.index.stop)
        gate = mock.patch("APP.rag.service.apply_quality_gate",
                          side_effect=lambda chunks, **kw: [c.__class__(page_content=c.page_content, metadata={**c.metadata, "passed_gate": True}) for c in chunks])
        gate.start(); self.addCleanup(gate.stop)
        self.service = self.make_service()

    def enable(self, on: bool, cap: int = 10 * MB):
        for name, value in (("ORIGINALS_ENABLED", on), ("ORIGINALS_MAX_BYTES_PER_OWNER", cap)):
            p = mock.patch.object(originals, name, value); p.start(); self.addCleanup(p.stop)

    def make_service(self):
        s = RAGService.__new__(RAGService)
        s.settings = SimpleNamespace(qdrant_collection="test")
        s.qdrant = mock.Mock()
        s.embedding_provider = mock.Mock()
        s.parse_calls = 0
        def load(filename, raw):
            s.parse_calls += 1
            return [Document(page_content=_text_for(raw), metadata={"page": 1, "source": filename})], "stub"
        s._load_upload_to_docs = load
        s._embed_all = lambda texts: [[0.1, 0.2, 0.3] for _ in texts]
        return s

    def ingest(self, raw: bytes, filename="report.docx", owner=None):
        return self.service.ingest(owner_id=owner or self.owner, filename=filename, raw_bytes=raw,
                                   chunk_size=1000, chunk_overlap=100, quality_threshold=0.0)

    def disk_bytes(self, owner):
        return sum(os.path.getsize(p) for p in glob.glob(f"data/documents/{owner}/*/original*"))

    def assertClean(self, owner):
        committed, reserved = db.storage_usage(owner)
        self.assertEqual(reserved, 0, "reservation leaked")
        self.assertEqual(committed, self.disk_bytes(owner), "ledger disagrees with disk")
        self.assertEqual(glob.glob("data/**/*.tmp", recursive=True), [], "temp file left behind")


class IngestStorageTests(OriginalsTestCase):
    def test_original_is_stored_byte_identical_and_listed(self):
        raw = os.urandom(MB)
        doc = self.ingest(raw).document_id
        path, filename = self.service.get_original(doc, self.owner)
        self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(filename, "report.docx")
        [summary] = self.service.list_documents(self.owner)
        self.assertTrue(summary.has_original)
        self.assertTrue(summary.original_compatible)
        self.assertEqual(db.get_document(doc, self.owner)["status"], "ready")
        self.assertClean(self.owner)

    def test_other_owner_cannot_reach_the_original(self):
        doc = self.ingest(b"secret bytes").document_id
        self.assertIsNone(self.service.get_original(doc, self.other))

    def test_failure_while_indexing_leaves_nothing_behind(self):
        self.build.side_effect = RuntimeError("qdrant unavailable")
        with self.assertRaises(RuntimeError):
            self.ingest(os.urandom(MB))
        self.assertEqual(self.service.list_documents(self.owner), [])
        with db._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0], 0, "orphan row left")
        # The owner's parent folder may remain (it is shared by all of their
        # documents); no document folder and no file may.
        self.assertEqual(glob.glob(f"data/documents/{self.owner}/*"), [])
        self.assertEqual([p for p in glob.glob("data/documents/**/*", recursive=True) if os.path.isfile(p)], [])
        self.assertClean(self.owner)

    def test_failure_while_writing_the_original_leaves_nothing_behind(self):
        with mock.patch.object(originals, "write_atomic", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.ingest(os.urandom(MB))
        with db._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0], 0)
        self.assertClean(self.owner)

    def test_over_quota_is_rejected_before_paying_for_parsing(self):
        self.enable(True, cap=MB)
        with self.assertRaises(db.StorageQuotaExceeded):
            self.ingest(os.urandom(2 * MB))
        self.assertEqual(self.service.parse_calls, 0)
        self.assertClean(self.owner)

    def test_concurrent_ingests_never_exceed_the_cap(self):
        self.enable(True, cap=3 * MB)
        ok, rejected, errors = [], [], []
        barrier = threading.Barrier(6)
        def run():
            barrier.wait()
            try: ok.append(self.ingest(os.urandom(MB)).document_id)
            except db.StorageQuotaExceeded: rejected.append(1)
            except Exception as e: errors.append(repr(e))
        threads = [threading.Thread(target=run) for _ in range(6)]
        [t.start() for t in threads]; [t.join() for t in threads]
        self.assertEqual(errors, [])
        self.assertEqual((len(ok), len(rejected)), (3, 3))
        self.assertClean(self.owner)

    def test_reservations_cannot_both_pass_the_check(self):
        # Widen the read-then-write window so 20 threads genuinely overlap in it.
        import time
        p = mock.patch.object(db, "_reserve_window_hook", lambda: time.sleep(0.02)); p.start(); self.addCleanup(p.stop)
        with db._connect() as c: c.execute("INSERT OR IGNORE INTO storage_ledger (owner_id) VALUES (?)", (self.owner,))
        granted, rejected, errors = [], [], []
        barrier = threading.Barrier(20)
        def run(i):
            barrier.wait()
            try: granted.append(db.reserve_storage(self.owner, f"doc-{i}", MB, 10 * MB))
            except db.StorageQuotaExceeded: rejected.append(i)
            except Exception as e: errors.append(repr(e))
        threads = [threading.Thread(target=run, args=(i,)) for i in range(20)]
        [t.start() for t in threads]; [t.join() for t in threads]
        self.assertEqual(errors, [])
        self.assertEqual((len(granted), len(rejected)), (10, 10))
        self.assertEqual(db.storage_usage(self.owner), (0, 10 * MB))

    def test_delete_removes_the_original_and_frees_storage(self):
        doc = self.ingest(os.urandom(2 * MB)).document_id
        self.assertTrue(self.service.remove_document(doc, self.owner))
        self.assertFalse(document_index_dir(self.owner, doc).exists())
        self.assertEqual(db.storage_usage(self.owner), (0, 0))

    def test_document_deleted_mid_ingest_is_not_resurrected(self):
        def delete_meanwhile(*a, **kw):
            with db._connect() as conn:
                conn.execute("DELETE FROM documents WHERE owner_id = ?", (self.owner,))
        self.build.side_effect = delete_meanwhile
        with self.assertRaises(RuntimeError):
            self.ingest(os.urandom(MB))
        self.assertEqual(self.service.list_documents(self.owner), [])
        self.assertClean(self.owner)

    def test_disabled_keeps_todays_behaviour(self):
        self.enable(False)
        doc = self.ingest(os.urandom(MB)).document_id
        self.assertIsNone(self.service.get_original(doc, self.owner))
        [summary] = self.service.list_documents(self.owner)
        self.assertFalse(summary.has_original)
        self.assertIsNone(summary.original_compatible)
        self.assertEqual(db.storage_usage(self.owner), (0, 0))

    def test_debug_snapshot_is_written_whole(self):
        self.ingest(os.urandom(1000))
        lines = Path("data/chunks/chunks_processed.jsonl").read_text().splitlines()
        self.assertTrue(lines)
        [json.loads(line) for line in lines]          # every line parses: not interleaved


class AttachOriginalTests(OriginalsTestCase):
    def legacy_document(self, raw: bytes) -> str:
        # Ingested before originals were kept: pages.json exists, no original.
        self.enable(False)
        doc = self.ingest(raw).document_id
        self.enable(True, cap=10 * MB)
        return doc

    def test_same_file_is_compatible_and_attached_without_touching_anything_else(self):
        raw = os.urandom(MB)
        doc = self.legacy_document(raw)
        pages_before = (document_index_dir(self.owner, doc) / "pages.json").read_bytes()
        result = self.service.attach_original(doc, self.owner, "report.docx", raw, confirm=False)
        self.assertTrue(result["compatible"]); self.assertTrue(result["attached"])
        self.assertEqual(self.service.get_original(doc, self.owner)[0].read_bytes(), raw)
        self.assertEqual((document_index_dir(self.owner, doc) / "pages.json").read_bytes(), pages_before)
        [summary] = self.service.list_documents(self.owner)
        self.assertTrue(summary.has_original); self.assertTrue(summary.original_compatible)
        self.assertClean(self.owner)

    def test_different_file_is_refused_without_confirmation(self):
        doc = self.legacy_document(os.urandom(MB))
        result = self.service.attach_original(doc, self.owner, "report.docx", os.urandom(MB), confirm=False)
        self.assertFalse(result["compatible"]); self.assertFalse(result["attached"])
        self.assertIsNone(self.service.get_original(doc, self.owner))
        self.assertEqual(db.storage_usage(self.owner), (0, 0))

    def test_confirmed_mismatch_keeps_old_extraction_and_is_marked_incompatible(self):
        doc = self.legacy_document(os.urandom(MB))
        pages_before = (document_index_dir(self.owner, doc) / "pages.json").read_bytes()
        result = self.service.attach_original(doc, self.owner, "report.docx", os.urandom(MB), confirm=True)
        self.assertTrue(result["attached"]); self.assertFalse(result["compatible"])
        self.assertEqual((document_index_dir(self.owner, doc) / "pages.json").read_bytes(), pages_before)
        [summary] = self.service.list_documents(self.owner)
        self.assertTrue(summary.has_original); self.assertFalse(summary.original_compatible)

    def test_attaching_twice_is_refused(self):
        raw = os.urandom(1000)
        doc = self.ingest(raw).document_id
        with self.assertRaises(FileExistsError):
            self.service.attach_original(doc, self.owner, "report.docx", raw, confirm=True)

    def test_type_mismatch_is_refused(self):
        doc = self.legacy_document(os.urandom(1000))
        with self.assertRaises(ValueError):
            self.service.attach_original(doc, self.owner, "report.xlsx", os.urandom(1000), confirm=True)

    def test_unknown_or_foreign_document_is_not_found(self):
        doc = self.legacy_document(os.urandom(1000))
        with self.assertRaises(FileNotFoundError):
            self.service.attach_original(doc, self.other, "report.docx", os.urandom(1000), confirm=True)


class OriginalRouteTests(OriginalsTestCase):
    def setUp(self):
        super().setUp()
        saved = getattr(app.state, "rag_service", None)
        app.state.rag_service = self.service
        self.addCleanup(setattr, app.state, "rag_service", saved)
        self.user = {"id": self.owner}
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app)

    def test_download_is_private_and_byte_identical(self):
        raw = os.urandom(MB)
        doc = self.ingest(raw).document_id
        r = self.client.get(f"/documents/{doc}/file")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content, raw)
        self.assertEqual(r.headers["content-type"], DOCX)
        self.assertIn("attachment", r.headers["content-disposition"])
        self.assertEqual(r.headers["cache-control"], "private, no-store")
        self.user = {"id": self.other}
        self.assertEqual(self.client.get(f"/documents/{doc}/file").status_code, 404)

    def test_document_without_original_is_404(self):
        self.enable(False)
        doc = self.ingest(os.urandom(1000)).document_id
        self.assertEqual(self.client.get(f"/documents/{doc}/file").status_code, 404)

    def test_attach_route_conflict_and_confirm(self):
        self.enable(False)
        doc = self.ingest(os.urandom(1000)).document_id
        self.enable(True, cap=10 * MB)
        other = os.urandom(1000)
        r = self.client.post(f"/documents/{doc}/original", files={"file": ("report.docx", other, DOCX)})
        self.assertEqual(r.status_code, 409); self.assertFalse(r.json()["compatible"])
        r = self.client.post(f"/documents/{doc}/original", files={"file": ("report.docx", other, DOCX)}, data={"confirm": "true"})
        self.assertEqual(r.status_code, 200); self.assertTrue(r.json()["attached"])

    def test_attach_route_hidden_when_disabled(self):
        self.enable(False)
        doc = self.ingest(os.urandom(1000)).document_id
        r = self.client.post(f"/documents/{doc}/original", files={"file": ("report.docx", b"x", DOCX)})
        self.assertEqual(r.status_code, 404)

    def test_sync_ingest_over_quota_is_413(self):
        self.enable(True, cap=1000)
        r = self.client.post("/ingest", files={"file": ("report.docx", os.urandom(5000), DOCX)})
        self.assertEqual(r.status_code, 413)

    def test_async_upload_spool_is_removed_after_the_job(self):
        before = set(glob.glob(os.path.join(tempfile.gettempdir(), "citely-upload-*")))
        r = self.client.post("/ingest/async", files={"file": ("report.docx", os.urandom(2000), DOCX)})
        self.assertEqual(r.status_code, 202)
        job_id = r.json()["job_id"]
        for _ in range(100):
            status = self.client.get(f"/ingest/jobs/{job_id}").json()["status"]
            if status in ("succeeded", "failed"): break
            threading.Event().wait(0.05)
        self.assertEqual(status, "succeeded")
        after = set(glob.glob(os.path.join(tempfile.gettempdir(), "citely-upload-*")))
        self.assertEqual(after - before, set(), "upload spool file left behind")

    def _wait_for(self, job_id):
        for _ in range(100):
            status = self.client.get(f"/ingest/jobs/{job_id}").json()["status"]
            if status in ("succeeded", "failed"):
                return status
            threading.Event().wait(0.05)
        return status

    def test_a_retried_upload_with_the_same_client_id_is_ingested_once(self):
        before = set(glob.glob(os.path.join(tempfile.gettempdir(), "citely-upload-*")))
        body = os.urandom(2000)
        send = lambda key: self.client.post("/ingest/async", data={"client_upload_id": key},
                                            files={"file": ("report.docx", body, DOCX)})
        first, again = send("row-1"), send("row-1")           # the first "timed out"; the client retried
        self.assertEqual((first.status_code, again.status_code), (202, 202))
        self.assertEqual(first.json()["job_id"], again.json()["job_id"])
        self.assertEqual(self._wait_for(first.json()["job_id"]), "succeeded")
        other = send("row-2")                                   # a different upload is its own job
        self.assertNotEqual(other.json()["job_id"], first.json()["job_id"])
        self._wait_for(other.json()["job_id"])
        self.assertEqual(len(db.list_documents(self.owner)), 2)
        after = set(glob.glob(os.path.join(tempfile.gettempdir(), "citely-upload-*")))
        self.assertEqual(after - before, set(), "duplicate upload's spool file left behind")

    def test_oversized_upload_rejected(self):
        with mock.patch("APP.main.MAX_UPLOAD_BYTES", 1000):
            r = self.client.post("/ingest/async", files={"file": ("report.docx", os.urandom(5000), DOCX)})
        self.assertEqual(r.status_code, 413)


if __name__ == "__main__":
    unittest.main()
