"""Embedding providers — self-hosted bge-m3 by default, the same bge-m3 hosted
on Cloudflare Workers AI as an option, plain OpenAI for BYO-key.

Both expose embed_documents()/embed_query() returning plain float lists, the
same shape APP/rag/vector_store.py and APP/rag/quality_gate.py already consume
via the old EmbeddingAdapter — swapping providers needs no changes downstream.
"""

from __future__ import annotations

import math
import os
import threading
import time
from datetime import datetime, timezone

DEFAULT_BGE_MODEL = os.getenv("BGE_MODEL_NAME", "BAAI/bge-m3")
DEFAULT_BYO_EMBEDDING_MODEL = os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")

# "torch" (default), "onnx", or "cloudflare" (the same model on Workers AI,
# see CloudflareEmbeddingProvider). For the local backends: "onnx". ONNX Runtime generally beats PyTorch on CPU
# thanks to graph optimisation, and BAAI/bge-m3 publishes prebuilt ONNX
# weights so nothing has to be exported at build time.
#
# Deliberately NOT the default yet: the meaningful INT8 speedup comes from
# AVX512-VNNI kernels, which are x86-only. The dev machine here is arm64, so
# a local benchmark would understate (or misrepresent) what production gets.
# Validate on staging — x86 Container Apps — before flipping the default.
EMBEDDING_BACKEND = os.getenv("EMBEDDING_BACKEND", "torch").strip().lower()

# Measured on 60 real chunks, 10 cores: batch 8 -> 36.2s, 16 -> 40.9s,
# 32 -> 48.6s. Smaller wins because bge-m3 takes long sequences and a big
# batch pads every short text up to the longest one in it.
EMBEDDING_BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "8"))


class EmbeddingProvider:
    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError

    def embed_query(self, text: str) -> list[float]:
        raise NotImplementedError


class BgeEmbeddingProvider(EmbeddingProvider):
    """Self-hosted BAAI/bge-m3 via sentence-transformers, CPU-only — no
    Azure resource, no per-token API cost. Loaded lazily on first use since
    the model weights (~2GB) shouldn't be pulled at process startup.
    """

    def __init__(self, model_name: str = DEFAULT_BGE_MODEL, backend: str = EMBEDDING_BACKEND):
        self.model_name = model_name
        self.backend = backend
        self._model = None
        # Double-checked locking, and the lock is not optional: ingest embeds
        # via a ThreadPoolExecutor, so without it every worker sees
        # `_model is None` at once and each loads its own 2.3GB copy of the
        # model. Measured cost of that race on a 44-page PDF: 3 concurrent
        # loads, ~5m00s total ingest versus ~1m30s once serialised.
        self._load_lock = threading.Lock()

    def _load(self):
        if self._model is not None:
            return self._model

        with self._load_lock:
            if self._model is not None:  # another thread won the race
                return self._model

            from sentence_transformers import SentenceTransformer

            print(f"🔄 Loading self-hosted embedding model: {self.model_name} (backend={self.backend})...")
            model = None
            if self.backend == "onnx":
                try:
                    model = SentenceTransformer(self.model_name, device="cpu", backend="onnx")
                except Exception as exc:
                    # A missing/incompatible ONNX artifact must not take ingest
                    # down — PyTorch weights always work, just slower.
                    print(f"⚠️ ONNX backend unavailable ({exc}); falling back to torch")
            if model is None:
                model = SentenceTransformer(self.model_name, device="cpu")
            print(f"✅ Self-hosted embedding model ready: {self.model_name}")
            # Publish only once fully constructed, so no other thread can see
            # a half-initialised model through the fast path above.
            self._model = model
            return self._model

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        model = self._load()
        # One call for the whole list: sentence-transformers batches internally
        # AND sorts by length first, so short texts aren't padded up to the
        # longest in an arbitrary caller-made batch. Hand-splitting the work
        # across threads defeats that and oversubscribes the CPU, since torch
        # already parallelises across every core.
        vectors = model.encode(
            texts,
            normalize_embeddings=True,
            show_progress_bar=False,
            batch_size=EMBEDDING_BATCH_SIZE,
        )
        return vectors.tolist()

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]


class EmbeddingCapacityError(RuntimeError):
    """Today's embedding allowance is used up. Nothing is charged: the
    caller should tell the person to try again tomorrow."""


