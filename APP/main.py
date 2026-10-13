from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import AsyncIterator
from uuid import uuid4

import structlog
import uvicorn
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

import html
from urllib.parse import quote
import sqlite3

from APP import access_control as ac
from APP import account_access as access
from APP import activity, auth, db, email_policy, jobs, presence, usage
from APP.health import DependencyMonitor
from APP.demo_access import DemoRequest, approve_email, deliver_demo_request, notify_admin_of_pending_account
from APP.rag import originals
from APP.rag.evidence import LIMITED_CONTEXT, UNVERIFIED_ANSWER
import shutil
import tempfile
from APP.auth import email as otp_email
from APP.rag.service import RAGService
from APP.rag.evidence import codepoint_offset
from APP.rag.vector_store import warm_reranker
from APP.providers.embedding import EmbeddingCapacityError
from APP.auth import get_current_user
from APP.auth.service import refuse_suspended
from APP import admin as admin_api
from APP.jobs import job_store
from APP.schemas import (
    AuthTokenResponse,
    ChatTurnSummary,
    DeleteDocumentResponse,
    DocumentSummary,
    GoogleOAuthCallbackRequest,
    HealthStatus,
    HeartbeatRequest,
    PresenceSignal,
    LoginCodeRequest,
    LoginCodeResendRequest,
    IngestJobStatus,
    IngestResponse,
    LoginRequest,
    OAuthCallbackRequest,
    PrivacyPolicyAcceptanceResponse,
    QueryRequest,
    QueryResponse,
    RequestPasswordResetRequest,
    ResendOtpRequest,
    ResetPasswordRequest,
    ApprovalRequest,
    SignupRequest,
    StateRecord,
    StateWriteRequest,
    StateWriteResult,
    DocumentPage,
    Annotation,
    AnnotationCreate,
    AnnotationUpdate,
    Note,
    NoteRevisionSummary,
    NoteSaveRequest,
    VerifyOtpRequest,
)

# A single workspace record (the catalog, or one conversation) is small JSON.
# The cap stops a runaway client from writing megabytes into a metadata row.
MAX_STATE_BYTES = 2_000_000


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

# In-memory OTP resend cooldown — Phase 1's stopgap ahead of Phase 2's
# general slowapi rate limiting; OTP endpoints are a standing abuse target
# regardless of overall traffic, so this can't wait for Phase 2 to land.
_otp_last_sent: dict[str, float] = {}
_otp_send_lock = threading.Lock()
OTP_RESEND_COOLDOWN_SECONDS = 60
# Wrong codes allowed for one held sign-up before it is discarded.
MAX_CODE_ATTEMPTS = 5


def _claim_otp_slot(email_address: str) -> float | None:
    """Claims the right to send a code to this address now, or returns None
    if one went out within the cooldown. Claimed before sending, under a
    lock: checking first and recording after the email left let presses
    arriving in between each send a code (seen as 2-4 codes for 4 presses)."""
    with _otp_send_lock:
        last = _otp_last_sent.get(email_address)
        now = time.monotonic()
        if last is not None and now - last < OTP_RESEND_COOLDOWN_SECONDS:
            return None
        _otp_last_sent[email_address] = now
        return now

# Same reasoning, same shape, for password-reset requests.
_reset_last_sent: dict[str, float] = {}
RESET_RESEND_COOLDOWN_SECONDS = 60

INGEST_RATE_LIMIT = os.getenv("INGEST_RATE_LIMIT", "10/hour")
QUERY_RATE_LIMIT = os.getenv("QUERY_RATE_LIMIT", "60/hour")
LOGIN_RATE_LIMIT = os.getenv("LOGIN_RATE_LIMIT", "10/minute")
PASSWORD_RESET_RATE_LIMIT = os.getenv("PASSWORD_RESET_RATE_LIMIT", "5/minute")
# New accounts per visitor address per day. Generous enough for a shared
# network (an event's Wi-Fi), tight enough to stop mass sign-ups.
SIGNUP_RATE_LIMIT = os.getenv("SIGNUP_RATE_LIMIT", "20/day")

# Opt-in rather than environment-sniffed: there's no reliable signal in this
# codebase today for "this is the production deployment" (staging and prod
# run the same image), so defaulting to disabled would silently turn /docs
# off everywhere, including local dev, until someone noticed. Set
# DISABLE_API_DOCS=true on the production Container App to turn it off there.
DISABLE_API_DOCS = os.getenv("DISABLE_API_DOCS", "false").strip().lower() in ("1", "true", "yes")

# Starlette's UploadFile spools to disk past its threshold, so a huge upload
# doesn't blow up memory — but it still costs disk, network and embedding
# time. This is the same bound both /ingest routes read from raw_bytes.
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))

# Bump this to re-prompt every signed-in user for consent, even ones who
# already accepted an older version — db.has_accepted_privacy_policy compares
# against this exact string, not just "accepted at all".
PRIVACY_POLICY_VERSION = os.getenv("PRIVACY_POLICY_VERSION", "1.0")


def _checked_upload_size(file: UploadFile) -> None:
    """Rejects an oversized upload using the size the server already knows,
    before reading it into memory. The upload itself is spooled to disk."""
    size = file.size
    if size is not None and size > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)}MB upload limit",
        )


def _rate_limit_key(request: Request) -> str:
    """Keys rate limits by the authenticated user, not IP — login is
    mandatory, so every request that reaches these routes has one. Decodes
    the JWT directly rather than depending on get_current_user's Depends
    result, since slowapi's limit check isn't guaranteed to run after
    FastAPI's own dependency resolution. Falls back to IP only for the
    (already-401-bound) case of a missing/invalid token.
    """
    authorization = request.headers.get("Authorization", "")
    if authorization.startswith("Bearer "):
        try:
            return auth.decode_access_token(authorization.removeprefix("Bearer ").strip())["sub"]
        except Exception:
            pass
    # Behind the ingress proxy every connection has the proxy's address, so
    # this must be the visitor's (last X-Forwarded-For hop), or one limit
    # would be shared by everyone who isn't signed in.
    return ac.client_ip(request)


limiter = Limiter(key_func=_rate_limit_key)


structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(20),
    cache_logger_on_first_use=True,
)
logger = structlog.get_logger("rag_api")

# Serialises the check-and-set in /warmup so concurrent callers can't each
# start their own model load.
_warmup_lock = threading.Lock()

# At most this many documents are parsed and embedded at once. Each ingest is
# CPU- and memory-heavy (local parsing, embedding batches) and the replica has
# 2 vCPUs, so an unbounded burst of uploads slowed every other request.
INGEST_CONCURRENCY = max(1, int(os.getenv("INGEST_CONCURRENCY", "2")))
_ingest_pool = ThreadPoolExecutor(max_workers=INGEST_CONCURRENCY, thread_name_prefix="ingest")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    db.init_db()
    service = RAGService()
    app.state.rag_service = service
    from APP.extraction.worker import Worker, enabled
    app.state.evidence_worker = Worker(service) if enabled() else None
    if app.state.evidence_worker:
        app.state.evidence_worker.start()
    app.state.collection_exists = service.collection_exists()
    if app.state.collection_exists:
        # The search filters need their payload indexes before the first
        # question, including indexes added by this release.
        from APP.rag.vector_store import ensure_payload_indexes

        async def _ensure_indexes() -> None:
            try:
                await asyncio.to_thread(ensure_payload_indexes, service.qdrant, service.settings.qdrant_collection)
            except Exception:  # noqa: BLE001 — never block or fail startup over it; searches recover on their own
                logger.exception("payload_indexes_not_ensured")
        # In the background: it must not add to the cold start.
        app.state.ensure_indexes_task = asyncio.create_task(_ensure_indexes())
    # Dependency probes run on their own thread from the start, so the first
    # /ready after a cold start reflects a real check rather than a guess.
    app.state.dependency_monitor = DependencyMonitor(service.settings.chat_health_ttl)
    app.state.dependency_monitor.start(lambda: app.state.rag_service)
    logger.info(
        "startup_complete",
        collection_name=service.settings.qdrant_collection,
        collection_exists=app.state.collection_exists,
    )
    activity.requests_counter.start()
    activity.record("server.start", detail={
        "startup_ms": round((datetime.now(timezone.utc) - activity.STARTED_AT).total_seconds() * 1000),
        "revision": os.getenv("CONTAINER_APP_REVISION"), "commit": os.getenv("DEPLOYED_COMMIT"),
    })
    try:
        yield
    finally:
        if app.state.evidence_worker:
            app.state.evidence_worker.stop()
        app.state.dependency_monitor.stop()
        activity.requests_counter.stop()
        logger.info("shutdown_complete")


# Questions the system could not answer are given back, up to this many per account per day.
FREE_UNANSWERED_PER_DAY = 5


