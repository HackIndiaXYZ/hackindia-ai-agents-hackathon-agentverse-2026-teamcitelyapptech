"""Evidence records: existing documents join them without any change, old
citations and saved highlights keep resolving after new evidence arrives, a
published revision refreshes caches without moving old answers, and the
spending ledger counts what it must. Only the model and retrieval are
fixtures; the real store, service helpers and database run."""

import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from langchain_core.documents import Document

from APP import db
from APP.extraction import store
from APP.rag import evidence
from APP.rag.chunking import extraction_version as make_version
from APP.rag.service import RAGService

PAGES = {1: "Quarterly revenue grew by twelve percent.\nEnterprise sales led the growth.", 2: "Costs were flat.\nHeadcount stayed at 40."}


class Base(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.temp = Path(temp.name)
        self.patch(db, "DB_PATH", self.temp / "test.db")
        db.init_db()
        self.owner = db.create_user("evidence@example.invalid")
        self.document = db.create_document(self.owner, "Report.pdf", pages=2)
        self.patch(__import__("APP.rag.service", fromlist=["x"]), "document_index_dir", lambda owner, doc: self.temp / "docs" / owner / doc)
        self.service = RAGService.__new__(RAGService)
        self.service.settings = SimpleNamespace(qdrant_collection="test")
        self.version = make_version(PAGES)
        self.service._save_page_texts(self.owner, self.document, PAGES)
        self.pages_file = self.service._page_texts_path(self.owner, self.document)

    def patch(self, target, name, value, **kw):
        p = patch.object(target, name, value, **kw)
        p.start()
        self.addCleanup(p.stop)

    def count(self, table):
        with db._connect() as conn:
            return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]

    def citation(self, page=1, quote="Enterprise sales led the growth."):
        chunk = Document(page_content=PAGES[page], metadata={"chunk_id": 0, "page": page, "source": "Report.pdf", "document_id": self.document,
                                                              "page_char_start": 0, "page_char_end": len(PAGES[page]), "extraction_version": self.version})
        return evidence.source_for(chunk, 1.0, {"page": page, "text": PAGES[page], "extraction_version": self.version}, quote)

    def add_ocr(self, text="Chart: revenue by quarter 10 12 14", page=1):
        region = store.add_region(self.document, "v", {"format": "pdf", "page": page, "box": [0, 0, 1, 1]}, asset_hash="abc", asset_path="/x.png", state="done")
        return store.add_record(region, text, provenance="ocr", content_type="text", extractor="azure-read:test", settings={"mode": "read"})


class BackfillTest(Base):
    def test_an_existing_document_becomes_file_version_one_with_native_page_records(self):
        with db._connect() as conn:
            conn.execute("UPDATE documents SET original_sha256 = ? WHERE id = ?", ("a" * 64, self.document))
        self.assertTrue(self.service.backfill_evidence(self.owner, self.document))
        with db._connect() as conn:
            file = conn.execute("SELECT * FROM evidence_files WHERE document_id = ?", (self.document,)).fetchone()
        self.assertEqual((file["file_version"], file["revision"], file["total_pages"]), ("a" * 64, 0, 2))
        records = [r for r in store.records(self.owner, self.document) if r["provenance"] == "native"]
        self.assertEqual(sorted(r["text"] for r in records), sorted(PAGES.values()))            # the page text, exactly
        self.assertEqual({json.loads(r["settings"])["extraction_version"] for r in records}, {self.version})
        self.assertEqual(store.revision(self.owner, self.document), 0)                          # search and caches untouched

    def test_a_document_with_no_original_still_gets_a_stable_version(self):
        self.service.backfill_evidence(self.owner, self.document)
        with db._connect() as conn:
            first = conn.execute("SELECT file_version FROM evidence_files").fetchone()[0]
        self.assertEqual(first, store.identity("legacy-file", self.document))

    def test_it_can_be_repeated_and_adds_nothing(self):
        self.service.backfill_evidence(self.owner, self.document)
        before = (self.count("evidence_files"), self.count("evidence_regions"), self.count("evidence_records"))
        self.service.backfill_evidence(self.owner, self.document)
        self.assertEqual(before, (self.count("evidence_files"), self.count("evidence_regions"), self.count("evidence_records")))
        self.assertEqual(before, (1, 2, 2))

    def test_a_document_without_page_texts_is_skipped_not_failed(self):
        other = db.create_document(self.owner, "Old.txt", pages=1)
        self.assertFalse(self.service.backfill_evidence(self.owner, other))

    def test_backfill_all_reaches_every_ready_document_even_when_one_fails(self):
        other = db.create_document(self.owner, "Second.pdf", pages=2)
        self.service._save_page_texts(self.owner, other, PAGES)
        broken = db.create_document(self.owner, "Broken.pdf", pages=1)
        with patch.object(self.service, "_load_page_texts", side_effect=lambda o, d: (_ for _ in ()).throw(OSError("unreadable")) if d == broken else RAGService._load_page_texts(self.service, o, d)):
            self.assertEqual(self.service.backfill_all_evidence(), 2)

    def test_nothing_about_the_existing_page_files_changes(self):
        before = self.pages_file.read_bytes()
        self.service.backfill_evidence(self.owner, self.document)
        self.assertEqual(self.pages_file.read_bytes(), before)


