// The admin console's data layer: which environments exist, signing in to
// each one, and calling its /admin API. Each environment (prod, dev, hack)
// is a separate server with its own database and accounts, so the console
// holds one session per environment and never mixes them.

import { API_BASE_URL, GOOGLE_CLIENT_ID, asset } from '@/config'

export type AdminEnv = { id: string; name: string; site: string; api: string }
export type AccountStatus = 'approved' | 'pending' | 'declined' | 'suspended'

/** Set at build time for admin.citely.example (NEXT_PUBLIC_ADMIN_ENVS, JSON).
 *  Without it (tests, local runs) the console manages this site's own API. */
export function adminEnvs(): AdminEnv[] {
  try {
    const raw = process.env.NEXT_PUBLIC_ADMIN_ENVS
    const list = raw ? (JSON.parse(raw) as AdminEnv[]) : []
    const valid = list.filter(e => e && e.id && e.name && /^https?:\/\//.test(e.api || ''))
    if (valid.length) return valid.map(e => ({ ...e, api: e.api.replace(/\/+$/, ''), site: (e.site || '').replace(/\/+$/, '') }))
  } catch { /* fall through to this site's API */ }
  return [{ id: 'this', name: 'This site', site: '', api: API_BASE_URL }]
}

/** The API origins the admin site talks to, for preconnect hints. */
export const adminApiOrigins = () => [...new Set(adminEnvs().map(e => { try { return new URL(e.api).origin } catch { return '' } }).filter(Boolean))]

// Google returns to /auth/callback/, which is the console only on the admin build.
export const googleEnabled = () => !!GOOGLE_CLIENT_ID && process.env.NEXT_PUBLIC_ADMIN_SITE === 'true'
const callbackUrl = () => location.origin + asset('/auth/callback/')

// ---- sessions (per environment, on this device only) -----------------------

const key = (env: string, what: string) => `citely.admin.${env}.${what}`
const read = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch { /* private browsing */ } }

export const tokenFor = (env: string) => {
  const t = read(key(env, 'token'))
  if (!t) return null
  try {
    const exp = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp
    if (exp * 1000 <= Date.now()) { write(key(env, 'token'), null); return null }
  } catch { return null }
  return t
}
export const signOutOf = (env: string) => { write(key(env, 'token'), null); write(key(env, 'email'), null); forgetEnv(env) }
export const emailFor = (env: string) => read(key(env, 'email'))
const trustedFor = (env: string) => read(key(env, 'trusted'))

// ---- requests ---------------------------------------------------------------

export class AdminError extends Error {
  constructor(public status: number | null, message: string) { super(message) }
}

async function call<T>(env: AdminEnv, path: string, init: { method?: string; body?: unknown; form?: FormData; auth?: boolean; timeout?: number } = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeout ?? 90_000)   // a sleeping server takes a while to wake
  const headers: Record<string, string> = {}
  if (init.auth !== false) { const t = tokenFor(env.id); if (t) headers.Authorization = 'Bearer ' + t }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  let response: Response
  try {
    response = await fetch(env.api + path, { method: init.method ?? 'GET', headers, signal: controller.signal,
      body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined) })
  } catch {
    throw new AdminError(null, `Couldn't reach ${env.name}'s server. It may be waking up; try again in a moment.`)
  } finally { clearTimeout(timer) }
  let data: any = null
  try { data = await response.json() } catch { /* empty body */ }
  if (!response.ok) {
    if (response.status === 401 && init.auth !== false) signOutOf(env.id)
    const detail = typeof data?.detail === 'string' ? data.detail : `HTTP ${response.status}`
    throw new AdminError(response.status, detail)
  }
  // A change (approve, save limits, delete…) can alter any of this
  // environment's views: keep showing them, but load each afresh on its next view.
  if ((init.method ?? 'GET') !== 'GET' && init.auth !== false) markStale(env.id)
  return data as T
}

// ---- shared answers ---------------------------------------------------------
// What the console has loaded, per environment and view ("dev:overview"), for
// this tab. A view shows its last answer at once while it refreshes; identical
// requests in flight are one request (the signed-in check and the Overview
// share theirs); and the background prefetch fills it for the other signed-in
// environments, so switching to one shows its data without waiting.

type Entry = { data?: unknown; at?: number; pending?: Promise<unknown>; seq: number }
const store = new Map<string, Entry>()

/** An answer this young is used as it is: no request (it was just prefetched). */
export const FRESH_MS = 15_000

export function cached<T>(key: string): { data: T; at: number } | undefined {
  const e = store.get(key)
  return e && e.at !== undefined ? { data: e.data as T, at: e.at } : undefined
}

/** The answer for `key`: the request already in flight for it, or the stored
 *  answer if it is younger than maxAgeMs, or a new request. `force` always
 *  sends a new request (after a change); a slower, older one then can't
 *  overwrite its answer. */
