from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class SourceChunk(BaseModel):
    region_id: str | None = None
    evidence_record_id: str | None = None
    provenance: Literal['native', 'ocr', 'generated'] = 'native'
    content_type: str = 'text'
    evidence_location: dict[str, Any] | None = None
    chunk_id: int | str | None = None
    source: str = "unknown"
    page: int | str | None = None
    score: float | None = None
    content: str
    # Which document this passage came from. Only a folder-wide answer can mix
    # documents, but it is always populated so a citation can be resolved to a
    # file without matching on filename.
    document_id: str | None = None

    # Stable identity for this citation, so the reader can anchor, scroll to
    # and save it without relying on its position in the list.
    citation_id: str | None = None

    # Where the passage sits inside the page's extracted text, as returned by
    # /documents/{id}/pages. Both None means the exact location could not be
    # resolved — the reader must say so rather than highlight the whole page.
    page_char_start: int | None = None
    page_char_end: int | None = None

    # The supporting text itself. Kept separate from `content` so that merging
    # overlapping passages can widen the quote without losing the raw chunk.
    quote: str | None = None

    # Which extraction produced these offsets. A saved annotation carrying an
    # older version must be relocated by quote rather than trusted blindly.
    extraction_version: str | None = None
    # Legacy persisted sources omit this field and used Python code points.
    offset_unit: Literal["codepoint", "utf16"] = "codepoint"
    evidence_role: Literal["cited", "legacy-context"] = "legacy-context"
    # Where the passage sits in the original file, for documents parsed
    # natively: {"format": "xlsx", "sheet_name", "sheet_index", "range",
    # "cells"} or {"format": "pptx", "slide_index", "shape_id", "row", "col"}.
    # None for everything else, which keeps page offsets only.
    anchor: dict[str, Any] | None = None


class IngestResponse(BaseModel):
    request_id: str
    document_id: str
    collection_name: str
    filename: str
    file_type: str
    pdfs: int | None = None
    pages: int = 0
    chunks: int = 0
    passed_chunks: int = 0
    # NOT dropped from the index — every non-empty chunk is indexed. This
    # counts chunks that scored below the quality threshold and therefore
    # carry a 0.7 ranking multiplier at retrieval (apply_quality_penalty).
    penalised_chunks: int = 0
    indexed_chunks: int = 0
    # Which parser tier produced the text, so a user can see when a paid
    # OCR fallback was reached instead of free local extraction.
    parser_used: str | None = None


class IngestJobStatus(BaseModel):
    """Status of an async ingest. `result` is the full IngestResponse
    payload once status is "succeeded", None before that."""
    job_id: str
    status: str
    filename: str
    result: dict | None = None
    error: str | None = None
    created_at: float
    updated_at: float


class HeartbeatRequest(BaseModel):
    """The previous release's keep-warm ping (tabs opened before the update).
    `first` marks the start of a visit."""
    timezone: str | None = Field(default=None, max_length=64)
    first: bool = False
    path: str | None = Field(default=None, max_length=200)


class PresenceSignal(BaseModel):
    """One workspace tab reporting where it stands (APP/presence.py). `tab` is
    made when the page loads, `browser` is kept by the browser; `seq` grows
    with every signal from the tab. `first` marks the start of a visit."""
    state: Literal["active", "idle", "hidden", "closed", "signed_out"]
    browser: str = Field(pattern=r"^[A-Za-z0-9_-]{8,64}$")
    tab: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{8,64}$")
    seq: int = Field(default=0, ge=0, le=2**53)
    first: bool = False
    timezone: str | None = Field(default=None, max_length=64)
    path: str | None = Field(default=None, max_length=200)


class QueryRequest(BaseModel):
    document_id: str
    question: str = Field(min_length=1)
    top_k: int = Field(default=4, ge=1, le=20)
    # Folder-wide conversations ask across every ready document in a folder.
    # `document_id` stays the primary document — it anchors stored history and
    # the saved turn — while retrieval runs over this whole set.
    document_ids: list[str] = Field(default_factory=list, max_length=25)


class QueryResponse(BaseModel):
    request_id: str
    answer: str
    sources: list[SourceChunk] = Field(default_factory=list)
    model: str
    collection_name: str


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #

class OAuthCallbackRequest(BaseModel):
    code: str = Field(min_length=1)
    trusted_browsers: list[str] = Field(default_factory=list, max_length=10)


class GoogleOAuthCallbackRequest(OAuthCallbackRequest):
    redirect_uri: str = Field(min_length=1)


class SignupRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    # Strength is checked in APP/access_control.password_problem, which gives
    # a message the form can show; this only bounds the size.
    password: str = Field(min_length=1, max_length=128)
    # Cloudflare Turnstile response, required when TURNSTILE_SECRET_KEY is set.
    turnstile_token: str | None = Field(default=None, max_length=4096)


class VerifyOtpRequest(BaseModel):
    email: str
    code: str = Field(min_length=6, max_length=6)


class ResendOtpRequest(BaseModel):
    email: str


class LoginRequest(BaseModel):
    email: str
    password: str
    trusted_browser: str | None = Field(default=None, max_length=200)


class LoginCodeRequest(BaseModel):
    ticket: str = Field(min_length=10, max_length=2000)
    code: str = Field(pattern=r"^\d{6}$")
    trust_browser: bool = False
    browser_label: str | None = Field(default=None, max_length=120)


class LoginCodeResendRequest(BaseModel):
    ticket: str = Field(min_length=10, max_length=2000)


class RequestPasswordResetRequest(BaseModel):
    email: str = Field(min_length=3)


class ResetPasswordRequest(BaseModel):
    email: str
    token: str = Field(min_length=20)
    new_password: str = Field(min_length=1, max_length=128)


class AuthTokenResponse(BaseModel):
    # None while a sign-in still needs its emailed code (code_required).
    access_token: str | None = None
    user_id: str
    email: str
    # approved | pending | declined: a pending or declined account is signed
    # in but only sees its own status.
    status: str = "approved"
    code_required: bool = False
    ticket: str | None = None          # carries the sign-in to /auth/login-code
    sent_to: str | None = None         # the masked address the code went to
    trusted_browser: str | None = None # kept by the browser to skip the code for 30 days
    # False until the user has agreed to the current PRIVACY_POLICY_VERSION —
    # the frontend uses this to gate the mandatory consent modal without a
    # separate round-trip right after signing in.
    privacy_policy_accepted: bool = False


class PrivacyPolicyAcceptanceResponse(BaseModel):
    detail: str
    privacy_policy_version: str


# --------------------------------------------------------------------------- #
# Documents / chat history
# --------------------------------------------------------------------------- #

class DocumentSummary(BaseModel):
    id: str
    filename: str
    ingested_at: str
    pages: int | None = None
    chunks: int | None = None
    indexed_chunks: int | None = None
    # A retained original exists (GET /documents/{id}/file). False for every
    # document ingested before originals were kept.
    has_original: bool = False
    # The original reproduces the stored extraction exactly, so existing
    # offsets and annotations describe it. None when there is no original.
    original_compatible: bool | None = None


class ChatTurnSummary(BaseModel):
    id: str
    question: str
    answer: str
    sources: list[SourceChunk] = Field(default_factory=list)
    created_at: str


class DeleteDocumentResponse(BaseModel):
    document_id: str
    deleted: bool


DependencyStateName = Literal["starting", "unknown", "up", "down"]


class DependencyState(BaseModel):
    state: DependencyStateName
    # When the background probe last finished, and how long ago. Both None
    # while the first probe is still running ("starting").
    checked_at: str | None = None
    age_s: float | None = None


class HealthStatus(BaseModel):
    # Process liveness: "ok" whenever this process can answer at all. It no
    # longer reflects dependencies — `readiness` and /ready do.
    status: str
    service: str
    # Kept for existing consumers; mirror dependencies[...].state.
    qdrant: str
    openai: str
    collection_name: str | None = None
    ready: bool = False
    readiness: Literal["ready", "starting", "degraded"] = "starting"
    dependencies: dict[str, DependencyState] = Field(default_factory=dict)
    # The running image's content tag (content-<hash of the backend files>);
    # the same image serves dev and production, so this alone can't tell
    # deploys apart.
    version: str = "unknown"
    # The commit this deployment was made from, set by the deploy; the smoke
    # test waits for it to prove the new revision is the one answering.
    commit: str = "unknown"


# --------------------------------------------------------------------------- #
# Workspace state
# --------------------------------------------------------------------------- #