class CompatibilityTest(Base):
    def setUp(self):
        super().setUp()
        self.service.backfill_evidence(self.owner, self.document)

    def test_adding_image_evidence_changes_no_citation_offset_or_id(self):
        before = self.citation()
        file_before = self.pages_file.read_bytes()
        self.add_ocr()
        store.publish(self.owner, self.document, 0)
        after = self.citation()
        for field in ("citation_id", "page_char_start", "page_char_end", "extraction_version", "quote", "page"):
            self.assertEqual(getattr(after, field), getattr(before, field), field)
        self.assertEqual(self.pages_file.read_bytes(), file_before)                              # page text and its version untouched
        self.assertEqual(store.revision(self.owner, self.document), 1)

    def test_an_old_citation_still_resolves_to_the_record_it_used(self):
        cited = self.citation()
        record = store.record_for_page(self.owner, self.document, cited.page, cited.extraction_version)
        self.assertEqual(record["text"], PAGES[1])
        self.add_ocr()
        self.add_ocr("A second picture reads: Q4 outlook", page=1)
        store.publish(self.owner, self.document, 0)
        again = store.record_for_page(self.owner, self.document, cited.page, cited.extraction_version)
        self.assertEqual(again["id"], record["id"])
        self.assertIsNone(store.record_for_page(self.owner, self.document, cited.page, "some-other-version"))   # never a guess

    def test_a_saved_highlight_keeps_resolving_the_same_way(self):
        cited = self.citation()
        note = db.create_annotation(self.owner, workspace_id="w", conversation_id="c", document_id=self.document, kind="highlight",
                                    page_number=cited.page, quote=cited.quote, citation_id=cited.citation_id,
                                    page_char_start=cited.page_char_start, page_char_end=cited.page_char_end,
                                    extraction_version=cited.extraction_version)
        first = store.record_for_page(self.owner, self.document, note["page_number"], note["extraction_version"])
        self.add_ocr()
        store.publish(self.owner, self.document, 0)
        self.assertEqual(store.record_for_page(self.owner, self.document, note["page_number"], note["extraction_version"])["id"], first["id"])
        again = db.list_annotations(self.owner, "c")[0]
        self.assertEqual((again["page_char_start"], again["page_char_end"], again["citation_id"]), (note["page_char_start"], note["page_char_end"], note["citation_id"]))

    def test_extraction_records_never_change_once_written(self):
        record_id = self.add_ocr("first reading")
        self.add_ocr("first reading")                                                              # same attempt again: same record
        self.assertEqual(self.count("evidence_records"), 3)
        other = self.add_ocr("a different reading")                                                # a new attempt: a new record
        self.assertNotEqual(record_id, other)
        with db._connect() as conn:
            self.assertEqual(conn.execute("SELECT text FROM evidence_records WHERE id = ?", (record_id,)).fetchone()[0], "first reading")

    def test_publishing_with_a_stale_revision_is_refused_not_applied_twice(self):
        store.publish(self.owner, self.document, 0)
        with self.assertRaises(RuntimeError):
            store.publish(self.owner, self.document, 0)
        self.assertEqual(store.revision(self.owner, self.document), 1)