export function load<T>(key: string, fetcher: () => Promise<T>, { maxAgeMs = 0, force = false } = {}): Promise<T> {
  const e = store.get(key) ?? { seq: 0 }
  if (!force && e.pending) return e.pending as Promise<T>
  if (!force && e.at !== undefined && Date.now() - e.at < maxAgeMs) return Promise.resolve(e.data as T)
  const seq = e.seq + 1
  const pending = fetcher().then(data => {
    const now = store.get(key)
    if (now && now.seq === seq) store.set(key, { data, at: Date.now(), seq })
    return data
  }, err => {
    const now = store.get(key)
    if (now && now.seq === seq) store.set(key, { data: now.data, at: now.at, seq })
    throw err
  })
  store.set(key, { data: e.data, at: e.at, pending, seq })
  return pending
}

/** Store an answer the page already has (a save's reply, a longer list). */
export function remember(key: string, data: unknown) {
  const e = store.get(key)
  store.set(key, { data, at: Date.now(), seq: (e?.seq ?? 0) + 1 })
}

/** Everything of one environment loads afresh next time (still shown meanwhile). */
export function markStale(envId: string) {
  for (const [k, e] of store) if (k.startsWith(envId + ':') && e.at !== undefined) store.set(k, { ...e, at: 0 })
}

/** Signed out of an environment: nothing of it stays on this page. */
export function forgetEnv(envId: string) {
  for (const k of [...store.keys()]) if (k.startsWith(envId + ':')) store.delete(k)
}

// ---- sign-in ----------------------------------------------------------------

export type SignInStep = { done: true } | { done: false; ticket: string; sentTo: string }

function finish(env: AdminEnv, r: any): SignInStep {
  if (r.code_required && r.ticket) return { done: false, ticket: r.ticket, sentTo: r.sent_to || r.email }
  if (!r.access_token) throw new AdminError(null, 'Sign-in did not complete.')
  write(key(env.id, 'token'), r.access_token)
  write(key(env.id, 'email'), r.email)
  if (r.trusted_browser) write(key(env.id, 'trusted'), r.trusted_browser)
  return { done: true }
}

export async function signIn(env: AdminEnv, email: string, password: string): Promise<SignInStep> {
  const trusted = trustedFor(env.id)
  return finish(env, await call(env, '/auth/login', { method: 'POST', auth: false, body: { email, password, ...(trusted ? { trusted_browser: trusted } : {}) } }))
}

export async function enterCode(env: AdminEnv, ticket: string, code: string, trust: boolean): Promise<SignInStep> {
  return finish(env, await call(env, '/auth/login-code', { method: 'POST', auth: false, body: { ticket, code, trust_browser: trust, browser_label: 'Admin console' } }))
}

export const resendCode = (env: AdminEnv, ticket: string) =>
  call<{ ticket: string; sent_to: string }>(env, '/auth/login-code/resend', { method: 'POST', auth: false, body: { ticket } })

/** Google sign-in for one environment: the provider's code is exchanged by
 *  that environment's server (it can be used once). */
export function googleUrl(env: AdminEnv): string {
  const state = 'admin:' + env.id + ':' + crypto.randomUUID()
  try { sessionStorage.setItem('citely.admin.oauth', state) } catch { /* private browsing */ }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: callbackUrl(), state,
    scope: 'openid email profile', response_type: 'code' }).toString()
  return url.href
}

export async function googleCallback(params: URLSearchParams): Promise<{ env: AdminEnv; step: SignInStep } | null> {
  const state = params.get('state') || '', code = params.get('code')
  if (!state.startsWith('admin:') || !code) return null
  let stored = null
  try { stored = sessionStorage.getItem('citely.admin.oauth'); sessionStorage.removeItem('citely.admin.oauth') } catch { /* */ }
  if (stored !== state) throw new AdminError(null, 'Sign-in state did not match. Please start again.')
  const env = adminEnvs().find(e => e.id === state.split(':')[1])
  if (!env) throw new AdminError(null, 'Unknown environment.')
  const trusted = trustedFor(env.id)
  const r = await call(env, '/auth/google/callback', { method: 'POST', auth: false,
    body: { code, redirect_uri: callbackUrl(), trusted_browsers: trusted ? [trusted] : [] } })
  return { env, step: finish(env, r) }
}

// ---- admin API ----------------------------------------------------------------

/** The site-wide daily limits as they stand today, per kind (upload, question). */
export type SharedToday = Record<string, { used: number; limit: number; left: number }>

/** A sentence for the admin when the shared daily limit, not the account, is what holds someone back. */
export function sharedNote(shared?: SharedToday, accountLimits?: { uploads?: number; questions?: number }): string {
  if (!shared) return ''
  const parts = [['question', 'questions', accountLimits?.questions], ['upload', 'uploads', accountLimits?.uploads]]
    .filter(([k, , own]) => shared[k as string]?.used > 0 && (own === undefined || shared[k as string].left < (own as number)))
    .map(([k, noun]) => `${shared[k as string].left} ${noun}`)
  return parts.length ? ` Today the live demo's shared daily limit only leaves ${parts.join(' and ')} for everyone, so that is all they can use until midnight (India time), unless you clear today's shared count or raise the daily limit.` : ''
}