CLOUDFLARE_MODEL = os.getenv("CLOUDFLARE_EMBEDDING_MODEL", "@cf/baai/bge-m3")
# Workers AI's free plan gives 10,000 neurons a day and refuses requests
# beyond that (no billing without the paid plan). bge-m3 costs 1,075 neurons
# per million input tokens. We stop at 80% of the free allowance ourselves,
# so Cloudflare's own limit is never the thing that fails a request.
CLOUDFLARE_NEURONS_PER_M_TOKENS = 1075
CLOUDFLARE_DAILY_NEURON_BUDGET = int(os.getenv("CLOUDFLARE_DAILY_NEURON_BUDGET", "8000"))
CLOUDFLARE_BATCH_SIZE = int(os.getenv("CLOUDFLARE_EMBEDDING_BATCH_SIZE", "32"))
# Workers AI pads every text in a request to the longest one, bills the
# padded total, and refuses a request over 60,000 padded tokens (measured).
# Requests are grouped by length and kept under this, by our overestimate.
CLOUDFLARE_MAX_PADDED_TOKENS = int(os.getenv("CLOUDFLARE_MAX_PADDED_TOKENS", "48000"))
CLOUDFLARE_TIMEOUT_SECONDS = float(os.getenv("CLOUDFLARE_TIMEOUT_SECONDS", "60"))
CLOUDFLARE_ATTEMPTS = 4


def estimated_tokens(text: str) -> int:
    """An upper estimate of bge-m3 tokens without loading its tokenizer.
    Measured with the real tokenizer: English prose runs ~4 characters per
    token, tables and code ~2.5, Chinese, long numbers and URLs as low as
    ~1.4. One token per 1.25 characters stays above all of them, so the
    budget can only stop early, never late."""
    return math.ceil(len(text) / 1.25) + 2


def daily_token_budget() -> int:
    return int(CLOUDFLARE_DAILY_NEURON_BUDGET * 1_000_000 / CLOUDFLARE_NEURONS_PER_M_TOKENS)


class _DailyTokenLedger:
    """Today's Cloudflare token count, kept in memory and saved in the
    background.

    The database lives on Azure Files, where each write takes 60-90 ms
    (measured in the container); writing it twice per question added
    ~150-300 ms to a 115 ms embedding call. The app runs as one process on
    one replica, so the in-memory count is authoritative while it runs; it
    is loaded from the database once per day and process, and changes are
    written back off the request path. A restart can lose at most the last
    unsaved few hundred tokens, and Cloudflare's own free-plan limit still
    refuses (never bills) anything beyond the allowance.
    """

    KIND = "cloudflare_embedding_tokens"

    def __init__(self):
        self._lock = threading.Lock()
        self._day: str | None = None
        self._used = 0
        self._unsaved = 0
        self._save_lock = threading.Lock()   # one save at a time; save() waits for one in flight

    def _roll(self, day: str) -> None:
        if self._day == day:
            return
        from APP import db

        try:
            with db._connect() as conn:
                row = conn.execute("SELECT used FROM usage_daily WHERE day = ? AND kind = ?", (day, self.KIND)).fetchone()
            self._used = row["used"] if row else 0
        except Exception:
            self._used = 0
        self._day, self._unsaved = day, 0

    def reserve(self, day: str, tokens: int, cap: int) -> bool:
        with self._lock:
            self._roll(day)
            if self._used + tokens > cap:
                return False
            self._used += tokens
            self._unsaved += tokens
            return True

    def adjust(self, day: str, delta: int) -> None:
        with self._lock:
            if self._day != day:
                return  # the day rolled over mid-upload; yesterday's count no longer matters
            self._used = max(self._used + delta, 0)
            self._unsaved += delta

    def used(self, day: str) -> int:
        with self._lock:
            self._roll(day)
            return self._used

    def save_soon(self) -> None:
        """Writes unsaved changes in a background thread, off the request path."""
        with self._lock:
            if not self._unsaved:
                return
        if self._save_lock.locked():
            return  # the save in flight picks these up before it finishes
        threading.Thread(target=self.save, name="cloudflare-ledger", daemon=True).start()

    def save(self) -> None:
        """Writes unsaved changes now (waiting for a save already in flight)."""
        from APP import db

        with self._save_lock:
            while True:
                with self._lock:
                    day, amount = self._day, self._unsaved
                    self._unsaved = 0
                if not amount or day is None:
                    return
                try:
                    db.add_daily_amount(day, self.KIND, amount, cap=2**62)
                except Exception:
                    with self._lock:
                        if self._day == day:
                            self._unsaved += amount  # retried by the next save
                    return