class StateRecord(BaseModel):
    """A stored workspace record. `revision` 0 means the key has never been
    written — the client treats that as an empty starting state, not an error."""

    value: Any = None
    revision: int = 0


class StateWriteRequest(BaseModel):
    value: Any = None
    # The revision the client last read. The write is rejected if the stored
    # row has moved on, so a stale tab cannot overwrite newer work.
    revision: int = Field(default=0, ge=0)


class StateWriteResult(BaseModel):
    revision: int
    updated: str


class DocumentPage(BaseModel):
    page: int
    text: str
    # Empty for documents ingested before page text was stored: their offsets
    # cannot be trusted, so citations against them must degrade honestly.
    extraction_version: str = ""


# --------------------------------------------------------------------------- #
# Annotations and notes
# --------------------------------------------------------------------------- #

class BoundingBox(BaseModel):
    page_number: int
    x: float
    y: float
    width: float
    height: float


class XlsxAnchor(BaseModel):
    """A highlight made in the spreadsheet viewer: cells, not characters."""
    model_config = ConfigDict(extra="forbid")
    format: Literal["xlsx"]
    sheet_name: str = Field(min_length=1, max_length=255)
    sheet_index: int = Field(ge=0, le=10_000)
    range: str = Field(pattern=r"^[A-Z]{1,3}[1-9][0-9]{0,6}(:[A-Z]{1,3}[1-9][0-9]{0,6})?$")


class PptxAnchor(BaseModel):
    """A highlight made on a slide: characters inside one shape or table cell."""
    model_config = ConfigDict(extra="forbid")
    format: Literal["pptx"]
    slide_index: int = Field(ge=0, le=10_000)
    shape_id: int = Field(ge=0)
    row: int | None = Field(default=None, ge=0)
    col: int | None = Field(default=None, ge=0)
    quote: str = Field(min_length=1, max_length=20_000)
    # Which occurrence of the quote inside that shape or cell (0 = first), or —
    # for a kept citation — where the quote starts in that shape's text.
    occurrence: int = Field(default=0, ge=0)
    offset: int | None = Field(default=None, ge=0)


class AnnotationCreate(BaseModel):
    document_id: str
    workspace_id: str = ""
    # "citation" is a kept answer passage; "manual-highlight" is a selection
    # the reader made themselves. Same anchoring, different provenance.
    kind: Literal["citation", "manual-highlight"]
    page_number: int = Field(ge=1)
    quote: str = Field(min_length=1, max_length=20_000)
    citation_id: str | None = None
    page_char_start: int | None = Field(default=None, ge=0)
    page_char_end: int | None = Field(default=None, ge=0)
    bounding_boxes: list[BoundingBox] | None = None
    note: str | None = None
    extraction_version: str = ""
    # Where the highlight sits in the original file, for viewers that address
    # their own units (spreadsheet cells). Optional; text highlights omit it.
    anchor: Annotated[XlsxAnchor | PptxAnchor, Field(discriminator="format")] | None = None


class AnnotationUpdate(BaseModel):
    note: str | None = None
    quote: str | None = Field(default=None, min_length=1, max_length=20_000)


class Annotation(BaseModel):
    id: str
    workspace_id: str
    conversation_id: str
    document_id: str
    kind: str
    citation_id: str | None = None
    page_number: int
    quote: str
    page_char_start: int | None = None
    page_char_end: int | None = None
    bounding_boxes: list[BoundingBox] | None = None
    note: str | None = None
    extraction_version: str = ""
    anchor: dict[str, Any] | None = None
    created_at: str
    updated_at: str


class NoteSaveRequest(BaseModel):
    content: str = Field(max_length=500_000)
    # The revision the client last read. A mismatch is a 409, never a silent
    # overwrite of someone else's edit.
    expected_revision: int = Field(default=0, ge=0)
    workspace_id: str = ""


class Note(BaseModel):
    conversation_id: str
    workspace_id: str = ""
    revision: int
    content: str
    updated_at: str | None = None
    updated_by: str | None = None


class NoteRevisionSummary(BaseModel):
    revision: int
    content: str
    created_by: str | None = None
    created_at: str


class ApprovalRequest(BaseModel):
    token: str = Field(min_length=1, max_length=4096)