export const api = {
  me: (env: AdminEnv) => call<{ email: string; status: AccountStatus; is_admin: boolean }>(env, '/me'),
  // A sleeping server takes ~30 s to answer; pass a longer timeout to wait for it.
  health: (env: AdminEnv, timeout = 15_000) => call<any>(env, '/health', { auth: false, timeout }),
  overview: (env: AdminEnv) => call<any>(env, '/admin/overview'),
  users: (env: AdminEnv, q: { query?: string; status?: string; offset?: number }) =>
    call<{ total: number; items: any[] }>(env, '/admin/users?' + new URLSearchParams(
      Object.entries({ query: q.query || '', status: q.status || '', offset: String(q.offset || 0), limit: '50' }).filter(([, v]) => v !== '') as [string, string][])),
  user: (env: AdminEnv, id: string) => call<any>(env, '/admin/users/' + encodeURIComponent(id)),
  setStatus: (env: AdminEnv, id: string, action: string, reason?: string) =>
    call<any>(env, `/admin/users/${encodeURIComponent(id)}/status`, { method: 'POST', body: { action, ...(reason ? { reason } : {}) } }),
  deleteUser: (env: AdminEnv, id: string, confirm: string) =>
    call<any>(env, `/admin/users/${encodeURIComponent(id)}/delete`, { method: 'POST', body: { confirm } }),
  passwordReset: (env: AdminEnv, id: string) => call<any>(env, `/admin/users/${encodeURIComponent(id)}/password-reset`, { method: 'POST' }),
  limits: (env: AdminEnv) => call<any>(env, '/admin/limits'),
  resetUsage: (env: AdminEnv, id: string) => call<{ id: string; email: string; cleared: any; shared?: SharedToday }>(env, `/admin/users/${encodeURIComponent(id)}/reset-usage`, { method: 'POST' }),
  resetToday: (env: AdminEnv) => call<{ cleared: Record<string, number>; shared: SharedToday }>(env, '/admin/limits/reset-today', { method: 'POST' }),
  saveLimits: (env: AdminEnv, limits: any) => call<any>(env, '/admin/limits', { method: 'PUT', body: limits }),
  revokeBrowsers: (env: AdminEnv, id: string) => call<any>(env, `/admin/users/${encodeURIComponent(id)}/revoke-browsers`, { method: 'POST' }),
  demoRequests: (env: AdminEnv) => call<{ items: any[] }>(env, '/admin/demo-requests'),
  approveRequest: (env: AdminEnv, id: string) => call<any>(env, `/admin/demo-requests/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  events: (env: AdminEnv, q: { type?: string; user_id?: string; before_id?: number }) =>
    call<{ items: any[] }>(env, '/admin/events?' + new URLSearchParams(
      Object.entries({ type: q.type || '', user_id: q.user_id || '', before_id: q.before_id ? String(q.before_id) : '', limit: '50' }).filter(([, v]) => v !== '') as [string, string][])),
  database: (env: AdminEnv) => call<any>(env, '/admin/database'),
  // Admin notifications: the address (masked), recent outcomes, failures; with testId, how that test went.
  notifications: (env: AdminEnv, testId?: string) => call<any>(env, '/admin/notifications' + (testId ? '?test_id=' + encodeURIComponent(testId) : '')),
  testNotification: (env: AdminEnv) => call<{ test_id: string; state: string; recipient: string | null }>(env, '/admin/notifications/test', { method: 'POST' }),
  server: (env: AdminEnv) => call<any>(env, '/admin/server'),
  uptime: (env: AdminEnv) => call<any>(env, '/admin/uptime', { timeout: 40_000 }),
  uptimeCheck: (env: AdminEnv) => call<any>(env, '/admin/uptime/check', { method: 'POST', timeout: 40_000 }),
  traffic: (env: AdminEnv, days: number) => call<any>(env, '/admin/traffic?days=' + days, { timeout: 40_000 }),
  samples: (env: AdminEnv) => call<{ items: any[] }>(env, '/admin/samples'),
  addSample: (env: AdminEnv, file: File) => { const f = new FormData(); f.append('file', file); return call<any>(env, '/admin/samples', { method: 'POST', form: f, timeout: 180_000 }) },
  renameSample: (env: AdminEnv, id: string, name: string) => call<any>(env, `/admin/samples/${encodeURIComponent(id)}/rename`, { method: 'POST', body: { name } }),
  deleteSample: (env: AdminEnv, id: string) => call<any>(env, `/admin/samples/${encodeURIComponent(id)}/delete`, { method: 'POST' }),
}
