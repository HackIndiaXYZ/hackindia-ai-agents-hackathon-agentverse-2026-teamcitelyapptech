// Mirrors the FastAPI response models exactly. Fields the backend declares as
// nullable are nullable here too — the UI must guard them.

export type SubsystemState = 'starting' | 'unknown' | 'up' | 'down'

export interface DependencyState {
  state: SubsystemState
  checked_at: string | null
  age_s: number | null
}

/** /health is liveness: `status` is "ok" whenever the process answers.
 *  Dependency readiness is `readiness` (and the separate /ready endpoint).
 *  The readiness fields are absent on backends deployed before they existed. */
export interface HealthStatus {
  status: 'ok' | 'degraded'
  service: string
  qdrant: SubsystemState
  openai: SubsystemState
  collection_name: string | null
  ready?: boolean
  readiness?: 'ready' | 'starting' | 'degraded'
  dependencies?: Record<string, DependencyState>
  version?: string
}

export interface IngestResponse {
  request_id: string
  document_id: string
  collection_name: string
  filename: string
  file_type: string
  pages: number
  chunks: number
  passed_chunks: number
  penalised_chunks: number
  indexed_chunks: number
}

export interface SourceChunk {
  offset_unit?: 'utf16' | 'codepoint'
  evidence_role?: 'cited' | 'legacy-context'
  citation_id?: string | null
  page_char_start?: number | null
  page_char_end?: number | null
  quote?: string | null
  extraction_version?: string | null
  document_id?: string | null
  chunk_id: number | string | null
  source: string
  page: number | string | null
  /** Reciprocal Rank Fusion score — NOT a 0–1 similarity. Values are small (~0.04). */
  score: number | null
  content: string
  /** Where the passage sits in the original file, for natively parsed
   *  spreadsheets: sheet + A1 range, narrowed to the cited cells. */
  anchor?: CellAnchor | SlideAnchor | null
}

export interface CellAnchor {
  format: 'xlsx'; sheet_name: string; sheet_index: number; range: string; cells?: string[]
}
/** A shape (or table cell/row) on a slide, with the cited characters when narrowed to one shape or cell. */
export interface SlideAnchor {
  format: 'pptx'; slide_index: number; shape_id: number; row?: number | null; col?: number | null;
  cells?: [number, number][]; quote?: string; offset?: number; occurrence?: number
}

export interface QueryResponse {
  request_id: string
  answer: string
  sources: SourceChunk[]
  model: string
}

export interface IngestParams {
  file: File
  chunkSize: number
  chunkOverlap: number
  qualityThreshold: number
  /** The client's id for this upload; a resend with the same id is answered
   *  with the job already created, never a second ingest. */
  clientUploadId?: string
}

/** Connectivity state derived from polling /health. */
export type HealthState = 'checking' | 'ok' | 'degraded' | 'offline'

/** Drives the reactive canvas background and other ambient surfaces. */
export type Activity = 'idle' | 'querying' | 'ingesting' | 'connected' | 'offline'

// ---------------------------------------------------------------------------
// Auth + documents (Phase 1 backend, surfaced in Phase 4)
// ---------------------------------------------------------------------------

export type AccountStatus = 'approved' | 'pending' | 'declined' | 'suspended'

export interface AuthTokenResponse {
  /** null while the sign-in still needs its emailed code (code_required). */
  access_token: string | null
  user_id: string
  email: string
  privacy_policy_accepted: boolean
  status: AccountStatus
  code_required?: boolean
  ticket?: string | null
  sent_to?: string | null
  /** Kept by this browser to skip the code for 30 days. */
  trusted_browser?: string | null
}

export interface TrustedBrowser {
  id: string
  label: string | null
  created_at: string
  expires_at: string
  last_used_at: string | null
}

export interface User {
  id: string
  email: string
  privacyPolicyAccepted: boolean
}

export interface DocumentSummary {
  id: string
  filename: string
  ingested_at: string
  pages: number | null
  indexed_chunks: number | null
  /** A retained original exists (absent on backends before originals). */
  has_original?: boolean
  /** The original reproduces the stored extraction, so offsets describe it. */
  original_compatible?: boolean | null
}

export interface ChatTurnSummary {
  id: string
  question: string
  answer: string
  sources: SourceChunk[]
  created_at: string
}

export interface DeleteDocumentResponse {
  deleted: string
  request_id?: string
}

/** Async ingest: POST /ingest/async returns this immediately, then poll. */
export interface IngestJobStatus {
  job_id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  filename: string
  result: IngestResponse | null
  error: string | null
  created_at: number
  updated_at: number
}

// Mirrors APP.schemas; do not reduce precise ranges to paragraph identities.
export interface DocumentPage { page: number; text: string; extraction_version: string }
export interface AnnotationCreate {
  document_id: string; workspace_id: string; kind: 'citation' | 'manual-highlight';
  page_number: number; quote: string; citation_id?: string | null;
  page_char_start?: number | null; page_char_end?: number | null; extraction_version: string;
  /** A highlight made in the spreadsheet viewer: cells rather than characters. */
  anchor?: Omit<CellAnchor, 'cells'> | Omit<SlideAnchor, 'cells'> | null;
}
export interface Annotation extends AnnotationCreate {
  id: string; conversation_id: string; created_at: string; updated_at: string;
}
export interface Note { conversation_id: string; workspace_id: string; revision: number; content: string; updated_at: string | null; updated_by: string | null }
export interface NoteRevision { revision: number; content: string; created_by: string | null; created_at: string }