_LEDGER = _DailyTokenLedger()


class CloudflareEmbeddingProvider(EmbeddingProvider):
    """BAAI/bge-m3 on Cloudflare Workers AI, called over its REST API.

    Same model, same 1024-dimension normalised vectors as BgeEmbeddingProvider,
    so collections built by either one stay searchable by the other. Nothing
    is stored at Cloudflare. Settings: CLOUDFLARE_ACCOUNT_ID and
    CLOUDFLARE_API_TOKEN (a token that can only use Workers AI).
    """

    def __init__(self, account_id: str | None = None, api_token: str | None = None, model: str = CLOUDFLARE_MODEL):
        self.account_id = (account_id or os.getenv("CLOUDFLARE_ACCOUNT_ID", "")).strip()
        self.api_token = (api_token or os.getenv("CLOUDFLARE_API_TOKEN", "")).strip()
        if not self.account_id or not self.api_token:
            raise RuntimeError("EMBEDDING_BACKEND=cloudflare needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN")
        self.model = model
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{self.account_id}/ai/run/{model}"
        self._client = None
        self._client_lock = threading.Lock()

    def _http(self):
        with self._client_lock:
            if self._client is None:
                import httpx

                self._client = httpx.Client(
                    timeout=CLOUDFLARE_TIMEOUT_SECONDS,
                    headers={"Authorization": f"Bearer {self.api_token}"},
                )
            return self._client

    @staticmethod
    def _day() -> str:
        return datetime.now(timezone.utc).date().isoformat()  # Cloudflare resets at 00:00 UTC

    def _reserve(self, tokens: int) -> str:
        day = self._day()
        if not _LEDGER.reserve(day, tokens, daily_token_budget()):
            raise EmbeddingCapacityError("Today's document processing capacity is used up. Please try again tomorrow.")
        return day

    @staticmethod
    def _settle(day: str, reserved: int, billed: int | None) -> None:
        """Replaces a batch's reservation with what Cloudflare reports it
        billed (each response says), or gives it back if nothing was billed."""
        actual = reserved if billed is None else billed
        if actual != reserved:
            _LEDGER.adjust(day, actual - reserved)

    @staticmethod
    def _batches(texts: list[str]) -> list[list[int]]:
        """Indices grouped by length, so short chunks aren't padded up to long
        ones, with each group under the padded-token limit."""
        est = [estimated_tokens(t) for t in texts]
        groups: list[list[int]] = []
        current: list[int] = []
        for i in sorted(range(len(texts)), key=lambda k: est[k]):
            if current and (len(current) == CLOUDFLARE_BATCH_SIZE
                            or (len(current) + 1) * est[i] > CLOUDFLARE_MAX_PADDED_TOKENS):
                groups.append(current)
                current = []
            current.append(i)
        if current:
            groups.append(current)
        return groups

    def _run(self, texts: list[str]) -> tuple[list[list[float]], int | None]:
        delay = 1.0
        for attempt in range(CLOUDFLARE_ATTEMPTS):
            last = attempt == CLOUDFLARE_ATTEMPTS - 1
            try:
                response = self._http().post(self.url, json={"text": texts, "truncate_inputs": True})
            except Exception:
                if last:
                    raise
                time.sleep(delay)
                delay *= 2
                continue
            if response.status_code == 200:
                result = response.json().get("result", {})
                data = result.get("data")
                if not isinstance(data, list) or len(data) != len(texts):
                    raise RuntimeError("Cloudflare returned an unexpected embedding response")
                billed = (result.get("meta") or {}).get("cost_metric_value_1")
                return data, (int(billed) if isinstance(billed, (int, float)) else None)
            body = response.text[:300]
            # The free plan answers 429 once the day's allowance is gone; our own
            # budget should stop us first, but treat it the same way.
            if response.status_code == 429 and ("neuron" in body.lower() or "4006" in body):
                raise EmbeddingCapacityError("Today's document processing capacity is used up. Please try again tomorrow.")
            if response.status_code in (408, 429, 500, 502, 503, 504) and not last:
                time.sleep(delay)
                delay *= 2
                continue
            raise RuntimeError(f"Cloudflare embedding request failed: HTTP {response.status_code}")
        raise RuntimeError("Cloudflare embedding request failed")

    @staticmethod
    def _normalise(vector: list[float]) -> list[float]:
        norm = math.sqrt(sum(x * x for x in vector)) or 1.0
        return [x / norm for x in vector]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        groups = self._batches(texts)
        # Reserve the padded size of every request up front (an overestimate),
        # so a document is either embedded whole or refused before any call.
        padded = [len(g) * max(estimated_tokens(texts[i]) for i in g) for g in groups]
        day = self._reserve(sum(padded))

        def run(n: int) -> list[list[float]]:
            try:
                vectors, billed = self._run([texts[i] for i in groups[n]])
            except Exception:
                self._settle(day, padded[n], 0)
                _LEDGER.save_soon()
                raise
            self._settle(day, padded[n], billed)
            return vectors

        if len(groups) == 1:
            results = [run(0)]
        else:
            # A few requests in flight at once: a 30-page upload is a handful
            # of requests, and waiting on each in turn would add up.
            from concurrent.futures import ThreadPoolExecutor

            with ThreadPoolExecutor(max_workers=min(4, len(groups))) as pool:
                results = list(pool.map(run, range(len(groups))))
        _LEDGER.save_soon()
        out: list[list[float] | None] = [None] * len(texts)
        for group, vectors in zip(groups, results):
            for i, v in zip(group, vectors):
                out[i] = self._normalise(v)
        return out  # type: ignore[return-value]

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]


