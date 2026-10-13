// The only place in the app that calls fetch. Every function is typed, every
// request has an AbortController timeout, and every failure surfaces the
// FastAPI `detail` string plus the X-Request-ID for debuggability.

import { clearSnapshots } from '@/lib/snapshot.mjs'
import { API_BASE_URL, BYO_OPENAI_KEY_HEADER, ROUTES, STORAGE_KEYS, TIMEOUTS, asset } from '@/config'
import type {
  AccountStatus,
  AuthTokenResponse,
  TrustedBrowser,
  ChatTurnSummary,
  DeleteDocumentResponse,
  DocumentSummary,
  HealthStatus,
  IngestJobStatus,
  IngestParams,
  IngestResponse,
  QueryResponse,
} from '@/types/api'

export class ApiError extends Error {
  readonly status: number | null
  readonly detail: string
  readonly requestId: string | null
  /** Which demo limit refused this request ("question-account", "upload-daily", …), if any. */
  readonly limit: string | null

  constructor(status: number | null, detail: string, requestId: string | null, limit: string | null = null) {
    super(detail)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.requestId = requestId
    this.limit = limit
  }

  /** 404 from /query means the document has no index yet — an empty state, not an error. */
  get isNotIngested() {
    return this.status === 404
  }

  /** 401 means the stored token is missing, expired, or was issued by another environment. */
  get isUnauthorized() {
    return this.status === 401
  }

  /** 429 from the per-user rate limiter. */
  get isRateLimited() {
    return this.status === 429
  }

  /** The caller cancelled (navigation, unmount) — not a failure to report. */
  get isCancelled() {
    return this.status === null && this.detail === CANCELLED
  }

  /** Worth waiting for the server and trying again: no response at all
   *  (network error or timeout) or a gateway/availability status while a
   *  replica starts. A 4xx is a real answer and is never "transient". */
  get isTransient() {
    if (this.isCancelled) return false
    return this.status === null || this.status === 502 || this.status === 503 || this.status === 504
  }
}

const CANCELLED = 'Request cancelled'

interface RequestOptions {
  method?: string
  body?: BodyInit
  headers?: Record<string, string>
  timeout: number
  signal?: AbortSignal
  /** Auth endpoints must not trigger the global sign-out on 401 — a wrong
   *  password is a normal outcome there, not an expired session. */
  skipAuthRedirect?: boolean
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(STORAGE_KEYS.jwt)
  } catch {
    return null
  }
}

/** Cleared on 401 so a stale token can't wedge the UI in a signed-in state
 *  that every request rejects. The listener lets useAuth react without this
 *  module importing React. */
/** A one-time note for the sign-in page (why the session ended). */
export const SIGNIN_NOTICE_KEY = 'citely.signin-notice'

function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEYS.jwt)
    localStorage.removeItem(STORAGE_KEYS.user)
    clearSnapshots()
  } catch {
    /* private browsing */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('rag:signed-out'))
  }
}

export async function request<T>(path: string, opts: RequestOptions): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeout)

  // Respect an externally supplied signal (component unmount) as well as the timeout.
  const onExternalAbort = () => controller.abort()
  if (opts.signal?.aborted) controller.abort()
  opts.signal?.addEventListener('abort', onExternalAbort)

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: opts.method ?? 'GET',
      body: opts.body,
      headers: opts.headers,
      signal: controller.signal,
    })
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError'
    // An abort is either our timeout or the caller cancelling; only the
    // former is a timeout worth reporting.
    if (aborted && opts.signal?.aborted) throw new ApiError(null, CANCELLED, null)
    throw new ApiError(
      null,
      aborted
        ? `Request timed out after ${Math.round(opts.timeout / 1000)}s`
        : 'Could not reach the backend. It may be waking up — try again in a moment.',
      null,
    )
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onExternalAbort)
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // Some error paths return an empty body; fall through with payload = null.
  }

  if (!response.ok) failFrom(response, payload, opts)
  return payload as T
}

/** Throws the ApiError for a failed response, after the side effects every
 *  caller needs: a 401 signs out, an account that can't use the workspace
 *  is sent to the screen that says why. */