class RevisionCacheTest(Base):
    def key(self, *documents):
        return self.service._summary_cache_key(self.owner, list(documents), "Summarize the key takeaways.")

    def setUp(self):
        super().setUp()
        self.second = db.create_document(self.owner, "Second.pdf", pages=2)
        self.service._save_page_texts(self.owner, self.second, PAGES)
        for doc in (self.document, self.second):
            self.service.backfill_evidence(self.owner, doc)

    def test_a_revision_changes_the_summary_key_for_that_document_and_any_folder_containing_it(self):
        alone, together, other_alone = self.key(self.document), self.key(self.document, self.second), self.key(self.second)
        store.publish(self.owner, self.document, 0)
        self.assertNotEqual(self.key(self.document), alone)
        self.assertNotEqual(self.key(self.document, self.second), together)                      # the folder sees it too
        self.assertEqual(self.key(self.second), other_alone)                                      # an unrelated document's key is stable

    def test_a_remembered_summary_is_not_served_after_a_revision_and_old_answers_keep_their_text(self):
        old_key = self.key(self.document)
        db.remember_answer(old_key, self.owner, [self.document], "Old summary [1].", "[]")
        db.create_chat_turn(self.document, self.owner, "Summarize", "Old summary [1].", json.dumps([{"quote": "x"}]))
        store.publish(self.owner, self.document, 0)
        self.assertIsNone(db.cached_answer(self.key(self.document), self.owner))                 # recomputed, not stale
        saved = [t for t in db.list_chat_turns(self.document, self.owner)]
        self.assertEqual((saved[0]["answer"], saved[0]["sources_json"]), ("Old summary [1].", json.dumps([{"quote": "x"}])))

    def test_the_index_cache_is_keyed_on_the_revision(self):
        calls = []
        self.service.qdrant = Mock()
        self.service.embedding_provider = Mock()
        loaded = (Mock(), Mock(), [Document(page_content="x", metadata={})])

        def load(document_id, owner_id, **kw):
            calls.append(kw.get("revision"))
            return loaded
        with patch("APP.rag.service.load_document_index", side_effect=load), patch("APP.rag.service.QdrantVectorStore"):
            self.service._load_document_artifacts(self.document, self.owner)
            store.publish(self.owner, self.document, 0)
            self.service._load_document_artifacts(self.document, self.owner)
        self.assertEqual(calls, [0, 1])


class LedgerTest(Base):
    def reserve(self, key="k1", amount=100, upload=10_000, daily=10_000, document=None):
        return store.reserve(self.owner, document or self.document, key, amount, upload, daily)

    def state(self, charge):
        with db._connect() as conn:
            return conn.execute("SELECT state, actual FROM extraction_charges WHERE id = ?", (charge,)).fetchone()

    def test_nothing_is_reserved_without_configured_prices_and_caps(self):
        for args in ((0, 10, 10), (5, 0, 10), (5, 10, 0)):
            with self.assertRaises(store.BudgetExceeded):
                store.reserve(self.owner, self.document, "k", *args)

    def test_retries_and_concurrent_requests_for_one_image_are_never_sent_twice(self):
        charge = self.reserve()
        with self.assertRaises(store.RequestUncertain):
            self.reserve()                                                                         # still reserved
        store.charge_state(charge, "pending")
        with self.assertRaises(store.RequestUncertain):
            self.reserve()                                                                         # sent, billing uncertain

    def test_pending_charges_count_against_both_caps(self):
        self.reserve("a", 600, upload=1_000, daily=100_000)
        with self.assertRaises(store.BudgetExceeded):
            self.reserve("b", 600, upload=1_000, daily=100_000)                                  # the per-document cap
        other = db.create_document(self.owner, "Other.pdf", pages=1)
        self.reserve("c", 500, upload=10_000, daily=1_100, document=other)                       # 600 + 500 = the daily cap
        with self.assertRaises(store.BudgetExceeded):
            self.reserve("d", 100, upload=10_000, daily=1_100, document=other)                  # the daily cap holds across documents

    def test_only_work_that_never_ran_can_be_released(self):
        never_sent = self.reserve("a")
        store.charge_state(never_sent, "released")
        self.reserve("a")                                                                          # free to try again
        sent = self.reserve("b")
        store.charge_state(sent, "pending")
        with self.assertRaises(ValueError):
            store.charge_state(sent, "released")

    def test_after_a_restart_unsent_charges_are_released_and_sent_ones_stay_counted(self):
        unsent = self.reserve("unsent", 300)
        sent = self.reserve("sent", 300)
        store.charge_state(sent, "pending")
        store.recover()
        self.assertEqual(self.state(unsent)["state"], "released")
        self.assertEqual(self.state(sent)["state"], "pending")
        with self.assertRaises(store.BudgetExceeded):
            self.reserve("more", 800, upload=1_000, daily=1_000)                                  # the sent one still counts

    def test_old_uncertain_charges_settle_at_their_maximum_never_as_free(self):
        sent = self.reserve("sent", 300)
        store.charge_state(sent, "pending")
        self.assertEqual(store.settle_unresolved(), 0)                                            # too recent
        self.assertEqual(store.settle_unresolved(now=time.time() + store.UNRESOLVED_AFTER_SECONDS + 5), 1)
        state = self.state(sent)
        self.assertEqual((state["state"], state["actual"]), ("reconciled", 300))

    def test_actual_usage_replaces_the_estimate_once_reconciled(self):
        charge = self.reserve("a", 500, upload=1_000, daily=1_000)
        store.charge_state(charge, "pending")
        store.charge_state(charge, "reconciled", 100)
        self.reserve("b", 800, upload=1_000, daily=1_000)                                          # 100 used, so 800 more fits


