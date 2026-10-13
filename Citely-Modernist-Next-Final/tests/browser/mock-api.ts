import {Page} from '@playwright/test';

/** A stateful, in-browser mock of the backend for reliability tests.
 *  Records every request, can fail any path once, delay any path, and script
 *  /ready as a sequence of status codes to simulate a cold start. */
export type MockOptions = {
  readySequence?: number[];          // status per /health (and /ready) call; last value repeats
  failOnce?: string[];               // path prefixes answering 503 the first time
  delayMs?: Record<string, number>;  // path prefix -> artificial latency
  queryDelayMs?: number;
  answer?: string;                  // the text every /query answers with (default 'ANSWER FOR <document>')
  loginFailures?: number;            // leading /auth/login calls answering 503
  signupStatus?: number;
  /** What happens to each POST /ingest/async attempt, in order (then success):
   *  'abort' — never reached the server; '503' — answered unavailable;
   *  'lost'  — reached the server (a job exists) but the response was lost. */
  uploadAttempts?: ('abort' | '503' | 'lost')[];
  catalogPutDelayMs?: number;        // slow catalog saves (e.g. a waking server)
  catalogPutLostOnce?: boolean;      // the first catalog save is stored, but its response is lost
  usage?: any;                       // /me/usage body (absent = 404, read as unlimited)
  /** GET /samples: the groups offered under "Try a sample" (default none), or 'error'. */
  samples?: {kind: string; items: {id: string; name: string; filename: string; kind: string; bytes: number}[]}[] | 'error';
  queryLimit?: {header: string; message: string};   // every /query answers 429 with this demo limit
  /** Account behaviour: its status, whether sign-in asks for the emailed code
   *  (123456 is right; TRUSTED skips it), and a workspace refusing it (403). */
  account?: {status?: 'approved' | 'pending' | 'declined'; codeRequired?: boolean; blocked?: 'pending' | 'declined' | 'suspended'};
};

/** The trusted-browser token the mock hands out and accepts. */
export const TRUSTED = 'trusted-browser-token-0123456789abcdef';

