"""bge-m3 on Cloudflare Workers AI: request shape, batching, the daily free
budget, retries and the capacity error. No network: httpx is stubbed."""

import math
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from APP import db
from APP.providers import embedding as emb


class FakeResponse:
    def __init__(self, status, payload=None, text=""):
        self.status_code = status
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


class FakeClient:
    """Answers each POST with the next queued response, or with vectors of
    the right count when the queue is empty."""

    def __init__(self, queue=None):
        self.queue = list(queue or [])
        self.calls = []

    def post(self, url, json):
        self.calls.append((url, json))
        if self.queue:
            item = self.queue.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        texts = json["text"]
        n = len(texts)
        # Like Workers AI: bills every text padded to the longest (here 1 token per char).
        billed = n * max(len(t) for t in texts)
        return FakeResponse(200, {"success": True, "result": {"shape": [n, 3], "data": [[3.0, 4.0, float(len(t))] for t in texts],
                                                              "meta": {"cost_metric_name_1": "input_tokens", "cost_metric_value_1": billed}}})


class CloudflareEmbeddingTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for p in (patch.object(db, "DB_PATH", Path(tmp.name) / "test.db"),
                  patch.object(emb.time, "sleep", lambda s: None),
                  patch.dict(os.environ, {"CLOUDFLARE_ACCOUNT_ID": "acct123", "CLOUDFLARE_API_TOKEN": "tok"})):
            p.start()
            self.addCleanup(p.stop)
        db.init_db()
        ledger = patch.object(emb, "_LEDGER", emb._DailyTokenLedger())
        ledger.start()
        self.addCleanup(ledger.stop)
        self.addCleanup(lambda: emb._LEDGER.save())   # runs first: no write left in flight at cleanup
        self.provider = emb.CloudflareEmbeddingProvider()
        self.client = FakeClient()
        self.provider._client = self.client

    def test_calls_bge_m3_on_the_account_and_normalises(self):
        vectors = self.provider.embed_documents(["a", "b"])
        url, body = self.client.calls[0]
        self.assertEqual(url, "https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/baai/bge-m3")
        self.assertEqual(body, {"text": ["a", "b"], "truncate_inputs": True})
        self.assertEqual(len(vectors), 2)
        for v in vectors:
            self.assertAlmostEqual(math.sqrt(sum(x * x for x in v)), 1.0)

    def test_query_is_one_text(self):
        self.assertEqual(len(self.provider.embed_query("hello")), 3)
        self.assertEqual(self.client.calls[0][1]["text"], ["hello"])

    def test_splits_into_batches_and_keeps_order(self):
        texts = [f"t{i}" for i in range(emb.CLOUDFLARE_BATCH_SIZE * 2 + 5)]
        vectors = self.provider.embed_documents(texts)
        self.assertEqual(len(self.client.calls), 3)
        self.assertEqual(sorted(t for _, b in self.client.calls for t in b["text"]), sorted(texts))
        # Each vector belongs to its own text (the fake encodes length in the last value).
        for text, v in zip(texts, vectors):
            self.assertAlmostEqual(v[2] / v[0], len(text) / 3.0)

    def test_groups_texts_of_similar_length(self):
        texts = ["s" * 10, "L" * 3000, "s" * 12, "L" * 3100]
        self.provider.embed_documents(texts)
        sent = [b["text"] for _, b in self.client.calls]
        self.assertEqual(len(sent), 1)
        self.assertEqual([len(t) for t in sent[0]], [10, 12, 3000, 3100])   # short ones together, not padded behind long ones

    def test_keeps_each_request_under_the_padded_limit(self):
        texts = ["x" * 2000] * 40
        with patch.object(emb, "CLOUDFLARE_MAX_PADDED_TOKENS", 10000):
            self.provider.embed_documents(texts)
        for _, body in self.client.calls:
            self.assertLessEqual(len(body["text"]) * max(emb.estimated_tokens(t) for t in body["text"]), 10000)

    def test_budget_counts_what_cloudflare_billed(self):
        self.provider.embed_documents(["a" * 100, "b" * 50])
        self.assertEqual(emb._LEDGER.used(self.provider._day()), 2 * 100)   # the reported padded tokens, not our overestimate

    def test_the_count_is_saved_off_the_request_path_and_survives_a_restart(self):
        self.provider.embed_documents(["a" * 100])
        emb._LEDGER.save()
        day = self.provider._day()
        with db._connect() as conn:
            row = conn.execute("SELECT used FROM usage_daily WHERE day = ? AND kind = 'cloudflare_embedding_tokens'", (day,)).fetchone()
        self.assertEqual(row["used"], 100)
        self.assertEqual(emb._DailyTokenLedger().used(day), 100)   # a new process after scale-to-zero

    def test_a_failed_request_gives_its_reservation_back(self):
        self.client.queue = [FakeResponse(400, text="bad")]
        with self.assertRaises(RuntimeError):
            self.provider.embed_documents(["a" * 100])
        self.assertEqual(emb._LEDGER.used(self.provider._day()), 0)

    def test_budget_is_80_percent_of_the_free_allowance(self):
        self.assertEqual(emb.CLOUDFLARE_DAILY_NEURON_BUDGET, 8000)
        self.assertEqual(emb.daily_token_budget(), int(8000 * 1_000_000 / 1075))

    def test_estimate_never_undercounts_dense_text(self):
        # Real bge-m3 counts measured with its tokenizer.
        for text, real in (("根据公司差旅政策，员工可以乘坐火车二等座，酒店费用每晚不超过四百元。", 25),
                           ("4,022 | 3.1 | 98.6% | 2026-10-07 | INV-000123 | ₹1,23,456.78", 35)):
            self.assertGreaterEqual(emb.estimated_tokens(text), real)

    def test_retries_transient_failures(self):
        self.client.queue = [FakeResponse(503, text="busy"), ConnectionError("reset"), FakeResponse(502)]
        self.assertEqual(len(self.provider.embed_documents(["a"])), 1)
        self.assertEqual(len(self.client.calls), 4)

    def test_gives_up_after_the_last_attempt(self):
        self.client.queue = [FakeResponse(503)] * emb.CLOUDFLARE_ATTEMPTS
        with self.assertRaises(RuntimeError):
            self.provider.embed_documents(["a"])

    def test_cloudflare_daily_limit_becomes_the_capacity_error(self):
        self.client.queue = [FakeResponse(429, text='{"errors":[{"code":4006,"message":"you have used up your daily free allocation of 10,000 neurons"}]}')]
        with self.assertRaises(emb.EmbeddingCapacityError):
            self.provider.embed_documents(["a"])
        self.assertEqual(len(self.client.calls), 1)

    def test_bad_request_is_not_retried(self):
        self.client.queue = [FakeResponse(400, text="bad")]
        with self.assertRaises(RuntimeError):
            self.provider.embed_documents(["a"])
        self.assertEqual(len(self.client.calls), 1)

    def test_wrong_vector_count_is_an_error(self):
        self.client.queue = [FakeResponse(200, {"result": {"data": [[1.0]]}})]
        with self.assertRaises(RuntimeError):
            self.provider.embed_documents(["a", "b"])

    def test_needs_both_settings(self):
        with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": ""}):
            with self.assertRaises(RuntimeError):
                emb.CloudflareEmbeddingProvider()

    def test_backend_setting_picks_the_provider(self):
        with patch.object(emb, "EMBEDDING_BACKEND", "cloudflare"):
            self.assertIsInstance(emb.build_default_embedding_provider(), emb.CloudflareEmbeddingProvider)
        with patch.object(emb, "EMBEDDING_BACKEND", "torch"), patch.object(emb, "_local_model_installed", return_value=True):
            self.assertIsInstance(emb.build_default_embedding_provider(), emb.BgeEmbeddingProvider)

    def test_a_leftover_local_setting_uses_cloudflare_when_the_model_is_not_installed(self):
        with patch.object(emb, "EMBEDDING_BACKEND", "torch"), patch.object(emb, "_local_model_installed", return_value=False):
            self.assertIsInstance(emb.build_default_embedding_provider(), emb.CloudflareEmbeddingProvider)
            with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": ""}):
                provider = emb.build_default_embedding_provider()   # the app still starts...
                with self.assertRaises(RuntimeError):
                    provider.embed_query("q")                         # ...only embedding fails

    def test_missing_cloudflare_settings_never_stop_the_app_starting(self):
        with patch.object(emb, "EMBEDDING_BACKEND", "cloudflare"), patch.dict(os.environ, {"CLOUDFLARE_ACCOUNT_ID": ""}):
            provider = emb.build_default_embedding_provider()
            self.assertIsInstance(provider, emb.UnavailableEmbeddingProvider)
            with self.assertRaisesRegex(RuntimeError, "CLOUDFLARE_ACCOUNT_ID"):
                provider.embed_documents(["a"])

    def test_simultaneous_ledger_reservations_never_overshoot(self):
        import threading
        ledger, granted = emb._DailyTokenLedger(), []
        threads = [threading.Thread(target=lambda: granted.append(ledger.reserve("2026-10-07", 10, 100))) for _ in range(25)]
        [t.start() for t in threads]; [t.join() for t in threads]
        self.assertEqual(granted.count(True), 10)

    def test_simultaneous_reservations_never_overshoot(self):
        import threading
        granted = []
        def go():
            granted.append(db.add_daily_amount("2026-10-07", "cloudflare_embedding_tokens", 10, cap=100))
        threads = [threading.Thread(target=go) for _ in range(25)]
        [t.start() for t in threads]; [t.join() for t in threads]
        self.assertEqual(granted.count(True), 10)


class CapacityErrorReachesThePerson(unittest.TestCase):
    def test_query_search_does_not_swallow_it(self):
        from APP.rag.vector_store import QdrantVectorStore  # noqa: F401 (import check)
        from APP.rag import vector_store as vs

        class Exhausted:
            def embed_documents(self, texts):
                raise emb.EmbeddingCapacityError("used up")
            def embed_query(self, text):  # must not be reached
                raise AssertionError("retried after a capacity error")

        store = vs.QdrantVectorStore.__new__(vs.QdrantVectorStore)
        store.embeddings = Exhausted()
        with self.assertRaises(emb.EmbeddingCapacityError):
            store.similarity_search("q")

    def test_api_answers_503_with_the_message(self):
        from fastapi.testclient import TestClient
        from APP.main import app

        @app.get("/__test_capacity")
        def _boom():
            raise emb.EmbeddingCapacityError("Today's document processing capacity is used up. Please try again tomorrow.")

        r = TestClient(app, raise_server_exceptions=False).get("/__test_capacity")
        self.assertEqual(r.status_code, 503)
        self.assertIn("try again tomorrow", r.json()["detail"])


if __name__ == "__main__":
    unittest.main()