class OpenAIEmbeddingProvider(EmbeddingProvider):
    """BYO-key — constructed per-request from a header, never persisted."""

    def __init__(self, api_key: str | None, model: str = DEFAULT_BYO_EMBEDDING_MODEL):
        self.api_key = api_key
        self.model = model
        self._backend = None

    def _load(self):
        if self._backend is None:
            from langchain_openai import OpenAIEmbeddings

            self._backend = OpenAIEmbeddings(model=self.model, api_key=self.api_key)
        return self._backend

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        return self._load().embed_documents(texts)

    def embed_query(self, text: str) -> list[float]:
        return self._load().embed_query(text)


class UnavailableEmbeddingProvider(EmbeddingProvider):
    """Stands in when embeddings aren't configured, so the app still starts
    (health checks, sign-in, the workspace) and only embedding fails, with
    the reason. The deploy's smoke test embeds once, so this never reaches
    users unnoticed."""

    def __init__(self, reason: str):
        self.reason = reason
        print(f"⚠️ Embeddings unavailable: {reason}")

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        raise RuntimeError(self.reason)

    def embed_query(self, text: str) -> list[float]:
        raise RuntimeError(self.reason)


def _cloudflare_configured() -> bool:
    return bool(os.getenv("CLOUDFLARE_ACCOUNT_ID", "").strip() and os.getenv("CLOUDFLARE_API_TOKEN", "").strip())


def _local_model_installed() -> bool:
    import importlib.util

    return importlib.util.find_spec("sentence_transformers") is not None


def build_default_embedding_provider() -> EmbeddingProvider:
    if EMBEDDING_BACKEND == "cloudflare":
        if not _cloudflare_configured():
            return UnavailableEmbeddingProvider("EMBEDDING_BACKEND=cloudflare needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN")
        return CloudflareEmbeddingProvider()
    if not _local_model_installed():
        # The API image ships without torch. A leftover EMBEDDING_BACKEND=torch
        # (say, an older environment setting) would otherwise fail on the first
        # upload; the same model on Cloudflare gives the same vectors.
        if _cloudflare_configured():
            print(f"⚠️ EMBEDDING_BACKEND={EMBEDDING_BACKEND} but the local model isn't installed; using bge-m3 on Cloudflare")
            return CloudflareEmbeddingProvider()
        return UnavailableEmbeddingProvider(
            f"EMBEDDING_BACKEND={EMBEDDING_BACKEND} needs the local model (pip install sentence-transformers), "
            "or set EMBEDDING_BACKEND=cloudflare with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN")
    return BgeEmbeddingProvider()