def create_app() -> FastAPI:
    app = FastAPI(
        title="Local RAG API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None if DISABLE_API_DOCS else "/docs",
        redoc_url=None if DISABLE_API_DOCS else "/redoc",
        openapi_url=None if DISABLE_API_DOCS else "/openapi.json",
    )

    default_origins = "https://your-org.github.io,http://localhost:3000"
    allowed_origins = [
        origin.strip()
        for origin in os.getenv("CORS_ALLOWED_ORIGINS", default_origins).split(",")
        if origin.strip()
    ]

    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    @app.middleware("http")
    async def request_context_middleware(request: Request, call_next):
        request_id = request.headers.get("X-Request-ID", str(uuid4()))
        start = time.perf_counter()
        request.state.request_id = request_id
        response = None
        try:
            response = await call_next(request)
            return response
        except Exception:
            # Handled here rather than left to Starlette's ServerErrorMiddleware.
            # That one sits outside every user middleware, including CORS, so the
            # 500 it produces carries no Access-Control-Allow-Origin — the browser
            # then blocks the response and the caller sees a generic network
            # failure instead of the actual error. Returning it from inside means
            # CORS still wraps it and the real detail reaches the client.
            logger.exception("unhandled_exception", request_id=request_id)
            response = JSONResponse(
                status_code=500,
                content={"detail": "Internal server error", "request_id": request_id},
            )
            return response
        finally:
            duration_ms = round((time.perf_counter() - start) * 1000, 2)
            status_code = getattr(response, "status_code", 500)
            activity.requests_counter.add(request.url.path, status_code)
            if response is not None:
                response.headers["X-Request-ID"] = request_id
                response.headers["X-Content-Type-Options"] = "nosniff"
                response.headers["X-Frame-Options"] = "DENY"
                response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
            logger.info(
                "request_complete",
                request_id=request_id,
                method=request.method,
                path=request.url.path,
                status_code=status_code,
                duration_ms=duration_ms,
            )

    # Added last on purpose: add_middleware prepends, so the last one registered
    # ends up outermost and therefore wraps the error handling above.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=False,  # no cookies used; wildcard+credentials was invalid anyway
        # PUT is what the workspace state store writes with; without it the
        # browser's preflight fails before the request is ever sent.
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Content-Type", "Authorization", "X-Request-ID", "X-OpenAI-Api-Key"],
        # Lets the workspace tell a demo limit apart from a rate limit (both 429).
        expose_headers=["X-Citely-Limit", "X-Citely-Account", "X-Request-ID"],
        # Every authenticated call needs a preflight, cached per address; the
        # default 10 minutes meant one extra round trip per view after a short
        # break. Two hours is the most Chrome keeps one.
        max_age=7200,
    )

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        request_id = getattr(request.state, "request_id", str(uuid4()))
        logger.warning(
            "http_exception",
            request_id=request_id,
            status_code=exc.status_code,
            detail=str(exc.detail),
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail, "request_id": request_id},
            headers=getattr(exc, "headers", None),   # e.g. Retry-After, X-Citely-Limit
        )

    @app.exception_handler(EmbeddingCapacityError)
    async def embedding_capacity_handler(request: Request, exc: EmbeddingCapacityError):
        # The free embedding allowance for today is used up; nothing failed
        # that a retry tomorrow won't fix.
        request_id = getattr(request.state, "request_id", str(uuid4()))
        logger.warning("embedding_capacity_reached", request_id=request_id)
        return JSONResponse(status_code=503, content={"detail": str(exc), "request_id": request_id})

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        request_id = getattr(request.state, "request_id", str(uuid4()))
        logger.exception("unhandled_exception", request_id=request_id)
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error", "request_id": request_id},
        )

    def get_service(request: Request) -> RAGService:
        service = getattr(request.app.state, "rag_service", None)
        if service is None:
            service = RAGService()
            request.app.state.rag_service = service
            request.app.state.collection_exists = service.collection_exists()
        return service

    def _health_snapshot(request: Request) -> HealthStatus:
        # Reads cached probe results only — never calls a dependency, so this
        # answers instantly even while Qdrant or the chat model is slow.
        monitor = getattr(request.app.state, "dependency_monitor", None)
        if monitor is None:
            # No lifespan (e.g. a bare TestClient): nothing has been probed.
            monitor = DependencyMonitor(60)
        snap = monitor.snapshot()
        deps = snap["dependencies"]
        service = getattr(request.app.state, "rag_service", None)
        settings = getattr(service, "settings", None)
        return HealthStatus(
            status="ok",
            service="rag-api",
            qdrant=deps.get("qdrant", {}).get("state", "unknown"),
            openai=deps.get("openai", {}).get("state", "unknown"),
            collection_name=getattr(settings, "qdrant_collection", None),
            ready=snap["readiness"] == "ready",
            readiness=snap["readiness"],
            dependencies=deps,
            version=os.getenv("IMAGE_VERSION") or os.getenv("GIT_SHA", "unknown"),
            commit=os.getenv("DEPLOYED_COMMIT", "unknown"),
        )

    @app.get("/health", response_model=HealthStatus)
    async def health(request: Request) -> HealthStatus:
        """Liveness: 200 whenever the process can answer. Dependency state is
        included for display, but never checked here."""
        return _health_snapshot(request)

    @app.post("/warmup", status_code=202)
    async def warmup(request: Request) -> dict:
        """Pulls the embedding model and reranker into memory ahead of the first
        question.

        The app runs at minReplicas=0, so an idle period drops the replica and
        the next visitor pays a cold start. /health says nothing about that — it
        touches no model — so before this endpoint existed the entire model-load
        cost landed on whoever asked the first question. Called when the UI
        mounts, it spends that time while the page is being read instead.

        Returns immediately rather than blocking: the caller only needs the work
        started, and a request held open for a model load is exactly the kind of
        thing the ingress times out.
        """
        service = get_service(request)
        state = request.app.state

        # Unauthenticated by design — it has to be callable before sign-in, and
        # on the sign-in page is exactly when starting the wake is most useful.
        # That makes the guard necessary rather than tidy: without it every
        # request would spawn a thread, and a page refreshed a few times would
        # have several model loads racing each other.
        with _warmup_lock:
            if getattr(state, "warm", False):
                return {"status": "warm"}
            if getattr(state, "warming", False):
                return {"status": "warming"}
            state.warming = True

        def _warm() -> None:
            try:
                service.embedding_provider.embed_query("warmup")
                warm_reranker()
                state.warm = True
                logger.info("warmup_complete")
            except Exception:
                # Best-effort: a failed warmup must not affect real requests,
                # which load the same models lazily anyway.
                logger.exception("warmup_failed")
            finally:
                # Cleared either way, so a failed attempt can be retried rather
                # than latching the app into "warming" forever.
                state.warming = False

        threading.Thread(target=_warm, name="warmup", daemon=True).start()
        return {"status": "warming"}

    @app.get("/ready", response_model=HealthStatus)
    async def ready(request: Request):
        """Readiness: 200 only when every dependency's latest probe is "up" and
        fresh. 503 while starting, degraded, or stale, with the same body so the
        caller can show why."""
        status = _health_snapshot(request)
        if not status.ready:
            return JSONResponse(status_code=503, content=status.model_dump())
        return status

    def _reserve_or_429(user, kind: str):
        try:
            return usage.reserve(user, kind)
        except db.UsageLimitReached as exc:
            raise HTTPException(status_code=429, detail=usage.message(exc.kind, exc.scope),
                                headers={"X-Citely-Limit": f"{exc.kind}-{exc.scope}"}) from exc

    def _check_demo_document(user, raw: bytes, filename: str) -> None:
        """Size and page limits for limited accounts, checked before any
        parsing so an oversized document costs nothing."""
        if not usage.is_limited(user):
            return
        if len(raw) > usage.max_upload_bytes():
            raise HTTPException(status_code=413, detail=f"In the demo, files can be up to {usage.max_upload_bytes() // (1024 * 1024)} MB.")
        pages = usage.page_count(raw, filename)
        if pages is not None and pages > usage.max_pages():
            raise HTTPException(status_code=413, detail=f"In the demo, documents can have up to {usage.max_pages()} pages, slides or sheets. This one has {pages}.")

    @app.get("/me/usage")
    def my_usage(current_user=Depends(get_current_user)) -> dict:
        return usage.snapshot(current_user)

    @app.get("/me")
    def me(current_user=Depends(get_current_user)) -> dict:
        return {"id": current_user["id"], "email": current_user["email"], "status": current_user["status"],
                "is_admin": ac.is_admin_email(current_user["email"])}

    @app.get("/me/trusted-browsers")
    def my_trusted_browsers(current_user=Depends(get_current_user)) -> dict:
        return {"items": [dict(r) for r in db.list_trusted_browsers(current_user["id"])]}

    @app.delete("/me/trusted-browsers/{browser_id}")
    def remove_my_trusted_browser(browser_id: str, current_user=Depends(get_current_user)) -> dict:
        if not db.remove_trusted_browser(current_user["id"], browser_id):
            raise HTTPException(status_code=404, detail="Not found.")
        return {"removed": True}

    @app.post("/me/sign-out-everywhere")
    def sign_out_everywhere(request: Request, current_user=Depends(get_current_user)) -> dict:
        db.end_all_sessions(current_user["id"])
        presence.end(current_user["id"])
        activity.record("auth.signed_out_everywhere", request=request, user=current_user)
        return {"signed_out": True}

    @app.post("/me/presence", status_code=204)
    def presence_signal(request: Request, payload: PresenceSignal, current_user=Depends(get_current_user)) -> Response:
        """Where one workspace tab stands: active (about once a minute while
        it is visible and in use), idle, hidden, closed, or signed out in
        this browser. The only source of "online" in the admin console."""
        if payload.state == "signed_out":
            presence.sign_out(current_user["id"], payload.browser, payload.tab)
            return Response(status_code=204)
        if payload.tab is None:
            raise HTTPException(status_code=422, detail="A tab id is required.")
        accepted = presence.signal(current_user["id"], payload.tab, payload.browser, payload.seq, payload.state)
        if accepted and payload.first and payload.state == "active":
            activity.record("session.start", request=request, user=current_user, timezone_name=payload.timezone,
                            detail={"path": payload.path} if payload.path else None)
        return Response(status_code=204)

    @app.post("/me/heartbeat")
    def heartbeat(request: Request, payload: HeartbeatRequest | None = None, current_user=Depends(get_current_user)) -> dict:
        """The previous release's keep-warm ping, still sent by workspace tabs
        opened before an update until they reload. It records the visit but
        not presence: those tabs never say when they are hidden or closed."""
        if payload is not None and payload.first:
            activity.record("session.start", request=request, user=current_user, timezone_name=payload.timezone,
                            detail={"path": payload.path} if payload.path else None)
        return {"ok": True, "status": current_user["status"]}

    @app.post("/ingest", response_model=IngestResponse)
    @limiter.limit(INGEST_RATE_LIMIT)
    def ingest(
        request: Request,
        file: UploadFile = File(...),
        chunk_size: int = Form(1000),
        chunk_overlap: int = Form(150),
        quality_threshold: float = Form(4.0),
        current_user=Depends(get_current_user),
    ) -> IngestResponse:
        service = get_service(request)
        _checked_upload_size(file)
        payload = file.file.read()
        if not payload:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")
        if len(payload) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)}MB upload limit",
            )
        _check_demo_document(current_user, payload, file.filename or "upload")
        day = _reserve_or_429(current_user, usage.UPLOAD)

        try:
            response = service.ingest(
                owner_id=current_user["id"],
                filename=file.filename or "upload",
                raw_bytes=payload,
                chunk_size=chunk_size,
                chunk_overlap=chunk_overlap,
                quality_threshold=quality_threshold,
                max_pages=usage.max_pages() if usage.is_limited(current_user) else None,
            )
        except BaseException as exc:
            usage.release(current_user, usage.UPLOAD, day)
            if isinstance(exc, db.StorageQuotaExceeded):
                raise HTTPException(status_code=413, detail=str(exc)) from exc
            if isinstance(exc, ValueError):
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            if isinstance(exc, RuntimeError):
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            raise

        activity.record("upload", request=request, user=current_user,
                        detail={"kind": getattr(response, "file_type", None), "pages": getattr(response, "pages", None),
                                "bytes": len(payload), "source": "upload"})
        return response.model_copy(update={"request_id": getattr(request.state, "request_id", response.request_id)})

    @app.post("/ingest/async", response_model=IngestJobStatus, status_code=202)
    @limiter.limit(INGEST_RATE_LIMIT)
    def ingest_async(
        request: Request,
        file: UploadFile = File(...),
        chunk_size: int = Form(1000),
        chunk_overlap: int = Form(150),
        quality_threshold: float = Form(4.0),
        client_upload_id: str | None = Form(None, max_length=100),
        current_user=Depends(get_current_user),
    ) -> IngestJobStatus:
        """Non-blocking ingest: returns a job id immediately, poll
        /ingest/jobs/{id} for the outcome.

        POST /ingest stays synchronous and is still fine for ordinary
        documents (a 44-page PDF is ~93s). This exists because ingest time
        scales with document size while Azure Container Apps' ingress cuts
        requests at ~240s, and Phase 3's parser router adds per-file OCR calls
        on top — so large documents need a path that isn't bounded by an HTTP
        timeout at all.
        """
        service = get_service(request)
        _checked_upload_size(file)
        # A queued job waits for a worker as a temp file on the container's own
        # disk (not the SMB share), so a burst of uploads doesn't hold every
        # payload in memory at once. It is read only when the job starts.
        spool = tempfile.NamedTemporaryFile(prefix="citely-upload-", delete=False)
        try:
            with spool:
                shutil.copyfileobj(file.file, spool, length=1024 * 1024)
            size = os.path.getsize(spool.name)
            if size == 0:
                raise HTTPException(status_code=400, detail="Uploaded file is empty")
            if size > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"File exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)}MB upload limit",
                )
        except BaseException:
            os.unlink(spool.name)
            raise

        return _queue_ingest(request, current_user, spool.name, file.filename or "upload",
                             chunk_size=chunk_size, chunk_overlap=chunk_overlap, quality_threshold=quality_threshold,
                             client_upload_id=client_upload_id, source="upload")

    def _queue_ingest(request: Request, current_user, spool_path: str, filename: str, *, chunk_size: int = 1000,
                      chunk_overlap: int = 150, quality_threshold: float = 4.0, client_upload_id: str | None = None,
                      source: str = "upload") -> IngestJobStatus:
        """Checks limits, counts the upload, and queues the ingest of a file
        already spooled to local disk. Takes ownership of spool_path."""
        service = get_service(request)
        owner_id = current_user["id"]
        limited = usage.is_limited(current_user)
        country = activity.country_of(ac.client_ip(request))
        try:
            if limited:
                with open(spool_path, "rb") as fh:
                    _check_demo_document(current_user, fh.read(), filename)
            day = _reserve_or_429(current_user, usage.UPLOAD)
        except BaseException:
            os.unlink(spool_path)
            raise
        job, created = job_store.create_once(owner_id, filename, client_upload_id)
        if not created:
            # A retry of an upload that already arrived: report that job, ingest
            # nothing, and don't count it twice.
            usage.release(current_user, usage.UPLOAD, day)
            os.unlink(spool_path)
            return IngestJobStatus(**job.to_dict())

        def _run() -> None:
            job_store.mark(job.id, jobs.RUNNING)
            try:
                with open(spool_path, "rb") as fh:
                    payload = fh.read()
                result = service.ingest(
                    owner_id=owner_id,
                    filename=filename,
                    raw_bytes=payload,
                    chunk_size=chunk_size,
                    chunk_overlap=chunk_overlap,
                    quality_threshold=quality_threshold,
                    max_pages=usage.max_pages() if limited else None,
                )
                job_store.mark(job.id, jobs.SUCCEEDED, result=result.model_dump())
            except Exception as exc:  # noqa: BLE001 — surfaced via job.error
                logger.exception("ingest_job_failed", job_id=job.id)
                usage.release(current_user, usage.UPLOAD, day)   # a failed upload doesn't use the allowance
                job_store.mark(job.id, jobs.FAILED, error=str(exc))
            else:
                # Recorded after the job is marked done, and never able to fail it.
                activity.record("upload", user=current_user, country=country,
                                detail={"kind": getattr(result, "file_type", None), "pages": getattr(result, "pages", None),
                                        "bytes": len(payload), "source": source})
            finally:
                try:
                    os.unlink(spool_path)
                except FileNotFoundError:
                    pass

        # Queued on a bounded pool: the response returns immediately, but at most
        # INGEST_CONCURRENCY documents are parsed/embedded at once, so a burst of
        # uploads can't starve request handling on this small single replica.
        # Jobs waiting for a worker stay "queued" until _run marks them running.
        _ingest_pool.submit(_run)
        return IngestJobStatus(**job.to_dict())

    # ----------------------------------------------------------------- #
    # Sample documents: chosen in Upload, ingested like any upload (and
    # counted against the same limits). The admin manages the library.
    # ----------------------------------------------------------------- #

    @app.get("/samples")
    def list_samples(current_user=Depends(get_current_user)) -> dict:
        groups: dict[str, list] = {}
        for row in db.list_samples():
            groups.setdefault(row["kind"], []).append({"id": row["id"], "name": row["name"], "filename": row["filename"],
                                                       "kind": row["kind"], "bytes": row["bytes"]})
        return {"groups": [{"kind": k, "items": v} for k, v in sorted(groups.items())]}

    @app.post("/samples/{sample_id}/use", response_model=IngestJobStatus, status_code=202)
    @limiter.limit(INGEST_RATE_LIMIT)
    def use_sample(request: Request, sample_id: str, client_upload_id: str | None = None,
                   current_user=Depends(get_current_user)) -> IngestJobStatus:
        spool_path, filename = admin_api.spool_sample(sample_id)
        return _queue_ingest(request, current_user, spool_path, filename, client_upload_id=client_upload_id, source="sample")

    @app.get("/ingest/jobs/{job_id}", response_model=IngestJobStatus)
    def ingest_job_status(job_id: str, current_user=Depends(get_current_user)) -> IngestJobStatus:
        job = job_store.get(job_id, current_user["id"])
        if job is None:
            # Same 404 whether the job never existed or belongs to someone
            # else, so a job id can't be probed to discover other users' work.
            raise HTTPException(status_code=404, detail="Job not found")
        return IngestJobStatus(**job.to_dict())

    async def _finish_answer(request: Request, payload: QueryRequest, current_user, day, response: QueryResponse) -> QueryResponse:
        """What happens after every answer, streamed or not: an answer the
        system couldn't give is not counted (up to a daily cap), and each
        question is recorded for the admin console."""
        documents = len({payload.document_id, *payload.document_ids})
        if response.answer in (UNVERIFIED_ANSWER, LIMITED_CONTEXT):
            # The system couldn't produce an answer (the check failed, or the
            # passages didn't hold one): not something the person used up, so
            # the question is given back and the attempt recorded for the
            # admin console. Capped per account per day, so asking things the
            # document can't answer is not a way to ask without limit.
            kind = "question.unverified" if response.answer == UNVERIFIED_ANSWER else "question.unanswered"
            day_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
            free = await asyncio.to_thread(db.count_user_events, current_user["id"], ["question.unverified", "question.unanswered"], day_start)
            if free < FREE_UNANSWERED_PER_DAY:
                await asyncio.to_thread(usage.release, current_user, usage.QUESTION, day)
            await asyncio.to_thread(activity.record, kind, request=request, user=current_user,
                                    detail={"documents": documents, "refunded": free < FREE_UNANSWERED_PER_DAY})
        else:
            await asyncio.to_thread(activity.record, "question", request=request, user=current_user, detail={"documents": documents})
        return response.model_copy(update={"request_id": getattr(request.state, "request_id", response.request_id)})

    def _answer_error(exc: BaseException) -> HTTPException | None:
        if isinstance(exc, FileNotFoundError):
            return HTTPException(status_code=404, detail=str(exc))
        if isinstance(exc, RuntimeError):
            return HTTPException(status_code=422, detail=str(exc))
        return None

    @app.post("/query", response_model=QueryResponse)
    @limiter.limit(QUERY_RATE_LIMIT)
    async def query(
        request: Request,
        payload: QueryRequest,
        current_user=Depends(get_current_user),
        x_openai_api_key: str | None = Header(default=None, alias="X-OpenAI-Api-Key"),
    ) -> QueryResponse:
        service = get_service(request)
        # A question counts only once it is answered: the use is taken up front
        # (so parallel requests can't exceed the limit) and given back on failure.
        day = await asyncio.to_thread(_reserve_or_429, current_user, usage.QUESTION)
        try:
            response = await asyncio.to_thread(service.answer, current_user["id"], payload, x_openai_api_key)
        except BaseException as exc:
            await asyncio.to_thread(usage.release, current_user, usage.QUESTION, day)
            mapped = _answer_error(exc)
            if mapped is not None:
                raise mapped from exc
            raise
        return await _finish_answer(request, payload, current_user, day, response)

    @app.post("/query/stream")
    @limiter.limit(QUERY_RATE_LIMIT)
    async def query_stream(
        request: Request,
        payload: QueryRequest,
        current_user=Depends(get_current_user),
        x_openai_api_key: str | None = Header(default=None, alias="X-OpenAI-Api-Key"),
    ) -> StreamingResponse:
        """The same answer as /query, shown while it is written: one JSON
        object per line. {"type": "delta", "text"} is the checked answer so
        far (replace, don't append); {"type": "reset"} sets it aside while
        the answer is written again; then exactly one {"type": "done",
        "response"} with the final, checked answer, or {"type": "error",
        "status", "detail"}. Limits are checked before the stream starts, so
        "limit reached" is still an ordinary 429."""
        service = get_service(request)
        day = await asyncio.to_thread(_reserve_or_429, current_user, usage.QUESTION)
        loop = asyncio.get_running_loop()
        events: asyncio.Queue = asyncio.Queue()

        def on_event(kind: str, text: str | None) -> None:
            loop.call_soon_threadsafe(events.put_nowait, {"type": kind, **({"text": text} if text is not None else {})})

        async def run() -> None:
            try:
                response = await asyncio.to_thread(service.answer, current_user["id"], payload, x_openai_api_key, on_event)
            except BaseException as exc:  # noqa: BLE001 — reported in the stream, never swallowed
                await asyncio.to_thread(usage.release, current_user, usage.QUESTION, day)
                mapped = _answer_error(exc)
                if mapped is None:
                    logger.exception("query_stream_failed")
                await events.put({"type": "error", "status": mapped.status_code if mapped else 500,
                                  "detail": mapped.detail if mapped else "Internal server error"})
                return
            final = await _finish_answer(request, payload, current_user, day, response)
            await events.put({"type": "done", "response": final.model_dump(mode="json")})

        async def lines():
            task = asyncio.create_task(run())
            try:
                while True:
                    event = await events.get()
                    yield json.dumps(event, ensure_ascii=False) + "\n"
                    if event["type"] in ("done", "error"):
                        break
            finally:
                # The reader left early: the answer still finishes (and is
                # saved to the conversation), it just isn't sent.
                if not task.done():
                    task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)

        return StreamingResponse(lines(), media_type="application/x-ndjson",
                                 headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})

    # ----------------------------------------------------------------- #
    # Auth — GitHub/Google OAuth, email+password+OTP. None of these
    # depend on get_current_user; they're what issues the JWT in the
    # first place.
    # ----------------------------------------------------------------- #

    @app.post("/demo-requests", status_code=202)
    @limiter.limit("3/hour")
    def demo_request(request: Request, payload: DemoRequest) -> dict:
        try:
            ac.check_signup_email(payload.email)
        except ac.EmailRejected as exc:
            activity.record("demo.request_refused", request=request, email=ac.normalize_email(payload.email),
                            detail={"reason": exc.reason})
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        db.create_demo_request(payload.name, payload.email, payload.phone, payload.comment)
        activity.record("demo.request", request=request, email=ac.normalize_email(payload.email))
        deliver_demo_request(payload)
        return {"detail": "Demo request sent for review"}

    def _public_url(request: Request, path: str) -> str:
        # This API's own address as the browser sees it (TLS ends at the
        # ingress, so the scheme seen here would be http).
        host = request.headers.get("host", "")
        scheme = "http" if host.startswith(("localhost", "127.0.0.1", "testserver")) else "https"
        return f"{scheme}://{host}{path}"

    def _page(title: str, body: str, status: int = 200) -> HTMLResponse:
        return HTMLResponse(status_code=status, headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"}, content=f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>{html.escape(title)} · Citely</title>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f3ef;color:#202020;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}}
main{{max-width:440px;margin:24px;padding:32px;background:#fff;border:1px solid #e2e0da;border-radius:14px}}
h1{{font-size:1.25rem;margin:0 0 12px}} p{{margin:0 0 14px}} .muted{{color:#666;font-size:.9rem}}
button{{font:inherit;font-weight:600;color:#fff;background:#e32c12;border:0;border-radius:999px;padding:11px 22px;cursor:pointer}}</style>
</head><body><main><h1>{html.escape(title)}</h1>{body}</main></body></html>""")

    @app.get("/access/approve", response_class=HTMLResponse)
    def access_approve_page(token: str = "") -> HTMLResponse:
        # Opening the link only shows a confirmation: mail scanners open links
        # on their own, and must never approve anyone.
        email_address = ac.email_from_approval_token(token)
        if email_address is None:
            return _page("Link expired or invalid", "<p>This approval link is invalid or has expired. Ask the person to request access again.</p>", 400)
        safe = html.escape(email_address)
        if _approval_state(email_address)["approved"]:
            return _page("Already approved", f"<p><strong>{safe}</strong> already has access.</p>")
        return _page("Approve access?", f"""<p>Allow <strong>{safe}</strong> to create a Citely account?</p>
<form method="post" action="/access/approve" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Approving…'"><input type="hidden" name="token" value="{html.escape(token)}">
<button type="submit">Approve</button></form><p class="muted">They'll get an email inviting them to sign up.</p>""")

    @app.post("/access/approve", response_class=HTMLResponse)
    @limiter.limit("30/hour")
    def access_approve(request: Request, token: str = Form("")) -> HTMLResponse:
        email_address = ac.email_from_approval_token(token)
        if email_address is None:
            return _page("Link expired or invalid", "<p>This approval link is invalid or has expired. Ask the person to request access again.</p>", 400)
        result = approve_email(email_address)
        safe = html.escape(email_address)
        if result["account"] and result["newly"]:
            return _page("Approved", f"<p><strong>{safe}</strong> can now use their account. We've emailed them.</p>")
        return _page("Approved", f"<p><strong>{safe}</strong> can now create an account. We've emailed them the sign-up link.</p>"
                     if result["newly"] else f"<p><strong>{safe}</strong> was already approved.</p>")

    @app.get("/access/approval")
    def access_approval_status(token: str = "") -> dict:
        """What the site's approve page shows first. Opening it approves
        nobody: mail scanners open links on their own."""
        email_address = ac.email_from_approval_token(token)
        if email_address is None:
            raise HTTPException(status_code=400, detail="This approval link is invalid or has expired. Ask the person to request access again.")
        return {"email": email_address, **_approval_state(email_address)}

    @app.post("/access/approval")
    @limiter.limit("30/hour")
    def access_approval(request: Request, payload: ApprovalRequest) -> dict:
        email_address = ac.email_from_approval_token(payload.token)
        if email_address is None:
            raise HTTPException(status_code=400, detail="This approval link is invalid or has expired. Ask the person to request access again.")
        result = approve_email(email_address)
        return {"email": email_address, "approved": True, "newly": result["newly"], "account": result["account"]}

    def _approval_state(email_address: str) -> dict:
        """Approved means: an account that may use Citely, or (no account yet)
        an address cleared to create one. A pending account is not approved."""
        user = _find_user(email_address)
        if user is not None:
            return {"approved": user["status"] == "approved", "account": True}
        return {"approved": db.is_access_approved(email_address), "account": False}

    @app.post("/auth/github/callback", response_model=AuthTokenResponse)
    def github_callback(request: Request, payload: OAuthCallbackRequest) -> AuthTokenResponse:
        try:
            result = auth.exchange_github_code(payload.code)
        except auth.OAuthError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"GitHub sign-in failed: {exc}") from exc

        existed = (db.get_user_by_identity("github", result["provider_user_id"]) is not None
                   or db.get_user_by_email(result["email"]) is not None)
        if not existed and email_policy.is_temporary(result["email"]):
            activity.record("auth.signup_refused", request=request, email=result["email"], detail={"method": "github", "reason": "disposable"})
            raise HTTPException(status_code=400, detail=email_policy.DISPOSABLE_MESSAGE)
        user_id = db.get_or_create_user_for_oauth(result["email"], "github", result["provider_user_id"],
                                                  status=access.initial_status(result["email"]))
        user = db.get_user_by_id(user_id)
        if not existed:
            _account_created(request, user, "GitHub")
        return _sign_in(request, user, "github", payload.trusted_browsers)

    @app.post("/auth/google/callback", response_model=AuthTokenResponse)
    def google_callback(request: Request, payload: GoogleOAuthCallbackRequest) -> AuthTokenResponse:
        try:
            result = auth.exchange_google_code(payload.code, payload.redirect_uri)
        except auth.OAuthError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Google sign-in failed: {exc}") from exc

        existed = (db.get_user_by_identity("google", result["provider_user_id"]) is not None
                   or db.get_user_by_email(result["email"]) is not None)
        if not existed and email_policy.is_temporary(result["email"]):
            activity.record("auth.signup_refused", request=request, email=result["email"], detail={"method": "google", "reason": "disposable"})
            raise HTTPException(status_code=400, detail=email_policy.DISPOSABLE_MESSAGE)
        user_id = db.get_or_create_user_for_oauth(result["email"], "google", result["provider_user_id"],
                                                  status=access.initial_status(result["email"]))
        user = db.get_user_by_id(user_id)
        if not existed:
            _account_created(request, user, "Google")
        return _sign_in(request, user, "google", payload.trusted_browsers)

    def _refuse_if_suspended(request: Request, user, method: str) -> None:
        """A suspended account gets no token, and the attempt is recorded so
        the admin console shows it."""
        if user["status"] == "suspended":
            activity.record("auth.login_blocked", request=request, user=user, detail={"method": method, "reason": "suspended"})
        refuse_suspended(user)

    def _hold_signup(email_address: str, password_hash: str) -> None:
        """Holds a sign-up and emails its code, unless one went out within
        the cooldown (then only the newest password is kept)."""
        claimed = _claim_otp_slot(email_address)
        if claimed is None:
            db.update_pending_password(email_address, password_hash)
            return
        try:
            code = auth.generate_otp_code()
            db.save_pending_signup(email_address, password_hash, auth.hash_otp_code(code))
            otp_email.send_otp_email(email_address, code)
        except Exception:
            with _otp_send_lock:   # nothing went out: let the next press try again
                if _otp_last_sent.get(email_address) == claimed:
                    _otp_last_sent.pop(email_address, None)
            raise

    def _resend_signup_code(email_address: str) -> None:
        claimed = _claim_otp_slot(email_address)
        if claimed is None:
            return
        try:
            code = auth.generate_otp_code()
            if db.refresh_pending_code(email_address, auth.hash_otp_code(code)):
                otp_email.send_otp_email(email_address, code)
        except Exception:
            with _otp_send_lock:
                if _otp_last_sent.get(email_address) == claimed:
                    _otp_last_sent.pop(email_address, None)
            raise

    def _find_user(email_address: str):
        """The account for an address however it is spelled: exactly, in
        lower case, or by the inbox it reaches (Gmail dots, "+tag")."""
        return (db.get_user_by_email(email_address)
                or db.get_user_by_email(ac.normalize_email(email_address))
                or db.get_user_by_canonical_email(ac.canonical_email(email_address)))

    @app.post("/auth/signup", status_code=201)
    @limiter.limit(SIGNUP_RATE_LIMIT)
    def signup(request: Request, payload: SignupRequest) -> dict:
        if not ac.turnstile_passed(payload.turnstile_token, ac.client_ip(request)):
            raise HTTPException(status_code=400, detail="Please complete the human check and try again.")
        try:
            email_address = ac.check_signup_email(payload.email)
        except ac.EmailRejected as exc:
            activity.record("auth.signup_refused", request=request, email=ac.normalize_email(payload.email),
                            detail={"method": "email", "reason": exc.reason})
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if email_policy.is_personal(email_address):
            # Personal mailboxes sign up with Google or GitHub; passwords are for work addresses.
            raise HTTPException(status_code=400, detail=email_policy.PERSONAL_PASSWORD_MESSAGE)
        problem = ac.password_problem(payload.password, email_address)
        if problem:
            raise HTTPException(status_code=400, detail=problem)

        existing = _find_user(email_address)
        if existing is not None and existing["email_verified"]:
            # Same response as a genuine signup — do not let this endpoint be
            # used to enumerate which emails already have a verified account.
            # No code is sent for one that already exists and is verified.
            return {"detail": "Verification code sent"}
        if existing is not None:
            # A row left from before sign-ups were held: it never became an account.
            db.delete_unverified_user(existing["id"])

        # No account yet: the sign-up waits, with its code, until the code is
        # entered. A repeat within the resend cooldown (a double click) sends
        # no second code, so the first one stays valid.
        _hold_signup(email_address, auth.hash_password(payload.password))
        activity.record("auth.signup_started", request=request, email=email_address)
        return {"detail": "Verification code sent"}

    @app.post("/auth/verify-otp", response_model=AuthTokenResponse)
    def verify_otp(request: Request, payload: VerifyOtpRequest) -> AuthTokenResponse:
        pending = db.get_pending_signup(payload.email)
        if pending is None:
            raise HTTPException(status_code=400, detail="Invalid or expired code")
        if not auth.verify_otp_code(payload.code, pending["code_hash"]):
            if db.record_pending_attempt(payload.email) >= MAX_CODE_ATTEMPTS:
                db.delete_pending_signup(payload.email)
                raise HTTPException(status_code=400, detail="Too many wrong codes. Sign up again to get a new one.")
            raise HTTPException(status_code=400, detail="Invalid or expired code")

        db.delete_pending_signup(payload.email)
        user = _find_user(pending["email"])
        if user is None:
            try:
                user_id = db.create_user(pending["email"], password_hash=pending["password_hash"], email_verified=True,
                                         status=access.initial_status(pending["email"]))
                user = db.get_user_by_id(user_id)
                _account_created(request, user, "email")
            except sqlite3.IntegrityError:
                # The same code entered twice at once: the other request created it.
                user = _find_user(pending["email"])
        _refuse_if_suspended(request, user, "email-code")
        # The code just proved the inbox: no second code for this sign-in.
        return _token_response(user)

    @app.post("/auth/resend-otp", status_code=202)
    def resend_otp(payload: ResendOtpRequest) -> dict:
        last_sent = _otp_last_sent.get(payload.email)
        if last_sent is not None and (time.monotonic() - last_sent) < OTP_RESEND_COOLDOWN_SECONDS:
            raise HTTPException(status_code=429, detail="Please wait before requesting another code")

        pending = db.get_pending_signup(payload.email)
        if pending is not None:
            _resend_signup_code(pending["email"])
        # Same response whether or not the account exists/is already
        # verified — do not let this endpoint be used to enumerate emails.
        return {"detail": "If that account needs verification, a new code has been sent"}

    @app.post("/auth/login", response_model=AuthTokenResponse)
    @limiter.limit(LOGIN_RATE_LIMIT)
    def login(request: Request, payload: LoginRequest) -> AuthTokenResponse:
        user = _find_user(payload.email)
        if user is not None and db.is_locked(user):
            raise HTTPException(
                status_code=423, detail="Too many failed attempts. Try again in a few minutes."
            )
        if user is None or not user["password_hash"] or not auth.verify_password(payload.password, user["password_hash"]):
            if user is not None:
                db.record_failed_login(user["id"])
                activity.record("auth.login_failed", request=request, user=user, detail={"method": "password"})
            raise HTTPException(status_code=401, detail="Incorrect email or password")
        if not user["email_verified"]:
            raise HTTPException(status_code=403, detail="Email not verified")
        db.reset_failed_logins(user["id"])
        return _sign_in(request, user, "password", [payload.trusted_browser] if payload.trusted_browser else [])

    def _token_response(user, trusted_browser: str | None = None) -> AuthTokenResponse:
        return AuthTokenResponse(
            access_token=auth.create_access_token(user["id"], user["token_version"]), user_id=user["id"], email=user["email"],
            status=user["status"], trusted_browser=trusted_browser,
            privacy_policy_accepted=db.has_accepted_privacy_policy(user, PRIVACY_POLICY_VERSION),
        )

    def _sign_in(request: Request, user, method: str, trusted: list[str]) -> AuthTokenResponse:
        """The last step of every sign-in. A suspended account gets nothing.
        An approved one confirms with an emailed code (when LOGIN_EMAIL_CODE
        is on) unless this browser is trusted. Pending and declined accounts
        are signed in to see their status, without a code."""
        _refuse_if_suspended(request, user, method)
        if user["status"] == "approved" and access.login_code_required() and not access.browser_is_trusted(user["id"], trusted):
            ticket = _send_login_code(user)
            activity.record("auth.login_code_sent", request=request, user=user, detail={"method": method})
            return AuthTokenResponse(user_id=user["id"], email=user["email"], status=user["status"], code_required=True,
                                     ticket=ticket, sent_to=access.mask_email(user["email"]))
        activity.record("auth.login", request=request, user=user, detail={"method": method})
        return _token_response(user)

    def _send_login_code(user) -> str:
        code = auth.generate_otp_code()
        code_id = db.create_login_code(user["id"], auth.hash_otp_code(code), ttl_minutes=access.LOGIN_CODE_MINUTES)
        otp_email.send_login_code_email(user["email"], code)
        _otp_last_sent["login:" + user["id"]] = time.monotonic()
        return access.make_ticket(user["id"], code_id)

    def _account_created(request: Request, user, method: str) -> None:
        activity.record("auth.signup", request=request, user=user, detail={"method": method.lower(), "status": user["status"]})
        if user["status"] == "pending":
            notify_admin_of_pending_account(user["email"], method)

    def _ticket_user(ticket: str):
        found = access.read_ticket(ticket)
        user = db.get_user_by_id(found[0]) if found else None
        if user is None:
            raise HTTPException(status_code=400, detail="This sign-in has expired. Please sign in again.")
        return user, found[1]

    @app.post("/auth/login-code", response_model=AuthTokenResponse)
    @limiter.limit(LOGIN_RATE_LIMIT)
    def login_code(request: Request, payload: LoginCodeRequest) -> AuthTokenResponse:
        user, code_id = _ticket_user(payload.ticket)
        code = db.get_live_login_code(code_id, user["id"])
        if code is None:
            raise HTTPException(status_code=400, detail="This code has expired or was replaced. Send a new one.")
        if not auth.verify_otp_code(payload.code, code["code_hash"]):
            if db.record_code_attempt(code_id) >= access.MAX_LOGIN_CODE_ATTEMPTS:
                db.consume_otp(code_id)
                activity.record("auth.login_failed", request=request, user=user, detail={"method": "code", "reason": "too many codes"})
                raise HTTPException(status_code=400, detail="Too many wrong codes. Please sign in again.")
            raise HTTPException(status_code=400, detail="That code isn't right. Check the email and try again.")
        db.consume_otp(code_id)
        user = db.get_user_by_id(user["id"])
        _refuse_if_suspended(request, user, "code")
        trusted = access.trust_browser(user["id"], payload.browser_label) if payload.trust_browser else None
        activity.record("auth.login", request=request, user=user, detail={"method": "code", "trusted_browser": bool(trusted)})
        return _token_response(user, trusted)

    @app.post("/auth/login-code/resend")
    def login_code_resend(request: Request, payload: LoginCodeResendRequest) -> dict:
        user, _code_id = _ticket_user(payload.ticket)
        last = _otp_last_sent.get("login:" + user["id"])
        if last is not None and time.monotonic() - last < OTP_RESEND_COOLDOWN_SECONDS:
            raise HTTPException(status_code=429, detail="Please wait a minute before asking for another code.")
        _refuse_if_suspended(request, user, "code")
        return {"ticket": _send_login_code(user), "sent_to": access.mask_email(user["email"])}

    def _issue_and_send_reset(user_id: str, email_address: str) -> None:
        token = auth.generate_reset_token()
        db.create_password_reset_token(user_id, auth.hash_reset_token(token))
        otp_email.send_password_reset_email(email_address, token)

    @app.post("/auth/request-password-reset", status_code=202)
    @limiter.limit(PASSWORD_RESET_RATE_LIMIT)
    def request_password_reset(request: Request, payload: RequestPasswordResetRequest) -> dict:
        last_sent = _reset_last_sent.get(payload.email)
        if last_sent is not None and (time.monotonic() - last_sent) < RESET_RESEND_COOLDOWN_SECONDS:
            raise HTTPException(status_code=429, detail="Please wait before requesting another reset email")
        _reset_last_sent[payload.email] = time.monotonic()

        if email_policy.is_work(payload.email):
            # Work accounts are reset by the admin (a link sent from the admin
            # console). Decided by the address alone, so this says nothing
            # about whether an account exists.
            return {"detail": email_policy.WORK_RESET_MESSAGE, "admin_reset": True}

        # Every branch below returns the exact same response. What actually
        # happens server-side (a real reset link, an "use your provider"
        # notice, or nothing at all) must never be observable from the API
        # response itself — only from whichever inbox the requester actually
        # controls, which an attacker submitting someone else's email does not.
        user = db.get_user_by_email(payload.email)
        if user is not None and user["password_hash"]:
            _issue_and_send_reset(user["id"], payload.email)
        elif user is not None:
            # OAuth-only account: never issue a token for it, but do let the
            # legitimate owner know why nothing will arrive from a reset link.
            otp_email.send_oauth_only_reset_notice(payload.email)
        return {"detail": "If that account exists, a password reset email has been sent"}

    @app.post("/auth/reset-password")
    def reset_password(payload: ResetPasswordRequest) -> dict:
        user = _find_user(payload.email)
        if user is None:
            raise HTTPException(status_code=400, detail="Invalid or expired reset link")
        problem = ac.password_problem(payload.new_password, user["email"])
        if problem:
            raise HTTPException(status_code=400, detail=problem)

        token_hash = auth.hash_reset_token(payload.token)
        ok = db.reset_password_with_token(user["id"], token_hash, auth.hash_password(payload.new_password))
        if not ok:
            raise HTTPException(status_code=400, detail="Invalid or expired reset link")
        presence.end(user["id"])                  # every session just ended

        # No auto-sign-in (OWASP guidance): the frontend sends the user to a
        # normal /signin with their new password, rather than this response
        # handing out a token directly.
        return {"detail": "Password reset. Please sign in with your new password."}

    @app.post("/auth/accept-privacy-policy", response_model=PrivacyPolicyAcceptanceResponse)
    def accept_privacy_policy(current_user=Depends(get_current_user)) -> PrivacyPolicyAcceptanceResponse:
        db.record_privacy_policy_acceptance(current_user["id"], PRIVACY_POLICY_VERSION)
        return PrivacyPolicyAcceptanceResponse(
            detail="Privacy policy acceptance recorded", privacy_policy_version=PRIVACY_POLICY_VERSION
        )

    # ----------------------------------------------------------------- #
    # Documents — list/resume/delete, all scoped to the authenticated user.
    # ----------------------------------------------------------------- #

    @app.get("/documents", response_model=list[DocumentSummary])
    def list_documents(request: Request, current_user=Depends(get_current_user)) -> list[DocumentSummary]:
        service = get_service(request)
        return service.list_documents(current_user["id"])

    @app.get("/documents/{document_id}/history", response_model=list[ChatTurnSummary])
    def document_history(request: Request, document_id: str, current_user=Depends(get_current_user)) -> list[ChatTurnSummary]:
        service = get_service(request)
        return service.get_chat_history(document_id, current_user["id"])

    @app.delete("/documents/{document_id}", response_model=DeleteDocumentResponse)
    def delete_document(request: Request, document_id: str, current_user=Depends(get_current_user)) -> DeleteDocumentResponse:
        service = get_service(request)
        deleted = service.remove_document(document_id, current_user["id"])
        if not deleted:
            raise HTTPException(status_code=404, detail="Document not found")
        activity.record("document.deleted", request=request, user=current_user)
        return DeleteDocumentResponse(document_id=document_id, deleted=True)

    @app.delete("/documents/{document_id}/history")
    def delete_document_history(document_id: str, current_user=Depends(get_current_user)) -> dict[str, int]:
        # Clears this document's Q&A log without touching the document, its
        # index, or its files. Used when a single-document conversation is
        # deleted: without this, reopening it would reseed the just-deleted
        # messages from here, since that's exactly what first-open does for a
        # desk with no saved /state conversation yet.
        if db.get_document(document_id, current_user["id"]) is None:
            raise HTTPException(status_code=404, detail="Document not found")
        return {"deleted": db.delete_chat_turns_for_document(document_id, current_user["id"])}

    # ----------------------------------------------------------------- #
    # Workspace state — organizations, workspaces, folders, conversations,
    # notes and annotations. One owner-scoped key/value row per key, with the
    # revision check the workspace UI is built against.
    # ----------------------------------------------------------------- #

    @app.get("/state/{key:path}", response_model=StateRecord)
    def read_state(key: str, current_user=Depends(get_current_user)) -> StateRecord:
        raw, revision = db.read_state(current_user["id"], key)
        return StateRecord(value=json.loads(raw) if raw is not None else None, revision=revision)

    @app.put("/state/{key:path}", response_model=StateWriteResult)
    def write_state(
        key: str, payload: StateWriteRequest, current_user=Depends(get_current_user)
    ) -> StateWriteResult:
        serialized = json.dumps(payload.value, separators=(",", ":"))
        if len(serialized) > MAX_STATE_BYTES:
            raise HTTPException(status_code=413, detail="This workspace record is too large to save.")
        revision = db.write_state(current_user["id"], key, serialized, payload.revision)
        if revision is None:
            _, current = db.read_state(current_user["id"], key)
            raise HTTPException(
                status_code=409,
                detail=f"A newer version was saved elsewhere (revision {current}). Reload to continue.",
            )
        return StateWriteResult(revision=revision, updated=_utc_now_iso())

    @app.delete("/state/{key:path}")
    def delete_state(key: str, current_user=Depends(get_current_user)) -> dict[str, bool]:
        return {"deleted": db.delete_state(current_user["id"], key)}

    # ----------------------------------------------------------------- #
    # Annotations — kept citations and manual highlights
    # ----------------------------------------------------------------- #

    def _annotation_from_row(row) -> Annotation:
        return Annotation(
            id=row["id"],
            workspace_id=row["workspace_id"],
            conversation_id=row["conversation_id"],
            document_id=row["document_id"],
            kind=row["kind"],
            citation_id=row["citation_id"],
            page_number=row["page_number"],
            quote=row["quote"],
            page_char_start=row["page_char_start"],
            page_char_end=row["page_char_end"],
            bounding_boxes=json.loads(row["bounding_boxes"]) if row["bounding_boxes"] else None,
            note=row["note"],
            extraction_version=row["extraction_version"],
            anchor=json.loads(row["anchor"]) if row["anchor"] else None,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @app.get("/conversations/{conversation_id}/annotations", response_model=list[Annotation])
    def list_annotations(conversation_id: str, current_user=Depends(get_current_user)) -> list[Annotation]:
        return [_annotation_from_row(r) for r in db.list_annotations(current_user["id"], conversation_id)]

    @app.post("/conversations/{conversation_id}/annotations", response_model=Annotation, status_code=201)
    def create_annotation(
        conversation_id: str, payload: AnnotationCreate, request: Request, current_user=Depends(get_current_user)
    ) -> Annotation:
        # The document must be this user's, or one account could anchor
        # annotations into another's document.
        if db.get_document(payload.document_id, current_user["id"]) is None:
            raise HTTPException(status_code=404, detail="Document not found")
        if (
            payload.page_char_start is not None
            and payload.page_char_end is not None
            and payload.page_char_end <= payload.page_char_start
        ):
            raise HTTPException(status_code=422, detail="page_char_end must be greater than page_char_start")

        if (payload.page_char_start is None) != (payload.page_char_end is None):
            raise HTTPException(status_code=422, detail="Both range offsets are required")
        if payload.page_char_start is not None:
            pages = get_service(request).get_document_pages(payload.document_id, current_user['id']) or []
            page = next((p for p in pages if p['page'] == payload.page_number), None)
            if not page or not payload.extraction_version or payload.extraction_version != page['extraction_version']:
                raise HTTPException(status_code=409, detail="The document extraction changed. Reload its page before saving the highlight.")
            start = codepoint_offset(page['text'], payload.page_char_start)
            end = codepoint_offset(page['text'], payload.page_char_end)
            if start is None or end is None or page['text'][start:end] != payload.quote:
                raise HTTPException(status_code=422, detail="Highlight range and quote must match the exact page text (UTF-16 offsets)")

        if payload.anchor is not None:
            # A cell or slide highlight is only meaningful against the extraction
            # it was made on, and its sheet or slide is the page the text keeps.
            position = payload.anchor.sheet_index if payload.anchor.format == "xlsx" else payload.anchor.slide_index
            if payload.page_number != position + 1:
                raise HTTPException(status_code=422, detail="page_number must be the anchor's sheet or slide position + 1")
            if payload.anchor.format == "pptx" and (payload.anchor.row is None) != (payload.anchor.col is None):
                raise HTTPException(status_code=422, detail="A table cell needs both row and col")
            pages = get_service(request).get_document_pages(payload.document_id, current_user['id']) or []
            page = next((p for p in pages if p['page'] == payload.page_number), None)
            if not page or not payload.extraction_version or payload.extraction_version != page['extraction_version']:
                raise HTTPException(status_code=409, detail="The document extraction changed. Reload it before saving the highlight.")

        row = db.create_annotation(
            current_user["id"],
            workspace_id=payload.workspace_id,
            conversation_id=conversation_id,
            document_id=payload.document_id,
            kind=payload.kind,
            page_number=payload.page_number,
            quote=payload.quote,
            citation_id=payload.citation_id,
            page_char_start=payload.page_char_start,
            page_char_end=payload.page_char_end,
            bounding_boxes=json.dumps([b.model_dump() for b in payload.bounding_boxes])
            if payload.bounding_boxes else None,
            note=payload.note,
            extraction_version=payload.extraction_version,
            anchor=payload.anchor.model_dump_json(exclude_none=True) if payload.anchor else None,
        )
        return _annotation_from_row(row)

    @app.patch("/annotations/{annotation_id}", response_model=Annotation)
    def update_annotation(
        annotation_id: str, payload: AnnotationUpdate, current_user=Depends(get_current_user)
    ) -> Annotation:
        row = db.update_annotation(
            annotation_id, current_user["id"], note=payload.note, quote=payload.quote
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Annotation not found")
        return _annotation_from_row(row)

    @app.delete("/annotations/{annotation_id}")
    def delete_annotation(annotation_id: str, current_user=Depends(get_current_user)) -> dict[str, bool]:
        if not db.delete_annotation(annotation_id, current_user["id"]):
            raise HTTPException(status_code=404, detail="Annotation not found")
        return {"deleted": True}

    @app.delete("/conversations/{conversation_id}/annotations")
    def delete_conversation_annotations(
        conversation_id: str, current_user=Depends(get_current_user)
    ) -> dict[str, int]:
        # Scoped to this conversation only — a document referenced by other
        # conversations keeps the annotations those made against it.
        return {"deleted": db.delete_annotations_for_conversation(conversation_id, current_user["id"])}

    # ----------------------------------------------------------------- #
    # Notes — revision-tracked per conversation
    # ----------------------------------------------------------------- #

    @app.get("/conversations/{conversation_id}/notes", response_model=Note)
    def read_note(conversation_id: str, current_user=Depends(get_current_user)) -> Note:
        note = db.get_note(current_user["id"], conversation_id)
        # Revision 0 with empty content is the honest representation of a note
        # that has never been written — not an error.
        return Note(**note) if note else Note(conversation_id=conversation_id, revision=0, content="")

    @app.put("/conversations/{conversation_id}/notes", response_model=Note)
    def save_note(
        conversation_id: str, payload: NoteSaveRequest, current_user=Depends(get_current_user)
    ) -> Note:
        saved = db.save_note(
            current_user["id"], conversation_id, payload.workspace_id,
            payload.content, payload.expected_revision,
        )
        if saved is None:
            current = db.get_note(current_user["id"], conversation_id)
            raise HTTPException(
                status_code=409,
                detail=(
                    "These notes were changed elsewhere "
                    f"(revision {current['revision'] if current else 0}). "
                    "Reload to see the current version before saving."
                ),
            )
        return Note(**saved)

    @app.delete("/conversations/{conversation_id}/notes")
    def delete_note(conversation_id: str, current_user=Depends(get_current_user)) -> dict[str, bool]:
        # Notes are one-per-conversation (unique on owner_id+conversation_id),
        # so deleting them is unambiguous and never touches another
        # conversation's notes, even one against the same document.
        return {"deleted": db.delete_note(current_user["id"], conversation_id)}

    @app.get("/conversations/{conversation_id}/notes/versions", response_model=list[NoteRevisionSummary])
    def list_note_versions(conversation_id: str, current_user=Depends(get_current_user)) -> list[NoteRevisionSummary]:
        return [
            NoteRevisionSummary(
                revision=r["revision"], content=r["content"],
                created_by=r["created_by"], created_at=r["created_at"],
            )
            for r in db.list_note_revisions(current_user["id"], conversation_id)
        ]

    @app.post("/conversations/{conversation_id}/notes/versions/{revision}/restore", response_model=Note)
    def restore_note_version(
        conversation_id: str, revision: int, current_user=Depends(get_current_user)
    ) -> Note:
        target = db.get_note_revision(current_user["id"], conversation_id, revision)
        if target is None:
            raise HTTPException(status_code=404, detail="That version does not exist")
        current = db.get_note(current_user["id"], conversation_id)
        # Restoring appends a new revision rather than rewinding the history,
        # so nothing that was written is ever lost.
        saved = db.save_note(
            current_user["id"], conversation_id,
            current["workspace_id"] if current else "",
            target["content"], current["revision"] if current else 0,
        )
        if saved is None:
            raise HTTPException(status_code=409, detail="These notes changed while restoring. Try again.")
        return Note(**saved)

    @app.get("/documents/{document_id}/file")
    def document_file(request: Request, document_id: str, current_user=Depends(get_current_user)):
        """The retained original, for its owner only. 404 alike for a missing
        document, someone else's, one still processing, or one ingested before
        originals were kept — never revealing which."""
        found = get_service(request).get_original(document_id, current_user["id"])
        if found is None:
            raise HTTPException(status_code=404, detail="Original file not available")
        path, filename = found
        return FileResponse(
            path,
            media_type=originals.content_type_for(str(path)),
            filename=filename,
            content_disposition_type="attachment",
            headers={"Cache-Control": "private, no-store"},
        )

    @app.post("/documents/{document_id}/original")
    def attach_document_original(
        request: Request,
        document_id: str,
        file: UploadFile = File(...),
        confirm: bool = Form(False),
        current_user=Depends(get_current_user),
    ) -> dict:
        """Re-upload the original of a document ingested before originals were
        kept. 409 (nothing changed) when it doesn't reproduce the stored
        extraction, unless `confirm` is set."""
        if not originals.ORIGINALS_ENABLED:
            raise HTTPException(status_code=404, detail="Not available")
        _checked_upload_size(file)
        payload = file.file.read()
        if not payload:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")
        try:
            result = get_service(request).attach_original(
                document_id, current_user["id"], file.filename or "upload", payload, confirm=confirm
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Document not found") from exc
        except FileExistsError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except db.StorageQuotaExceeded as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not result["attached"]:
            return JSONResponse(status_code=409, content={
                "detail": "This file does not match the document as it was originally processed.",
                **result,
            })
        return result

    @app.get("/documents/{document_id}/evidence")
    def evidence_status(document_id: str, current_user=Depends(get_current_user)):
        from APP.extraction import store
        from APP.extraction.worker import enabled, paid_enabled
        if db.get_document(document_id, current_user['id']) is None:
            raise HTTPException(status_code=404, detail="Document not found")
        result = store.status(current_user['id'], document_id)
        result.update(enabled=enabled(), paid_enabled=paid_enabled())
        result['records'] = [{k: r[k] for k in ('id','region_id','provenance','content_type','text','extractor')}
                             for r in store.records(current_user['id'], document_id) if r['provenance'] != 'native']
        return result

    @app.get("/documents/{document_id}/evidence/{record_id}/asset")
    def evidence_asset(document_id: str, record_id: str, current_user=Depends(get_current_user)):
        from APP.extraction import store
        from fastapi.responses import FileResponse
        record = next((r for r in store.records(current_user['id'], document_id) if r['id'] == record_id), None)
        if not record or not record['asset_path'] or not Path(record['asset_path']).is_file():
            raise HTTPException(status_code=404, detail="Evidence asset not found")
        return FileResponse(record['asset_path'], media_type='application/pdf' if record['asset_path'].endswith('.pdf') else 'image/png',
                            headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'})

    @app.post("/documents/{document_id}/evidence")
    def queue_evidence(request: Request, document_id: str, mode: str = 'read', region_id: str | None = None,
                       current_user=Depends(get_current_user)):
        from APP.extraction import store
        from APP.extraction.inventory import inspect, persist
        from APP.extraction.worker import enabled
        if not enabled():
            raise HTTPException(status_code=409, detail="Image enrichment is disabled on this server")
        if mode not in ('read','layout','formulas','vision'):
            raise HTTPException(status_code=422, detail="Unknown extraction mode")
        row=db.get_document(document_id,current_user['id'])
        if row is None: raise HTTPException(status_code=404, detail="Document not found")
        service=get_service(request)
        service.backfill_evidence(current_user['id'],document_id)
        if not store.has_inventory(current_user['id'],document_id):
            if not row['original_path']:
                raise HTTPException(status_code=409, detail="Re-upload this file to process images; its original was not retained")
            raw=Path(row['original_path']).read_bytes()
            inventory=inspect(raw,row['filename'])
            _,_,chunks=service._load_document_artifacts(document_id,current_user['id'])
            persist(current_user['id'],document_id,raw,row['filename'],inventory,chunks)
        with db._immediate() as conn:
            # A request whose bill is uncertain must never be automatically retried.
            query="SELECT j.id,r.id AS region FROM evidence_jobs j JOIN evidence_regions r ON r.id=j.region_id WHERE j.document_id=? AND j.state IN ('queued','blocked','done')"
            args=[document_id]
            if region_id: query+=' AND r.id=?'; args.append(region_id)
            rows=conn.execute(query,args).fetchall()
            for item in rows:
                conn.execute("UPDATE evidence_jobs SET state='queued',error=NULL WHERE id=?",(item['id'],))
                conn.execute("UPDATE evidence_regions SET state='queued',mode=?,error=NULL WHERE id=?",(mode,item['region']))
        return store.status(current_user['id'],document_id)

    @app.get("/documents/{document_id}/pages", response_model=list[DocumentPage])
    def document_pages(request: Request, document_id: str, current_user=Depends(get_current_user)) -> list[DocumentPage]:
        """Real extracted text, grouped by page, for the workspace preview.

        Reconstructed from the chunks already stored for retrieval, so it needs
        no new storage and always matches what answers are actually grounded in.
        """
        service = get_service(request)
        pages = service.get_document_pages(document_id, current_user["id"])
        if pages is None:
            raise HTTPException(status_code=404, detail="Document not found")
        return [DocumentPage(**p) for p in pages]

    app.include_router(admin_api.router)
    return app


app = create_app()


if __name__ == "__main__":
    uvicorn.run("APP.main:app", host="0.0.0.0", port=8000, reload=False)