class FakeOcr:
    """A provider that reads every image as 'Revenue 10 12 14' and counts calls."""
    version = "fake-ocr:test"

    def __init__(self, *, fail=False, ready=True, price=100):
        self.calls, self.fail, self._ready, self.price = 0, fail, ready, price

    def settings(self, mode):
        return {"version": self.version, "mode": mode}

    def ready(self):
        return self._ready

    def estimate(self, mode):
        return self.price

    def extract(self, data, mode):
        self.calls += 1
        if self.fail:
            raise TimeoutError("provider timed out")
        return {"text": "Revenue 10 12 14", "provenance": "ocr", "content_type": "text", "extractor": self.version, "confidence": None, "pages": 1}


class WorkerTest(Base):
    def setUp(self):
        super().setUp()
        self.service.backfill_evidence(self.owner, self.document)
        self.image = self.temp / "image.png"
        self.image.write_bytes(b"png-bytes")
        patcher = patch.dict("os.environ", {"EXTRACTION_UPLOAD_CAP_MICROUSD": "10000", "EXTRACTION_DAILY_CAP_MICROUSD": "10000"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def queue(self, picture=0, digest="same"):
        version = store.register(self.owner, self.document, b"file", 2)
        store.add_region(self.document, version, {"format": "pptx", "page": 1, "slide_index": 0, "shape_id": 10 + picture},
                         asset_hash=digest, asset_path=str(self.image), state="queued")

    def run_all(self, provider):
        from APP.extraction import worker
        done = 0
        while (job := store.claim()):
            worker.process(job, provider)
            done += 1
        return done

    def charges(self):
        with db._connect() as conn:
            return [dict(r) for r in conn.execute("SELECT state, reserved, actual FROM extraction_charges ORDER BY created")]

    def test_a_picture_is_read_charged_once_recorded_and_waits_to_be_published(self):
        self.queue()
        provider = FakeOcr()
        self.assertEqual(self.run_all(provider), 1)
        self.assertEqual(self.charges(), [{"state": "reconciled", "reserved": 100, "actual": 100}])
        ocr = [r for r in store.records(self.owner, self.document) if r["provenance"] == "ocr"]
        self.assertEqual([r["text"] for r in ocr], ["Revenue 10 12 14"])
        self.assertEqual(json.loads(ocr[0]["settings"])["version"], "fake-ocr:test")
        self.assertEqual(store.status(self.owner, self.document)["state"], "processing")          # indexed_pending is not yet complete
        self.assertEqual(store.revision(self.owner, self.document), 0)

    def test_the_same_picture_in_two_places_is_paid_for_once_and_both_places_keep_their_text(self):
        self.queue(0)
        self.queue(1)
        provider = FakeOcr()
        self.assertEqual(self.run_all(provider), 2)
        self.assertEqual(provider.calls, 1)
        self.assertEqual(len(self.charges()), 1)
        ocr = [r for r in store.records(self.owner, self.document) if r["provenance"] == "ocr"]
        self.assertEqual(len(ocr), 2)                                                              # one record per location
        self.assertEqual(len({r["region_id"] for r in ocr}), 2)

    def test_a_timeout_leaves_the_charge_pending_and_is_never_retried_automatically(self):
        self.queue()
        provider = FakeOcr(fail=True)
        self.run_all(provider)
        self.assertEqual([c["state"] for c in self.charges()], ["pending"])
        self.assertIsNone(store.claim())                                                           # nothing picks it up again
        self.assertEqual(provider.calls, 1)
        status = store.status(self.owner, self.document)
        self.assertEqual((status["state"], status["failed"]), ("partial", 1))

    def test_without_credentials_nothing_is_reserved_and_the_job_says_why(self):
        self.queue()
        self.run_all(FakeOcr(ready=False))
        self.assertEqual(self.charges(), [])
        with db._connect() as conn:
            self.assertIn("credentials", conn.execute("SELECT error FROM evidence_regions WHERE asset_hash IS NOT NULL").fetchone()[0])

    def test_a_cap_that_is_too_small_stops_the_call_before_it_is_sent(self):
        self.queue()
        provider = FakeOcr(price=50_000)
        self.run_all(provider)
        self.assertEqual(provider.calls, 0)
        self.assertEqual(self.charges(), [])


class PublishTest(Base):
    def setUp(self):
        super().setUp()
        import pickle
        from APP.rag import cache as doc_cache
        self.doc_cache = doc_cache
        self.service.backfill_evidence(self.owner, self.document)
        self.native = Document(page_content=PAGES[1], metadata={"chunk_id": 0, "page": 1, "source": "Report.pdf", "document_id": self.document,
                                                                "extraction_version": self.version, "page_char_start": 0, "page_char_end": len(PAGES[1])})
        folder = self.temp / "docs" / self.owner / self.document
        folder.mkdir(parents=True, exist_ok=True)
        with (folder / "bm25.pkl").open("wb") as handle:
            pickle.dump({"bm25": object.__new__(object.__class__), "chunks": [self.native]}, handle) if False else pickle.dump({"bm25": None, "chunks": [self.native]}, handle)
        self.service._embed_all = Mock(side_effect=lambda texts: [[0.0] for _ in texts])
        self.service.embedding_provider, self.service.qdrant = Mock(), Mock()
        self.region = store.add_region(self.document, "v", {"format": "pptx", "page": 1, "slide_index": 0, "shape_id": 7, "box": [0.1, 0.1, 0.5, 0.5]},
                                       asset_hash="abc", asset_path="/x.png", state="done")
        self.record = store.add_record(self.region, "Revenue 10 12 14", provenance="ocr", extractor="fake-ocr:test")

    def writes_index(self, chunks, document_id, owner_id, **kw):
        """Stands in for the real builder: writes the keyword-index file for the revision."""
        import pickle
        folder = self.temp / "docs" / owner_id / document_id
        with (folder / f"bm25.r{kw['revision']}.pkl").open("wb") as handle:
            pickle.dump({"bm25": None, "chunks": chunks}, handle)

    def publish(self, build=None):
        with patch("APP.rag.service.build_hybrid_indices", build or Mock(side_effect=self.writes_index)) as built:
            self.service.publish_evidence(self.owner, self.document)
        return built

    def test_the_picture_text_is_indexed_beside_the_untouched_native_chunks_then_the_revision_is_published(self):
        before = dict(self.native.metadata)
        built = self.publish()
        chunks = built.call_args.args[0]
        self.assertEqual(built.call_args.kwargs["revision"], 1)
        self.assertEqual(chunks[0].page_content, PAGES[1])
        self.assertEqual(chunks[0].metadata, before)                                               # native chunk: same text, same offsets, same version
        added = chunks[1]
        self.assertEqual((added.page_content, added.metadata["provenance"], added.metadata["evidence_record_id"]), ("Revenue 10 12 14", "ocr", self.record))
        self.assertEqual(store.revision(self.owner, self.document), 1)

    def test_a_failed_index_build_leaves_the_old_revision_live_and_the_work_retryable(self):
        with db._immediate() as conn:
            conn.execute("INSERT INTO evidence_jobs VALUES ('j', ?, ?, 'indexed_pending', 0, NULL)", (self.document, self.region))
        with self.assertRaises(RuntimeError):
            self.publish(Mock(side_effect=RuntimeError("qdrant down")))
        self.assertEqual(store.revision(self.owner, self.document), 0)
        with db._connect() as conn:
            self.assertEqual(conn.execute("SELECT state FROM evidence_jobs WHERE id = 'j'").fetchone()[0], "indexed_pending")
        self.publish()                                                                              # the retry succeeds
        self.assertEqual(store.revision(self.owner, self.document), 1)
        with db._connect() as conn:
            self.assertEqual(conn.execute("SELECT state FROM evidence_jobs WHERE id = 'j'").fetchone()[0], "done")

    def test_publishing_clears_the_cached_index_and_a_second_publish_with_nothing_new_does_nothing(self):
        self.doc_cache.put(self.owner, f"{self.document}:r0:1:1", ("old-index", []))
        self.publish()
        self.assertIsNone(self.doc_cache.get(self.owner, f"{self.document}:r0:1:1"))
        built = self.publish()
        built.assert_not_called()                                                                   # the picture text is already in revision 1
        self.assertEqual(store.revision(self.owner, self.document), 1)

    def test_only_the_new_text_is_embedded_and_uploaded_and_later_pictures_add_to_the_earlier_ones(self):
        built = self.publish()
        self.assertEqual(self.service._embed_all.call_args.args[0], ["Revenue 10 12 14"])         # not the whole document
        self.assertEqual([c.page_content for c in built.call_args.kwargs["vector_chunks"]], ["Revenue 10 12 14"])
        region = store.add_region(self.document, "v", {"format": "pptx", "page": 2, "slide_index": 1, "shape_id": 8}, asset_hash="def", asset_path="/y.png", state="done")
        store.add_record(region, "Headcount 40 to 55", provenance="ocr", extractor="fake-ocr:test")
        self.service._embed_all.reset_mock()
        built = self.publish()
        self.assertEqual(self.service._embed_all.call_args.args[0], ["Headcount 40 to 55"])
        self.assertEqual(sorted(c.page_content for c in built.call_args.args[0] if c.metadata.get("provenance") == "ocr"),
                         ["Headcount 40 to 55", "Revenue 10 12 14"])                                 # the keyword index covers both
        self.assertEqual(store.revision(self.owner, self.document), 2)

    def test_a_retry_clears_what_the_failed_attempt_staged_first(self):
        with self.assertRaises(RuntimeError):
            self.publish(Mock(side_effect=RuntimeError("upload timed out")))
        self.service.qdrant.delete.assert_called()                                                  # staged vectors removed before the retry
        self.publish()
        self.assertEqual(store.revision(self.owner, self.document), 1)

    def test_old_keyword_index_files_are_dropped_but_the_previous_one_is_kept(self):
        folder = self.temp / "docs" / self.owner / self.document
        for old in (1, 2):
            (folder / f"bm25.r{old}.pkl").write_bytes(b"x")
        self.service._drop_old_indexes(self.owner, self.document, 4)
        self.assertFalse((folder / "bm25.r1.pkl").exists())
        self.assertFalse((folder / "bm25.r2.pkl").exists())
        (folder / "bm25.r3.pkl").write_bytes(b"x")
        self.service._drop_old_indexes(self.owner, self.document, 4)
        self.assertTrue((folder / "bm25.r3.pkl").exists())

    def test_a_picture_citation_has_its_own_identity_and_does_not_pretend_to_be_page_text(self):
        chunk = Document(page_content="Revenue 10 12 14", metadata={
            "page": 1, "source": "Report.pdf", "document_id": self.document, "region_id": self.region, "evidence_record_id": self.record,
            "provenance": "ocr", "content_type": "text", "extraction_version": self.version,
            "evidence_location": {"format": "pptx", "page": 1, "slide_index": 0, "shape_id": 7, "box": [0.1, 0.1, 0.5, 0.5]}})
        source = evidence.source_for(chunk, 1.0, {"page": 1, "text": PAGES[1], "extraction_version": self.version}, None)
        self.assertEqual((source.provenance, source.evidence_record_id, source.region_id), ("ocr", self.record, self.region))
        self.assertIsNone(source.page_char_start)                                                   # no invented page offsets
        self.assertTrue(source.anchor["evidence_region"])
        self.assertEqual(source.anchor["shape_id"], 7)
        again = evidence.source_for(chunk, 1.0, {"page": 1, "text": PAGES[1], "extraction_version": self.version}, None)
        self.assertEqual(again.citation_id, source.citation_id)                                      # stable


class SearchVisibilityTest(unittest.TestCase):
    """Real Qdrant (in-memory): which vectors a search can see at each revision."""

    def setUp(self):
        from qdrant_client import QdrantClient, models
        self.models = models
        self.client = QdrantClient(":memory:")
        self.client.create_collection("c", vectors_config=models.VectorParams(size=2, distance=models.Distance.COSINE))
        self.document = "11111111-1111-1111-1111-111111111111"

    def point(self, number, text, revision=None):
        payload = {"text": text, "metadata": {}, "document_id": self.document, "owner_id": "o"}
        if revision is not None:
            payload["evidence_revision"] = revision
        self.client.upsert("c", points=[self.models.PointStruct(id=number, vector=[1.0, 0.0], payload=payload)], wait=True)

    def seen(self, revision):
        from APP.rag.vector_store import QdrantVectorStore
        embeddings = SimpleNamespace(embed_documents=lambda texts: [[1.0, 0.0]], embed_query=lambda t: [1.0, 0.0])
        store_ = QdrantVectorStore(self.client, "c", embeddings, document_id=self.document, owner_id="o", revision=revision)
        return sorted(d.page_content for d in store_.similarity_search("q", k=10))

    def test_a_search_sees_everything_up_to_its_revision_and_nothing_staged_beyond_it(self):
        self.point(1, "indexed before revisions existed")            # no evidence_revision at all
        self.point(2, "native text", 0)
        self.point(3, "first picture", 1)
        self.point(4, "staged picture", 2)
        self.assertEqual(self.seen(0), ["indexed before revisions existed", "native text"])
        self.assertEqual(self.seen(1), ["first picture", "indexed before revisions existed", "native text"])
        self.assertEqual(self.seen(2), ["first picture", "indexed before revisions existed", "native text", "staged picture"])

    def test_only_this_documents_vectors_are_visible(self):
        self.point(1, "mine", 0)
        self.client.upsert("c", points=[self.models.PointStruct(id=9, vector=[1.0, 0.0], payload={
            "text": "someone else's", "metadata": {}, "document_id": "22222222-2222-2222-2222-222222222222", "owner_id": "o", "evidence_revision": 0})], wait=True)
        self.assertEqual(self.seen(0), ["mine"])


class SearchIndexTest(unittest.TestCase):
    def test_the_revision_filter_has_an_integer_index_so_questions_do_not_fail(self):
        from APP.rag import vector_store
        client = Mock()
        vector_store.ensure_payload_indexes(client, "chunks")
        created = {c.kwargs["field_name"]: c.kwargs["field_schema"] for c in client.create_payload_index.call_args_list}
        self.assertEqual(set(created), {"document_id", "owner_id", "evidence_revision"})
        self.assertEqual(str(created["evidence_revision"]).lower().split(".")[-1], "integer")
        self.assertNotEqual(str(created["document_id"]).lower().split(".")[-1], "integer")

    def test_an_index_that_already_exists_is_not_an_error(self):
        from APP.rag import vector_store
        client = Mock()
        client.create_payload_index.side_effect = RuntimeError("already exists")
        vector_store.ensure_payload_indexes(client, "chunks")


if __name__ == "__main__":
    unittest.main()


class RepeatedPictureTest(PublishTest):
    def test_a_logo_on_every_slide_is_indexed_once_and_remembers_where_else_it_appears(self):
        for page in (2, 3, 4):
            region = store.add_region(self.document, "v", {"format": "pptx", "page": page, "slide_index": page - 1, "shape_id": 7, "box": [0, 0, 0.1, 0.1]},
                                      asset_hash="abc", asset_path="/x.png", state="done")      # the same image as the setUp picture
            store.add_record(region, "Revenue 10 12 14", provenance="ocr", extractor="fake-ocr:test")
        built = self.publish()
        added = [c for c in built.call_args.args[0] if c.metadata.get("provenance") == "ocr"]
        self.assertEqual(len(added), 1)
        self.assertEqual(sorted(p["page"] for p in added[0].metadata["also_at"]), [2, 3, 4])
        self.assertEqual(len([r for r in store.records(self.owner, self.document) if r["provenance"] == "ocr"]), 4)   # four locations, four records

    def test_a_different_image_with_different_text_is_still_indexed(self):
        region = store.add_region(self.document, "v", {"format": "pptx", "page": 2, "shape_id": 9}, asset_hash="def", asset_path="/y.png", state="done")
        store.add_record(region, "Headcount 40 to 55", provenance="ocr", extractor="fake-ocr:test")
        built = self.publish()
        self.assertEqual(sorted(c.page_content for c in built.call_args.args[0] if c.metadata.get("provenance") == "ocr"), ["Headcount 40 to 55", "Revenue 10 12 14"])


class PublishBatchingTest(Base):
    def job(self, state, age=0):
        region = store.add_region(self.document, "v", {"format": "pptx", "page": 1, "shape_id": len(state) + int(age)}, asset_hash=f"{state}{age}",
                                  asset_path="/x.png", state="done", mode="read")
        with db._immediate() as conn:
            conn.execute("INSERT INTO evidence_jobs VALUES (?, ?, ?, ?, ?, NULL)", (f"{state}{age}", self.document, region, state, time.time() - age))

    def setUp(self):
        super().setUp()
        self.service.backfill_evidence(self.owner, self.document)

    def test_a_batch_in_progress_waits_so_thirty_pictures_make_one_publish(self):
        self.job("indexed_pending", age=5)
        self.job("queued")
        self.assertEqual(store.documents_ready_to_publish(), [])

    def test_the_finished_batch_is_published(self):
        self.job("indexed_pending", age=5)
        self.job("done")
        self.assertEqual(store.documents_ready_to_publish(), [(self.owner, self.document)])

    def test_a_long_batch_still_shows_its_first_results_after_the_maximum_wait(self):
        self.job("indexed_pending", age=store.PUBLISH_MAX_WAIT_SECONDS + 5)
        self.job("queued")
        self.assertEqual(store.documents_ready_to_publish(), [(self.owner, self.document)])

    def test_nothing_waiting_means_nothing_to_publish(self):
        self.job("done")
        self.assertEqual(store.documents_ready_to_publish(), [])


class MissingIndexRecoveryTest(unittest.TestCase):
    """A deployment can reach a search before the evidence_revision index exists. Questions must
    not fail: the index is created and, when there is no published picture evidence to hide, the
    search goes ahead without that condition."""

    def store(self, revision, client):
        from APP.rag.vector_store import QdrantVectorStore
        embeddings = SimpleNamespace(embed_documents=lambda texts: [[1.0, 0.0]], embed_query=lambda t: [1.0, 0.0])
        return QdrantVectorStore(client, "c", embeddings, document_id="11111111-1111-1111-1111-111111111111", owner_id="o", revision=revision)

    def client(self, failures):
        point = SimpleNamespace(payload={"text": "found it", "metadata": {}}, score=0.9)
        client = Mock()
        client.query_points.side_effect = [*failures, SimpleNamespace(points=[point])]
        return client

    def test_a_missing_index_is_created_and_the_question_still_gets_its_passages(self):
        client = self.client([RuntimeError('Bad request: Index required but not found for "evidence_revision" of type integer')])
        results = self.store(0, client).similarity_search("q")
        self.assertEqual([d.page_content for d in results], ["found it"])
        self.assertEqual(client.query_points.call_count, 2)
        retry_filter = client.query_points.call_args_list[1].kwargs["query_filter"]
        self.assertFalse(retry_filter.must_not)                                  # the retry has no revision condition
        self.assertEqual({c.key for c in retry_filter.must}, {"document_id", "owner_id"})
        self.assertEqual({c.kwargs["field_name"] for c in client.create_payload_index.call_args_list}, {"document_id", "owner_id", "evidence_revision"})

    def test_a_document_with_published_picture_evidence_is_never_searched_without_the_condition(self):
        client = self.client([RuntimeError('Index required but not found for "evidence_revision"')])
        with self.assertRaises(RuntimeError):                                    # staged vectors could otherwise be exposed
            self.store(3, client).similarity_search("q")
        self.assertEqual(client.query_points.call_count, 1)

    def test_any_other_search_failure_is_not_swallowed(self):
        client = self.client([TimeoutError("read timed out")])
        with self.assertRaises(TimeoutError):
            self.store(0, client).similarity_search("q")
        self.assertEqual(client.query_points.call_count, 1)
        client.create_payload_index.assert_not_called()

    def test_a_healthy_search_makes_one_request_and_keeps_the_revision_condition(self):
        client = self.client([])
        self.store(0, client).similarity_search("q")
        self.assertEqual(client.query_points.call_count, 1)
        self.assertEqual(len(client.query_points.call_args.kwargs["query_filter"].must_not), 1)
