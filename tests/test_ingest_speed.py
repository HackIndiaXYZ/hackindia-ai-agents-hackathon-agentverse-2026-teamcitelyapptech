"""Faster uploads without changing what gets indexed: vectors go up several batches at
once and are retried when one fails, setup checks run once per process, identical chunk
texts are embedded once, and uploads use a longer timeout than question-time lookups."""

import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from langchain_core.documents import Document

from APP.rag import service as service_module
from APP.rag import vector_store
from APP.rag.service import RAGService


class FakeQdrant:
    """Records every batch uploaded; each takes `delay` seconds; `fail` maps batch-first-id -> failures left."""

    def __init__(self, delay=0.0, fail=None):
        self.delay, self.fail, self.lock = delay, dict(fail or {}), threading.Lock()
        self.uploaded, self.active, self.max_active, self.attempts = [], 0, 0, 0

    def upsert(self, collection_name, points, wait=True):
        with self.lock:
            self.attempts += 1
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            first = points[0]["id"]
            failing = self.fail.get(first, 0) > 0
            if failing:
                self.fail[first] -= 1
        try:
            time.sleep(self.delay)
            if failing:
                raise TimeoutError("The write operation timed out")
            with self.lock:
                self.uploaded.extend(p["id"] for p in points)
        finally:
            with self.lock:
                self.active -= 1


def points(n):
    return [{"id": i, "vector": [0.0], "payload": {}} for i in range(n)]


class UploadTest(unittest.TestCase):
    def test_every_point_is_uploaded_exactly_once_in_batches(self):
        client = FakeQdrant()
        vector_store._upsert_all(client, "c", points(150))
        self.assertEqual(sorted(client.uploaded), list(range(150)))
        self.assertEqual(client.attempts, 3)                                     # 64 + 64 + 22

    def test_batches_go_up_at_the_same_time_not_one_after_another(self):
        client = FakeQdrant(delay=0.25)
        started = time.time()
        vector_store._upsert_all(client, "c", points(64 * 4))
        elapsed = time.time() - started
        self.assertGreaterEqual(client.max_active, 3)
        self.assertLess(elapsed, 0.25 * 4 * 0.7)                                 # one at a time would be 1.0 s

    def test_a_batch_that_times_out_is_sent_again_and_nothing_is_lost(self):
        client = FakeQdrant(fail={0: 1})                                         # the first batch fails once
        with patch("time.sleep"):
            vector_store._upsert_all(client, "c", points(130))
        self.assertEqual(sorted(client.uploaded), list(range(130)))
        self.assertEqual(client.attempts, 4)                                     # three batches + one retry

    def test_a_batch_that_keeps_failing_fails_the_upload_instead_of_losing_points_silently(self):
        client = FakeQdrant(fail={0: 99})
        with patch("time.sleep"), self.assertRaises(TimeoutError):
            vector_store._upsert_all(client, "c", points(130))
        self.assertEqual(client.attempts - 2, vector_store.UPSERT_ATTEMPTS)      # the other two batches went up once each

    def test_a_small_upload_is_a_single_request(self):
        client = FakeQdrant()
        vector_store._upsert_all(client, "c", points(10))
        self.assertEqual((client.attempts, sorted(client.uploaded)), (1, list(range(10))))


class SetupOncePerProcessTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        p = patch.object(vector_store, "document_index_dir", lambda owner, doc: Path(temp.name) / owner / doc)
        p.start()
        self.addCleanup(p.stop)
        vector_store._CONFIRMED_COLLECTIONS.clear()
        vector_store._CONFIRMED_INDEXES.clear()
        self.addCleanup(vector_store._CONFIRMED_COLLECTIONS.clear)
        self.addCleanup(vector_store._CONFIRMED_INDEXES.clear)

    def build(self, client, document="11111111-1111-1111-1111-111111111111"):
        chunks = [Document(page_content="alpha beta", metadata={"chunk_id": 0}), Document(page_content="gamma delta", metadata={"chunk_id": 1})]
        vector_store.build_hybrid_indices(chunks, document_id=document, owner_id="o", vectors=[[0.1, 0.2], [0.3, 0.4]],
                                          embeddings=Mock(), client=client)

    def test_the_collection_and_its_indexes_are_checked_on_the_first_upload_only(self):
        client = Mock()
        client.collection_exists.return_value = True
        self.build(client)
        first = (client.collection_exists.call_count, client.create_payload_index.call_count)
        self.assertEqual(first, (1, 3))
        self.build(client, "22222222-2222-2222-2222-222222222222")
        self.assertEqual((client.collection_exists.call_count, client.create_payload_index.call_count), first)   # no repeat
        self.assertEqual(client.upsert.call_count, 2)                                                           # but both documents were uploaded

    def test_a_different_collection_is_still_checked(self):
        client = Mock()
        client.collection_exists.return_value = True
        self.build(client)
        with patch.dict("os.environ", {"QDRANT_COLLECTION": "another"}):
            self.build(client, "33333333-3333-3333-3333-333333333333")
        self.assertEqual(client.collection_exists.call_count, 2)

    def test_the_startup_check_counts_so_the_first_upload_does_not_repeat_it(self):
        client = Mock()
        client.collection_exists.return_value = True
        vector_store.ensure_payload_indexes(client, "chunks_collection_v2")
        calls = client.create_payload_index.call_count
        with patch.dict("os.environ", {"QDRANT_COLLECTION": "chunks_collection_v2"}):
            self.build(client)
        self.assertEqual(client.create_payload_index.call_count, calls)


class EmbedOnceTest(unittest.TestCase):
    def service(self):
        service = RAGService.__new__(RAGService)
        service.embedding_provider = Mock()
        service.embedding_provider.embed_documents.side_effect = lambda texts: [[float(len(t))] for t in texts]
        return service

    def test_identical_texts_are_embedded_once_and_every_chunk_gets_its_vector_in_order(self):
        service = self.service()
        vectors = service._embed_all(["aa", "b", "aa", "aa", "ccc", "b"])
        self.assertEqual(service.embedding_provider.embed_documents.call_args.args[0], ["aa", "b", "ccc"])
        self.assertEqual(vectors, [[2.0], [1.0], [2.0], [2.0], [3.0], [1.0]])

    def test_all_distinct_texts_are_passed_through_untouched(self):
        service = self.service()
        service._embed_all(["x", "yy", "zzz"])
        self.assertEqual(service.embedding_provider.embed_documents.call_args.args[0], ["x", "yy", "zzz"])

    def test_nothing_to_embed_makes_no_call(self):
        service = self.service()
        self.assertEqual(service._embed_all([]), [])
        service.embedding_provider.embed_documents.assert_not_called()


class IndexingClientTest(unittest.TestCase):
    def test_uploads_use_a_longer_timeout_than_lookups_and_the_client_is_built_once(self):
        service = RAGService.__new__(RAGService)
        service.qdrant = Mock(name="lookup client")
        service.settings = SimpleNamespace(qdrant_url="https://q.example", qdrant_api_key="k", qdrant_collection="c")
        with patch.object(service_module, "QdrantClient") as factory:
            first = service._indexing_client()
            second = service._indexing_client()
        self.assertIs(first, second)
        factory.assert_called_once()
        self.assertEqual(factory.call_args.kwargs["timeout"], 90.0)
        self.assertIsNot(first, service.qdrant)

    def test_without_a_configured_url_the_ordinary_client_is_used(self):
        service = RAGService.__new__(RAGService)
        service.qdrant = Mock(name="lookup client")
        service.settings = SimpleNamespace(qdrant_collection="c")
        self.assertIs(service._indexing_client(), service.qdrant)


if __name__ == "__main__":
    unittest.main()


class CollectionRemovedWhileRunningTest(SetupOncePerProcessTest):
    def test_a_collection_that_vanished_after_being_confirmed_is_recreated_and_the_upload_succeeds(self):
        client = Mock()
        client.collection_exists.side_effect = [True, False]                    # confirmed once; gone by the time we look again
        self.build(client)                                                      # confirms it
        client.upsert.side_effect = [ValueError("Collection chunks_collection_v2 not found"), None]
        self.build(client, "44444444-4444-4444-4444-444444444444")
        client.create_collection.assert_called_once()                           # recreated
        self.assertEqual(client.upsert.call_count, 3)                           # 1 ok, 1 missing, 1 retried ok

    def test_any_other_upload_error_is_not_swallowed(self):
        client = Mock()
        client.collection_exists.return_value = True
        self.build(client)
        client.upsert.side_effect = RuntimeError("disk full")
        with patch("time.sleep"), self.assertRaises(RuntimeError):
            self.build(client, "55555555-5555-5555-5555-555555555555")