export async function mockApi(page: Page, opts: MockOptions = {}) {
  const docs = [
    {id: 'doc1', filename: 'Alpha report.txt', pages: 1, ingested_at: '2026-10-01'},
    {id: 'doc2', filename: 'Beta report.txt', pages: 1, ingested_at: '2026-10-01'},
  ];
  // POST /me/presence, in arrival order: {state, browser, tab, seq, first?, timezone?, path?}.
  const presence: any[] = [];
  const account = {status: opts.account?.status || 'approved', trusted: [] as any[], signedOutEverywhere: 0};
  const token = () => 'e30.' + Buffer.from(JSON.stringify({exp: 9999999999})).toString('base64') + '.t';
  const signedInAs = (email: string, extra: any = {}) => ({access_token: token(), user_id: 'u1', email, privacy_policy_accepted: true, status: account.status, ...extra});
  const challengeOr = (email: string, trusted: string[]) => opts.account?.codeRequired && account.status === 'approved' && !trusted.includes(TRUSTED)
    ? {access_token: null, user_id: 'u1', email, privacy_policy_accepted: true, status: 'approved', code_required: true, ticket: 'ticket-1', sent_to: email[0] + '••••@' + email.split('@')[1]}
    : signedInAs(email);
  const records = new Map<string, {value: any; revision: number}>([
    ['catalog', {value: {orgs: [{id: 'personal', name: 'Personal', spaces: [{id: 'org', name: 'My workspace', folders: [],
      docs: docs.map(d => ({...d, name: d.filename, status: 'Ready', folder: null}))}]}]}, revision: 1}],
  ]);
  const notes = new Map<string, {content: string; revision: number}>([
    ['org:doc1', {content: 'Notes for ALPHA', revision: 1}],
    ['org:doc2', {content: 'Notes for BETA', revision: 1}],
  ]);
  const log: {method: string; path: string; body?: any; t: number; status?: number}[] = [];
  const failed = new Set<string>();
  let readyCalls = 0, loginCalls = 0, uploadCalls = 0;
  const jobs = new Map<string, {id: string; filename: string; doc: string}>();   // by client_upload_id
  const ingested: string[] = [];
  const t0 = Date.now();

  await page.route(/(127\.0\.0\.1:8000|rag-api-staging\.)/, async route => {
    const req = route.request(), path = decodeURIComponent(new URL(req.url()).pathname), method = req.method();
    let body: any; try { body = req.postDataJSON(); } catch { body = undefined; }
    log.push({method, path, body, t: Date.now() - t0});
    const delay = Object.entries(opts.delayMs || {}).find(([p]) => path.startsWith(p))?.[1];
    if (delay) await new Promise(r => setTimeout(r, delay));
    const failPrefix = (opts.failOnce || []).find(p => path.startsWith(p) && !failed.has(p));
    if (failPrefix && method === 'GET') { failed.add(failPrefix); return route.fulfill({status: 503, json: {detail: 'Temporarily unavailable'}}); }

    if (path === '/ingest/async' && method === 'POST') {
      const form = req.postData() || '';
      const key = /name="client_upload_id"\r\n\r\n([^\r]*)/.exec(form)?.[1] || 'none-' + uploadCalls;
      const filename = /filename="([^"]*)"/.exec(form)?.[1] || 'upload';
      const outcome = (opts.uploadAttempts || [])[uploadCalls++];
      if (outcome === 'abort') return route.abort('failed');
      if (outcome === '503') return route.fulfill({status: 503, json: {detail: 'Service unavailable'}});
      let job = jobs.get(key);
      if (!job) { job = {id: 'job-' + key, filename, doc: 'up-' + key}; jobs.set(key, job); ingested.push(filename); }
      if (outcome === 'lost') return route.abort('timedout');
      return route.fulfill({status: 202, json: {job_id: job.id, status: 'queued', filename, created_at: 0, updated_at: 0}});
    }
    if (path === '/samples' && method === 'GET') {
      if (opts.samples === 'error') return route.fulfill({status: 500, json: {detail: 'Samples are unavailable right now.'}});
      return route.fulfill({status: 200, json: {groups: opts.samples || []}});
    }
    const sampleUse = /^\/samples\/([^/]+)\/use$/.exec(path);
    if (sampleUse && method === 'POST') {
      const sample = (Array.isArray(opts.samples) ? opts.samples : []).flatMap(g => g.items).find(i => i.id === sampleUse[1]);
      if (!sample) return route.fulfill({status: 404, json: {detail: 'Sample not found.'}});
      const key = new URL(req.url()).searchParams.get('client_upload_id') || 'sample-' + uploadCalls++;
      let job = jobs.get(key);
      if (!job) { job = {id: 'job-' + key, filename: sample.filename, doc: 'up-' + key}; jobs.set(key, job); ingested.push(sample.filename); }
      return route.fulfill({status: 202, json: {job_id: job.id, status: 'queued', filename: sample.filename, created_at: 0, updated_at: 0}});
    }
    if (path.startsWith('/ingest/jobs/')) {
      const job = [...jobs.values()].find(j => j.id === path.slice('/ingest/jobs/'.length));
      if (!job) return route.fulfill({status: 404, json: {detail: 'Job not found'}});
      if (!docs.some(d => d.id === job.doc)) docs.push({id: job.doc, filename: job.filename, pages: 1, ingested_at: '2026-10-04'});
      return route.fulfill({status: 200, json: {job_id: job.id, status: 'succeeded', filename: job.filename, result: {document_id: job.doc, pages: 1}, created_at: 0, updated_at: 0}});
    }
    if (path === '/state/catalog' && method === 'PUT' && opts.catalogPutDelayMs) await new Promise(r => setTimeout(r, opts.catalogPutDelayMs));
    if (path === '/state/catalog' && method === 'PUT' && opts.catalogPutLostOnce && !failed.has('lost-catalog')) {
      failed.add('lost-catalog');
      const rec = records.get('catalog')!;
      if (body.revision === rec.revision) records.set('catalog', {value: body.value, revision: rec.revision + 1});
      return route.abort('timedout');
    }

    let status = 200, data: any = {};

    const headers: Record<string, string> = {'Access-Control-Expose-Headers': 'X-Citely-Account'};
    const seq = opts.readySequence || [200];
    // A cold replica does not answer at all; the platform returns 503 until it does.
    if (path === '/health' || path === '/ready') {
      status = seq[Math.min(readyCalls++, seq.length - 1)];
      log[log.length - 1].status = status;
      data = status === 200 ? {status: 'ok', ready: true, readiness: 'ready'} : {detail: 'Service unavailable'};
    }
    else if (path === '/warmup') data = {status: 'warming'};
    else if (path === '/auth/login') {
      loginCalls++;
      if (loginCalls <= (opts.loginFailures || 0)) { status = 503; data = {detail: 'Service unavailable'}; }
      else data = challengeOr(body?.email, body?.trusted_browser ? [body.trusted_browser] : []);
    }
    else if (path === '/auth/signup') { status = opts.signupStatus || 201; data = status < 300 ? {detail: 'Verification code sent'} : {detail: 'Service unavailable'}; }
    else if (path === '/auth/google/callback' || path === '/auth/github/callback')
      data = challengeOr('oauth@example.com', body?.trusted_browsers || []);
    else if (path === '/auth/login-code') {
      if (body?.code !== '123456') { status = 400; data = {detail: "That code isn't right. Check the email and try again."}; }
      else data = signedInAs(body?.ticket === 'ticket-oauth' ? 'oauth@example.com' : 'test@example.com', body?.trust_browser ? {trusted_browser: TRUSTED} : {});
    }
    else if (path === '/auth/login-code/resend') data = {ticket: 'ticket-2', sent_to: 't••••@example.com'};
    else if (path === '/me') data = {id: 'u1', email: 'test@example.com', status: account.status, is_admin: false};
    else if (path === '/me/trusted-browsers' && method === 'GET') data = {items: account.trusted};
    else if (path.startsWith('/me/trusted-browsers/') && method === 'DELETE') { account.trusted = account.trusted.filter(b => b.id !== path.split('/').pop()); data = {removed: true}; }
    else if (path === '/me/sign-out-everywhere') { account.signedOutEverywhere++; account.trusted = []; data = {signed_out: true}; }
    else if (opts.account?.blocked && (path.startsWith('/state/') || path === '/documents')) {
      status = 403; data = {detail: 'Blocked'}; headers['X-Citely-Account'] = opts.account.blocked;
    }
    else if (path === '/documents') data = docs;
    else if (path.endsWith('/pages')) { const id = path.split('/')[2]; data = [{page: 1, text: `Page text of ${id}.`, extraction_version: 'v1'}]; }
    else if (path.endsWith('/history')) data = [];
    else if (path.startsWith('/state/')) {
      const key = path.slice(7), rec = records.get(key) || {value: null, revision: 0};
      if (method === 'PUT') {
        if (body.revision !== rec.revision) { status = 409; data = {detail: 'conflict'}; }
        else { records.set(key, {value: body.value, revision: rec.revision + 1}); data = {revision: rec.revision + 1, updated: 'now'}; }
      } else if (method === 'DELETE') { records.delete(key); data = {deleted: true}; }
      else data = rec;
    }
    else if (path.endsWith('/annotations')) data = [];
    else if (path.endsWith('/notes/versions')) data = [];
    else if (path.endsWith('/notes')) {
      const conv = path.split('/')[2];
      if (method === 'PUT') { const n = notes.get(conv) || {content: '', revision: 0}; notes.set(conv, {content: body.content, revision: n.revision + 1}); data = {conversation_id: conv, ...notes.get(conv)}; }
      else data = {conversation_id: conv, workspace_id: 'org', ...(notes.get(conv) || {content: '', revision: 0})};
    }
    else if (path === '/me/presence') { presence.push(req.postDataJSON()); return route.fulfill({status: 204, headers}); }
    else if (path === '/me/usage') {
      if (opts.usage) data = opts.usage; else { status = 404; data = {detail: 'Not found'}; }
    }
    else if ((path === '/query' || path === '/query/stream') && opts.queryLimit) {
      return route.fulfill({status: 429, contentType: 'application/json', headers: {'X-Citely-Limit': opts.queryLimit.header, 'Access-Control-Expose-Headers': 'X-Citely-Limit'}, body: JSON.stringify({detail: opts.queryLimit.message})});
    }
    else if (path === '/query' || path === '/query/stream') {
      if (opts.queryDelayMs) await new Promise(r => setTimeout(r, opts.queryDelayMs));
      data = {request_id: 'q', answer: opts.answer ?? 'ANSWER FOR ' + body.document_id, sources: [], model: 'm', collection_name: 'c'};
      if (path === '/query/stream') {
        // The whole stream at once (a route can't send it in pieces): the
        // answer so far, then the final answer, one JSON object per line.
        const lines = [{type: 'delta', text: data.answer.split('\n')[0]}, {type: 'done', response: data}];
        return route.fulfill({status: 200, contentType: 'application/x-ndjson', headers, body: lines.map(l => JSON.stringify(l)).join('\n') + '\n'});
      }
    }
    else { status = 404; data = {detail: 'Unexpected mock path ' + path}; }
    await route.fulfill({status, contentType: 'application/json', headers, body: JSON.stringify(data)});
  });
  /** Each tab's latest state, as the server keeps it (later seq wins; signed out is final). */
  const tabs = () => {
    const out = new Map<string, {state: string; seq: number; browser: string}>();
    for (const p of presence) {
      if (p.state === 'signed_out') { for (const [k, t] of out) if (t.browser === p.browser) out.set(k, {...t, state: 'signed_out'}); continue; }
      const t = out.get(p.tab);
      if (!t || (t.state !== 'signed_out' && p.seq > t.seq)) out.set(p.tab, {state: p.state, seq: p.seq, browser: p.browser});
    }
    return out;
  };
  const online = () => [...tabs().values()].some(t => t.state === 'active');
  return {log, records, notes, ingested, presence, tabs, online, account};
}

export async function signedIn(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('rag.jwt', 'e30.' + btoa(JSON.stringify({exp: 9999999999})) + '.test');
    localStorage.setItem('rag.user', JSON.stringify({id: 'test-owner', email: 'test@example.com', privacyPolicyAccepted: true}));
  });
}

/** Survives in-page navigation, vanishes on a real page load. */
export async function markDocument(page: Page) {
  await page.evaluate(() => { (window as any).__sameDocument = true; });
}
export const isSameDocument = (page: Page) => page.evaluate(() => (window as any).__sameDocument === true);