function failFrom(response: Response, payload: unknown, opts: { skipAuthRedirect?: boolean }): never {
  const headerRequestId = response.headers.get('X-Request-ID')
  const bodyRecord = (payload ?? {}) as Record<string, unknown>
  const bodyRequestId = typeof bodyRecord.request_id === 'string' ? bodyRecord.request_id : null
  if (response.status === 401 && !opts.skipAuthRedirect) clearSession()
  // The account can't use the workspace (any more): show why, instead of
  // a broken page. Pending or declined -> the review screen; suspended ->
  // signed out, with the reason on the sign-in page.
  const account = response.headers.get('X-Citely-Account')
  if (response.status === 403 && account && !opts.skipAuthRedirect && typeof window !== 'undefined') {
    if (account === 'suspended') {
      // One navigation only: the workspace's own sign-out listener already
      // goes to /signin/ when the session is cleared, so the reason travels
      // as a note the sign-in page reads. Elsewhere, navigate here.
      try { sessionStorage.setItem(SIGNIN_NOTICE_KEY, 'suspended') } catch { /* private browsing */ }
      clearSession()
      // The workspace marks that its own listener redirects on sign-out (by
      // flag, not by URL: hosts may serve studio.html as /studio).
      if (!(window as any).__citelySignOutRedirects) window.location.assign(asset('/signin/') + '?reason=suspended')
    }
    else if (!window.location.pathname.includes('/review')) window.location.assign(asset('/review/'))
  }
  const detail =
    typeof bodyRecord.detail === 'string'
      ? bodyRecord.detail
      : `HTTP ${response.status} ${response.statusText}`.trim()
  throw new ApiError(response.status, detail, bodyRequestId ?? headerRequestId, response.headers.get('X-Citely-Limit'))
}

/** Bearer token on every authenticated route. Replaces the old X-Api-Key
 *  shared secret, which was a static string rather than real auth. */
// ---------------------------------------------------------------------------
// Presence (the admin console's "online"; see lib/presence.mjs)
// ---------------------------------------------------------------------------

export type PresenceState = 'active' | 'idle' | 'hidden' | 'closed' | 'signed_out'
export type PresenceSignal = { state: PresenceState; seq?: number; first?: boolean; tab?: string; timezone?: string; path?: string }

let pageBrowserId: string | null = null
const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36))

/** One id per browser (all its tabs share the session, so signing out ends
 *  all of them). Private browsing without storage: one per page. */
export function presenceBrowser(): string {
  try {
    let id = localStorage.getItem(STORAGE_KEYS.presenceBrowser)
    if (!id) { id = randomId(); localStorage.setItem(STORAGE_KEYS.presenceBrowser, id) }
    return id
  } catch {
    return (pageBrowserId ||= randomId())
  }
}

/** A workspace tab's signal. Active and idle go through request(), so an
 *  expired session or a blocked account is handled like any other call.
 *  Leaving signals use keepalive so they finish while the page unloads;
 *  nothing waits for them. */
export function sendPresence(signal: PresenceSignal, leaving = false): Promise<void> | undefined {
  const token = getToken()
  if (!token) return undefined
  const body = JSON.stringify({ ...signal, browser: presenceBrowser() })
  if (leaving) {
    try {
      void fetch(API_BASE_URL + ROUTES.presence, { method: 'POST', keepalive: true, body,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }).catch(() => {})
    } catch { /* unloading: best effort; the server's 150-second window covers it */ }
    return undefined
  }
  return request<void>(ROUTES.presence, { method: 'POST', body, headers: authHeaders(jsonHeaders), timeout: TIMEOUTS.health })
    .then(() => { try { localStorage.setItem(STORAGE_KEYS.presenceContact, String(Date.now())) } catch { /* private browsing */ } })
}

/** Signing out in this browser: every workspace tab here stops counting as
 *  online at once. Only sent when a tab here reached the server in the last
 *  30 minutes (beyond that the server no longer shows this browser at all),
 *  so signing out never wakes a sleeping server for nothing. */
export function sendSignedOut() {
  let contact = 0
  try { contact = Number(localStorage.getItem(STORAGE_KEYS.presenceContact)) || 0; localStorage.removeItem(STORAGE_KEYS.presenceContact) } catch { /* private browsing */ }
  if (Date.now() - contact <= 30 * 60_000) sendPresence({ state: 'signed_out' }, true)
}

export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getToken()
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra }
}

const jsonHeaders = { 'Content-Type': 'application/json' }

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** `cold` gives the request the much longer budget a scale-to-zero wake needs;
 *  a warm probe should still fail fast so the UI notices a real outage. */
export function getHealth(signal?: AbortSignal, cold = false) {
  return request<HealthStatus>(ROUTES.health, {
    timeout: cold ? TIMEOUTS.healthCold : TIMEOUTS.health,
    signal,
  })
}

/** Liveness with a caller-chosen budget: answers as soon as the server
 *  process is up, whatever the state of its dependencies. */
export function getLive(timeout: number, signal?: AbortSignal) {
  return request<HealthStatus>(ROUTES.health, { timeout, signal })
}

/** Fired when the app mounts, to absorb a scale-to-zero cold start during the
 *  seconds the user spends reading the page or choosing a file.
 *
 *  Hits /warmup, not /health: /health touches no model, so it wakes the
 *  container but leaves the embedding model and reranker to load on the first
 *  question — which is where the wait was actually being felt. /warmup starts
 *  that load in the background and returns immediately.
 */
export function warmup() {
  return request<{ status: string }>(ROUTES.warmup, {
    method: 'POST',
    timeout: TIMEOUTS.healthCold,
  }).catch(() => null)
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function signUpEmail(email: string, password: string, turnstileToken?: string) {
  return request<{ detail: string }>(ROUTES.authSignup, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ email, password, turnstile_token: turnstileToken || undefined }),
    timeout: TIMEOUTS.auth,
    skipAuthRedirect: true,
  })
}

export function verifyOtp(email: string, code: string) {
  return request<AuthTokenResponse>(ROUTES.authVerifyOtp, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ email, code }),
    timeout: TIMEOUTS.auth,
    skipAuthRedirect: true,
  })
}

export function resendOtp(email: string) {
  return request<{ detail: string }>(ROUTES.authResendOtp, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ email }),
    timeout: TIMEOUTS.auth,
    skipAuthRedirect: true,
  })
}

export function requestPasswordReset(email: string) {
  return request<{ detail: string; admin_reset?: boolean }>(ROUTES.authRequestPasswordReset, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ email }),
    timeout: TIMEOUTS.auth,
    skipAuthRedirect: true,
  })
}

export function resetPassword(email: string, token: string, newPassword: string) {
  return request<{ detail: string }>(ROUTES.authResetPassword, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ email, token, new_password: newPassword }),
    timeout: TIMEOUTS.auth,
    skipAuthRedirect: true,
  })
}

export function signInEmail(email: string, password: string, trustedBrowser?: string) {
  return request<AuthTokenResponse>(ROUTES.authLogin, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ email, password, ...(trustedBrowser ? { trusted_browser: trustedBrowser } : {}) }),
    timeout: TIMEOUTS.auth,
    skipAuthRedirect: true,
  })
}

export function signInWithGithub(code: string, trustedBrowsers: string[] = []) {
  return request<AuthTokenResponse>(ROUTES.authGithub, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ code, trusted_browsers: trustedBrowsers }),
    timeout: TIMEOUTS.auth,
    skipAuthRedirect: true,
  })
}

export function signInWithGoogle(code: string, redirectUri: string, trustedBrowsers: string[] = []) {
  return request<AuthTokenResponse>(ROUTES.authGoogle, {
    method: 'POST',
    headers: jsonHeaders,
    // Google validates redirect_uri again at token exchange, so the backend
    // must be told the exact value the browser used.
    body: JSON.stringify({ code, redirect_uri: redirectUri, trusted_browsers: trustedBrowsers }),
    timeout: TIMEOUTS.auth,
    skipAuthRedirect: true,
  })
}

/** Finishes a sign-in that needed its emailed code. */
export function enterLoginCode(ticket: string, code: string, trustBrowser: boolean, browserLabel?: string) {
  return request<AuthTokenResponse>(ROUTES.authLoginCode, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ ticket, code, trust_browser: trustBrowser, browser_label: browserLabel }),
    timeout: TIMEOUTS.auth,
    skipAuthRedirect: true,
  })
}

export function resendLoginCode(ticket: string) {
  return request<{ ticket: string; sent_to: string }>(ROUTES.authLoginCodeResend, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ ticket }),
    timeout: TIMEOUTS.auth,
    skipAuthRedirect: true,
  })
}

export function getMe() {
  return request<{ id: string; email: string; status: AccountStatus; is_admin: boolean }>(ROUTES.me, {
    headers: authHeaders(),
    timeout: TIMEOUTS.auth,
  })
}

export function listTrustedBrowsers() {
  return request<{ items: TrustedBrowser[] }>(ROUTES.trustedBrowsers, { headers: authHeaders(), timeout: TIMEOUTS.auth })
}

export function removeTrustedBrowser(id: string) {
  return request<{ removed: boolean }>(ROUTES.trustedBrowsers + '/' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: authHeaders(),
    timeout: TIMEOUTS.auth,
  })
}

export function signOutEverywhere() {
  return request<{ signed_out: boolean }>(ROUTES.signOutEverywhere, { method: 'POST', headers: authHeaders(), timeout: TIMEOUTS.auth })
}

export function acceptPrivacyPolicy() {
  return request<{ detail: string; privacy_policy_version: string }>(ROUTES.authAcceptPrivacyPolicy, {
    method: 'POST',
    headers: authHeaders(),
    timeout: TIMEOUTS.auth,
  })
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** The retained original file's bytes (owner only). 404 when the document
 *  has no original, so callers fall back to the extracted text. */
export async function fetchOriginal(documentId: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUTS.query)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(documentId)}/file`, {
      headers: authHeaders(), signal: controller.signal,
    })
    if (!response.ok) {
      if (response.status === 401) clearSession()
      throw new ApiError(response.status, response.status === 404 ? 'Original file not available' : `HTTP ${response.status}`, response.headers.get('X-Request-ID'))
    }
    return await response.arrayBuffer()
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (signal?.aborted) throw new ApiError(null, CANCELLED, null)
    throw new ApiError(null, 'The original file could not be downloaded.', null)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export function listDocuments(signal?: AbortSignal) {
  return request<DocumentSummary[]>(ROUTES.documents, {
    headers: authHeaders(),
    timeout: TIMEOUTS.health,
    signal,
  })
}

export function getChatHistory(documentId: string, signal?: AbortSignal) {
  return request<ChatTurnSummary[]>(ROUTES.documentHistory(documentId), {
    headers: authHeaders(),
    timeout: TIMEOUTS.health,
    signal,
  })
}

export function deleteDocument(documentId: string) {
  return request<DeleteDocumentResponse>(ROUTES.document(documentId), {
    method: 'DELETE',
    headers: authHeaders(),
    timeout: TIMEOUTS.health,
  })
}

// ---------------------------------------------------------------------------
// Ingest + query
// ---------------------------------------------------------------------------

function ingestForm({ file, chunkSize, chunkOverlap, qualityThreshold, clientUploadId }: IngestParams) {
  const form = new FormData()
  if (clientUploadId) form.append('client_upload_id', clientUploadId)
  form.append('file', file)
  form.append('chunk_size', String(chunkSize))
  form.append('chunk_overlap', String(chunkOverlap))
  form.append('quality_threshold', String(qualityThreshold))
  return form
}

export function ingest(params: IngestParams) {
  // No Content-Type header: the browser must set the multipart boundary itself.
  return request<IngestResponse>(ROUTES.ingest, {
    method: 'POST',
    body: ingestForm(params),
    headers: authHeaders(),
    timeout: TIMEOUTS.ingest,
  })
}

/** Returns a job id immediately. Preferred for large files: a synchronous
 *  ingest is bounded by the hosting platform's request timeout, this isn't. */
export function ingestAsync(params: IngestParams, signal?: AbortSignal) {
  return request<IngestJobStatus>(ROUTES.ingestAsync, {
    method: 'POST',
    body: ingestForm(params),
    headers: authHeaders(),
    timeout: TIMEOUTS.upload,
    signal,
  })
}

/** A sample document the admin offers in Upload ("Use a sample"). */
export interface SampleDocument { id: string; name: string; filename: string; kind: string; bytes: number }

export function listSamples(signal?: AbortSignal) {
  return request<{ groups: { kind: string; items: SampleDocument[] }[] }>('/samples', { headers: authHeaders(), timeout: TIMEOUTS.health, signal })
}

/** Adds a sample to the account like an upload (same job, limits and
 *  retry-safe client upload id); only the file comes from the server. */
export function useSample(sampleId: string, clientUploadId?: string, signal?: AbortSignal) {
  const query = clientUploadId ? '?client_upload_id=' + encodeURIComponent(clientUploadId) : ''
  return request<IngestJobStatus>(`/samples/${encodeURIComponent(sampleId)}/use${query}`, {
    method: 'POST',
    headers: authHeaders(),
    timeout: TIMEOUTS.upload,
    signal,
  })
}

export interface UsageSnapshot {
  limited: boolean
  max_upload_mb?: number
  max_pages?: number
  uploads?: { used: number; limit: number; remaining: number; daily_exhausted: boolean }
  questions?: { used: number; limit: number; remaining: number; daily_exhausted: boolean }
}

/** The account's demo allowance; `limited: false` for the admin or when limits are off. */
export function getUsage(signal?: AbortSignal) {
  return request<UsageSnapshot>('/me/usage', { headers: authHeaders(), timeout: TIMEOUTS.health, signal })
}

export function getIngestJob(jobId: string, signal?: AbortSignal) {
  return request<IngestJobStatus>(ROUTES.ingestJob(jobId), {
    headers: authHeaders(),
    timeout: TIMEOUTS.health,
    signal,
  })
}

export function query(documentId: string, question: string, topK: number, byoOpenAiKey?: string, documentIds: string[] = []) {
  const extra: Record<string, string> = { ...jsonHeaders }
  if (byoOpenAiKey) extra[BYO_OPENAI_KEY_HEADER] = byoOpenAiKey

  return request<QueryResponse>(ROUTES.query, {
    method: 'POST',
    headers: authHeaders(extra),
    body: JSON.stringify({ document_id: documentId, question, top_k: topK, document_ids: documentIds }),
    timeout: TIMEOUTS.query,
  })
}

/** What a streamed answer reports while it is written. `onDelta` gets the
 *  checked answer so far (whole sentences; replace, don't append); `onReset`
 *  means that text is set aside while the answer is written again. */
export interface AnswerProgress { onDelta?: (text: string) => void; onReset?: () => void }

/** The same answer as query(), shown while it is written. Falls back to
 *  query() against a server without the streaming route. */
export async function queryStream(documentId: string, question: string, topK: number, documentIds: string[] = [], progress: AnswerProgress = {}): Promise<QueryResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUTS.query)
  try {
    let response: Response
    try {
      response = await fetch(`${API_BASE_URL}${ROUTES.query}/stream`, {
        method: 'POST',
        headers: authHeaders({ ...jsonHeaders }),
        body: JSON.stringify({ document_id: documentId, question, top_k: topK, document_ids: documentIds }),
        signal: controller.signal,
      })
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === 'AbortError'
      throw new ApiError(null, aborted ? `Request timed out after ${Math.round(TIMEOUTS.query / 1000)}s`
        : 'Could not reach the backend. It may be waking up — try again in a moment.', null)
    }
    if (!response.ok) {
      let payload: unknown = null
      try { payload = await response.json() } catch { /* empty body */ }
      // An older server without the streaming route: ask the ordinary way.
      if ((response.status === 404 || response.status === 405) && (payload as any)?.detail === (response.status === 404 ? 'Not Found' : 'Method Not Allowed')) {
        clearTimeout(timer)
        return query(documentId, question, topK, undefined, documentIds)
      }
      failFrom(response, payload, {})
    }
    if (!response.body) throw new ApiError(null, 'The answer could not be read. Please ask again.', null)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try { chunk = await reader.read() }
      catch { throw new ApiError(null, controller.signal.aborted ? `Request timed out after ${Math.round(TIMEOUTS.query / 1000)}s` : 'The answer was interrupted. Please ask again.', null) }
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const event = JSON.parse(line)
        if (event.type === 'delta') progress.onDelta?.(event.text)
        else if (event.type === 'reset') progress.onReset?.()
        else if (event.type === 'done') return event.response as QueryResponse
        else if (event.type === 'error') throw new ApiError(event.status ?? null, event.detail || 'The question could not be answered.', response.headers.get('X-Request-ID'))
      }
    }
    throw new ApiError(null, 'The answer was interrupted. Please ask again.', response.headers.get('X-Request-ID'))
  } finally {
    clearTimeout(timer)
  }
}

/** `account`: the address already has an account (pending or declined) that approving lets in. */
export type ApprovalStatus = { email: string; approved: boolean; newly?: boolean; account?: boolean }

/** The approve page (citely.example/approve/): who the link is for, and
 *  whether they already have access. Looking approves nobody. */
export function getApproval(token: string) {
  return request<ApprovalStatus>(`${ROUTES.accessApproval}?token=${encodeURIComponent(token)}`, {
    method: 'GET',
    timeout: TIMEOUTS.auth,
    skipAuthRedirect: true,
  })
}

export function approveAccess(token: string) {
  return request<ApprovalStatus>(ROUTES.accessApproval, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ token }),
    timeout: TIMEOUTS.auth,
    skipAuthRedirect: true,
  })
}
