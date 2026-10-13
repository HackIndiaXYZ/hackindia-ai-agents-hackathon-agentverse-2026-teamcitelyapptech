import {test, expect, Page} from '@playwright/test';

/** The admin console at /admin/ (admin.citely.example is the same page as its
 *  home). Without NEXT_PUBLIC_ADMIN_ENVS it manages this build's own API, so
 *  one environment, "This site". A stateful mock of the /admin API. */

const ADMIN = 'admin@citely.example';
const token = () => 'e30.' + Buffer.from(JSON.stringify({exp: 9999999999})).toString('base64') + '.t';
const day = (back: number) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);

type Opts = {overviewStatus?: number; vectorsError?: boolean; traffic?: 'ok' | 'missing' | 'refused'; uptime?: boolean; healthDown?: boolean; overviewDelayMs?: () => number;
  notices?: 'ok' | 'failed' | 'absent'; testNotice?: 'sent' | 'failed' | 'refused'};

async function adminApi(page: Page, opts: Opts = {}) {
  const users: any[] = [
    {id: 'u-admin', email: ADMIN, status: 'approved', created_at: '2026-09-01T10:00:00Z', last_seen_at: new Date().toISOString(), documents: 0, questions: 0, providers: [], has_password: true, is_admin: true, online: true, presence: 'online'},
    {id: 'u-pend', email: 'waiting@example.org', status: 'pending', created_at: '2026-10-09T10:00:00Z', last_seen_at: null, documents: 0, questions: 0, providers: ['google'], has_password: false, is_admin: false, online: false, presence: null},
    {id: 'u-mem', email: 'member@example.org', status: 'approved', created_at: '2026-09-20T10:00:00Z', last_seen_at: '2026-10-08T10:00:00Z', documents: 3, questions: 12, providers: [], has_password: true, is_admin: false, online: false, presence: 'offline'},
  ];
  const log: {method: string; path: string; query: string; body?: any}[] = [];
  const LIMIT_DEFAULTS = {enabled: true, uploads: 3, questions: 5, period: 'total', daily_uploads: 3, daily_questions: 10, max_upload_mb: 10, max_pages: 200};
  let limits: any = LIMIT_DEFAULTS;
  const usageOf: Record<string, Record<string, number>> = {'u-mem': {upload: 2, question: 4}, 'u-pend': {}, 'u-admin': {}};
  const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();
  const notified: any[] = opts.notices === 'failed' ? [
    {id: 31, at: ago(30), type: 'admin.notified', email: 'new.person@work.example', country: null, timezone: null, detail: {kind: 'new account', outcome: 'failed', reason: 'RuntimeError: status Failed: EmailDroppedAllRecipientsSuppressed', message_id: 'm2'}},
    {id: 30, at: ago(600), type: 'admin.notified', email: 'asha@example.org', country: null, timezone: null, detail: {kind: 'demo request', outcome: 'sent', message_id: 'm1'}}]
    : [{id: 30, at: ago(600), type: 'admin.notified', email: 'asha@example.org', country: null, timezone: null, detail: {kind: 'demo request', outcome: 'sent', message_id: 'm1'}}];
  let testReads = 0;
  const perDay = Array.from({length: 14}, (_, i) => ({day: day(13 - i), uploads: i % 3, questions: i, signups: i === 13 ? 2 : 0, requests: 40 + i, errors: i === 12 ? 1 : 0}));
  await page.route(/127\.0\.0\.1:8000/, async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname, method = req.method();
    let body: any; try { body = req.postDataJSON(); } catch { body = undefined; }
    log.push({method, path, query: url.search, body});
    const json = (status: number, data: any) => route.fulfill({status, contentType: 'application/json', headers: {'access-control-allow-origin': '*'}, body: JSON.stringify(data)});
    const signedIn = (req.headers()['authorization'] || '').startsWith('Bearer ');
    if (path === '/auth/login') {
      if (body.password !== 'Velvet-Harbor-73x') return json(401, {detail: 'Incorrect email or password.'});
      return json(200, {access_token: null, email: body.email, code_required: true, ticket: 't1', sent_to: 'a••••@citely.example', status: 'approved'});
    }
    if (path === '/auth/google/callback') {
      await new Promise(r => setTimeout(r, 1500));     // Google's exchange plus sending the code
      return json(200, {access_token: null, email: ADMIN, code_required: true, ticket: 't-google', sent_to: 'a••••@citely.example', status: 'approved'});
    }
    if (path === '/auth/login-code') {
      if (body.code !== '123456') return json(400, {detail: "That code isn't right."});
      return json(200, {access_token: token(), email: ADMIN, status: 'approved', trusted_browser: body.trust_browser ? 'trusted-admin' : null});
    }
    if (path === '/health') return opts.healthDown ? json(503, {detail: 'Service unavailable'}) : json(200, {status: 'ok'});
    if (!path.startsWith('/admin/')) return json(404, {detail: 'Not Found'});
    if (!signedIn) return json(401, {detail: 'Not authenticated'});
    if (path === '/admin/limits') {
      if (method === 'PUT') { limits = body; return json(200, {limits, defaults: LIMIT_DEFAULTS, saved: true, max_upload_mb_cap: 50}); }
      return json(200, {limits, defaults: LIMIT_DEFAULTS, saved: limits !== LIMIT_DEFAULTS, max_upload_mb_cap: 50});
    }
    if (path === '/admin/overview') {
      const wait = opts.overviewDelayMs?.() || 0;
      if (wait) await new Promise(r => setTimeout(r, wait));
      if (opts.overviewStatus) return json(opts.overviewStatus, {detail: opts.overviewStatus === 403 ? 'Admin only.' : 'Not Found'});
      const by = (s: string) => users.filter(u => u.status === s).length;
      return json(200, {environment: {name: 'local'}, users: {total: users.length, members: users.filter(u => ['approved', 'suspended'].includes(u.status)).length, by_status: {approved: by('approved'), pending: by('pending'), declined: by('declined'), suspended: by('suspended')},
        new_24h: 1, new_7d: 2, online_now: users.filter(u => u.presence === 'online').length, active_24h: 2, documents: 3, questions: 12, demo_requests_pending: 1, demo_requests_total: 1},
        per_day: perDay, limits: {enabled: limits.enabled, period: limits.period, uploads_per_account: limits.uploads, questions_per_account: limits.questions, uploads_per_day: 200, questions_per_day: 1000, max_upload_mb: 50, max_pages: 300},
        usage_today: {upload: 1, question: 13}});
    }
    if (path === '/admin/users') {
      const q = url.searchParams.get('query') || '', s = url.searchParams.get('status') || '';
      const items = users.filter(u => u.email.includes(q) && (!s || u.status === s || (s === 'members' && ['approved', 'suspended'].includes(u.status))));
      return json(200, {total: items.length, items});
    }
    const m = path.match(/^\/admin\/users\/([^/]+)(?:\/(status|delete|revoke-browsers|password-reset|reset-usage))?$/);
    if (m) {
      const u = users.find(x => x.id === m[1]);
      if (!u) return json(404, {detail: 'User not found.'});
      if (m[2] === 'status') {
        u.status = ({approve: 'approved', decline: 'declined', suspend: 'suspended', unsuspend: 'approved'} as any)[body.action];
        u.presence = u.status === 'approved' ? (u.presence || 'offline') : u.status === 'suspended' ? 'offline' : null;   // as the server does
        return json(200, {id: u.id, status: u.status});
      }
      if (m[2] === 'delete') {
        if (body.confirm !== u.email) return json(400, {detail: "Type the account's email address to confirm."});
        users.splice(users.indexOf(u), 1);
        return json(200, {id: u.id, deleted: true, documents: 3});
      }
      if (m[2] === 'revoke-browsers') return json(200, {id: u.id, removed: 1});
      if (m[2] === 'password-reset') return json(200, {id: u.id, sent_to: u.email});
      if (m[2] === 'reset-usage') { const cleared = {total: {...usageOf[u.id]}, today: {upload: 1, question: 2}}; usageOf[u.id] = {}; return json(200, {id: u.id, email: u.email, cleared, shared: {question: {used: 7, limit: 10, left: 3}, upload: {used: 0, limit: 3, left: 3}}}); }
      return json(200, {user: {...u, status_reason: null}, providers: u.providers, documents: [{id: 'd1', filename: 'Annual report.pdf', pages: 12, ingested_at: '2026-10-01T09:00:00Z'}],
        questions: u.questions, highlights: 2, notes: 1, storage_bytes: 2_400_000,
        usage: {total: usageOf[u.id] || {}, today: Object.keys(usageOf[u.id] || {}).length ? {upload: 1, question: 2} : {}},
        trusted_browsers: [{id: 'b1', label: 'Chrome on macOS', expires_at: '2026-11-01T00:00:00Z'}],
        events: [{id: 9, at: '2026-10-08T10:00:00Z', type: 'auth.login', email: u.email, country: 'IN', timezone: 'Asia/Kolkata', detail: {method: 'password'}}]});
    }
    if (path === '/admin/notifications/test' && method === 'POST') {
      if (opts.testNotice === 'refused') return json(502, {detail: 'Refused by the email service: RuntimeError: DomainNotLinked'});
      return json(202, {test_id: 'tst1', state: 'accepted', recipient: 'a••••@citely.example'});
    }
    if (path === '/admin/notifications') {
      if (opts.notices === 'absent') return json(404, {detail: 'Not Found'});
      const failed = notified.filter(e => e.detail.outcome === 'failed');
      const data: any = {recipient: 'a••••@citely.example', sender: 'hello@citely.example', recent: notified, days: 7, failed: failed.length,
        last_failed: failed[0] || null, last_sent: notified.find(e => e.detail.outcome === 'sent') || null};
      if (url.searchParams.get('test_id')) {
        // The email service confirms on the second look.
        if (++testReads < 2) data.test = null;
        else {
          data.test = {id: 40, at: new Date().toISOString(), type: 'admin.notified', email: null, detail: opts.testNotice === 'failed'
            ? {kind: 'test', outcome: 'failed', reason: 'RuntimeError: status Failed: EmailDroppedAllRecipientsSuppressed', test_id: 'tst1'}
            : {kind: 'test', outcome: 'sent', message_id: 'm3', test_id: 'tst1'}};
          if (!notified.some(e => e.id === 40)) notified.unshift(data.test);
          data.recent = notified;
        }
      }
      return json(200, data);
    }
    if (path === '/admin/events' && url.searchParams.get('type') === 'admin.notified') return json(200, {items: notified});
    if (path === '/admin/events') return json(200, {items: [
      {id: 2, at: new Date().toISOString(), type: 'upload', email: 'member@example.org', country: 'IN', timezone: 'Asia/Kolkata', detail: {kind: 'pdf', pages: 12}},
      {id: 1, at: new Date().toISOString(), type: 'auth.login', email: 'member@example.org', country: 'DE', timezone: 'Europe/Berlin', detail: null}]});
    if (path === '/admin/demo-requests') return json(200, {items: [{id: 'r1', at: '2026-10-09T08:00:00Z', name: 'Asha', email: 'asha@example.org', phone: '+91 90000 00000', comment: 'For our research group.', status: 'pending'}]});
    if (path === '/admin/demo-requests/r1/approve') return json(200, {email: 'asha@example.org', approved: true});
    if (path === '/admin/database') return json(200, {database: {engine: 'SQLite', bytes: 1_200_000, modified_at: new Date().toISOString(), tables: {users: 3, documents: 3, events: 40}},
      storage: {areas: {originals: {bytes: 9_000_000, files: 3}}, disk: {total_bytes: 100e9, used_bytes: 1e9, free_bytes: 99e9}},
      vectors: opts.vectorsError ? {collection: 'chunks_dev', status: 'error', error: 'ResponseHandlingException: connection refused'} : {collection: 'chunks_dev', status: 'green', points: 420}});
    if (path === '/admin/server') return json(200, {status: 'up', readiness: 'ready', dependencies: {qdrant: {state: 'up'}}, started_at: new Date().toISOString(), uptime_seconds: 3700,
      version: 'abc1234', commit: 'abc1234def', revision: 'rag-api-staging--r1', cold_starts_7d: 4, cold_starts_24h: 1, average_startup_ms: 9500,
      requests_since_start: {requests: 120, errors: 0}, errors_24h: 1, country_lookup: {loaded: true}, python: '3.11.9', memory_peak_mb: 812});
    if (path === '/admin/uptime') {
      if (!opts.uptime) return json(200, {configured: false, monitors: []});
      const daily = Array.from({length: 30}, (_, i) => ({day: day(29 - i), uptime: i < 27 ? null : i === 28 ? 98.2 : 100}));
      return json(200, {configured: true, days: 30, monitors: [
        {id: 1, name: 'Citely website (prod)', url: 'https://citely.example/', kind: 'website', status: 'up', interval_s: 3600, uptime_7d: 99.4, uptime_30d: 99.4,
         last_check_at: new Date(Date.now() - 12 * 60000).toISOString(), last_response_ms: 87, daily,
         incidents: [{started_at: new Date(Date.now() - 86400000).toISOString(), duration_s: 420, reason: 'Connection Timeout'}]},
        {id: 2, name: 'Citely API (prod)', url: 'https://rag-api.example/health', kind: 'api', status: 'up', interval_s: 86400, uptime_7d: 100, uptime_30d: 100,
         last_check_at: new Date(Date.now() - 9 * 3600000).toISOString(), last_response_ms: 29370, daily: daily.map(d => ({...d, uptime: d.uptime == null ? null : 100})), incidents: []}]});
    }
    if (path === '/admin/uptime/check') return json(200, {checked_at: new Date().toISOString(), api: {ok: true, uptime_seconds: 4000}, website: {url: 'https://citely.example/', ok: true, status_code: 200, ms: 313, error: null}});
    if (path === '/admin/traffic') {
      if (opts.traffic === 'missing') return json(200, {configured: false, missing: ['CLOUDFLARE_ANALYTICS_TOKEN'], host: 'dev.citely.example', days: 14});
      if (opts.traffic === 'refused') return json(502, {detail: 'Cloudflare refused the analytics query: not authorized for that account'});
      const days = Number(url.searchParams.get('days'));
      return json(200, {configured: true, missing: [], host: 'dev.citely.example', days, totals: {views: 60, visits: 40},
        per_day: Array.from({length: days}, (_, i) => ({day: day(days - 1 - i), views: i === days - 1 ? 30 : i % 4, visits: i === days - 1 ? 20 : i % 3})),
        pages: [{name: '/', views: 30, share: 0.5}, {name: '/documentation/', views: 30, share: 0.5}],
        countries: [{name: 'IN', views: 50, share: 0.83}, {name: 'US', views: 10, share: 0.17}],
        referrers: [{name: 'Direct (typed, bookmark or app)', views: 40, share: 0.67}, {name: 'www.google.com', views: 20, share: 0.33}],
        devices: [{name: 'Desktop', views: 45, share: 0.75}, {name: 'Mobile', views: 15, share: 0.25}],
        browsers: [{name: 'Chrome', views: 60, share: 1}]});
    }
    if (path === '/admin/samples') return json(200, {items: [{id: 's1', name: 'Annual report', filename: 'annual.pdf', kind: 'PDF', bytes: 300000}]});
    return json(404, {detail: 'Not Found'});
  });
  return {log, users};
}

async function signIn(page: Page) {
  await page.getByLabel('Email').fill(ADMIN);
  await page.getByLabel('Password').fill('Velvet-Harbor-73x');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Check your inbox.'})).toBeVisible();
  await page.getByLabel('Sign-in code').fill('123456');
  await page.getByRole('button', {name: 'Verify and continue'}).click();
}
const tile = (page: Page, label: string) => page.locator('.adm-tile').filter({has: page.locator('.adm-label', {hasText: new RegExp(`^${label}$`)})});
const sections = (page: Page) => page.getByRole('navigation', {name: 'Sections'});
const signedIn = (page: Page) => page.addInitScript(t => { localStorage.setItem('citely.admin.this.token', t); localStorage.setItem('citely.admin.this.email', 'admin@citely.example'); }, token());

test('signs in with the emailed code, keeps this browser trusted, and shows the overview', async ({page}) => {
  const api = await adminApi(page);
  await page.goto('admin/');
  await expect(page.locator('.marketing-header, .site-header')).toHaveCount(0);   // the console has its own header
  await expect(page.getByRole('heading', {name: 'Sign in to This site.'})).toBeVisible();
  await page.getByLabel('Email').fill(ADMIN);
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.locator('.adm-signin [role=alert]')).toHaveText('Incorrect email or password.');
  await signIn(page);
  await expect(page.getByRole('heading', {name: 'Overview'})).toBeVisible();
  expect(api.log.find(r => r.path === '/auth/login-code')!.body).toMatchObject({trust_browser: true, browser_label: 'Admin console'});
  expect(await page.evaluate(() => localStorage.getItem('citely.admin.this.trusted'))).toBe('trusted-admin');
  await expect(page.locator('.adm-tile').filter({hasText: 'PENDING REVIEW'})).toContainText('1');
  await expect(page.locator('.adm-chart')).toHaveCount(4);
  // Hovering a bar reads out that day; every chart also has a table for screen readers.
  const questions = page.locator('.adm-chart').filter({hasText: 'QUESTIONS'});
  await questions.locator('svg g').nth(5).hover();
  await expect(questions.locator('.adm-chart-read')).toContainText(': 5');
  await expect(questions.locator('table.sr-only tr')).toHaveCount(14);
  // Only the admin sign-in and API were called, plus one health read on opening that starts
  // waking a sleeping server while the password is typed (no session reads, no polling).
  expect(api.log.filter(r => !r.path.startsWith('/admin/') && !r.path.startsWith('/auth/login')).map(r => r.path)).toEqual(['/health']);
  expect(api.log[0].path).toBe('/health');
  // The place is kept across reloads.
  await sections(page).getByRole('button', {name: 'Server'}).click();
  await expect(page).toHaveURL(/#this\/server$/);
  await page.reload();
  await expect(page.getByRole('heading', {name: 'Server'})).toBeVisible();
  await page.goto('admin/#this/activity');                              // same page, new address
  await expect(page.getByRole('heading', {name: 'Activity'})).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', {name: 'Server'})).toBeVisible();
  await expect(page.locator('.adm-tile').filter({hasText: 'COLD STARTS'})).toContainText('4 in 7 days');
});

test('approving and declining from Pending review', async ({page}) => {
  const api = await adminApi(page);
  await signedIn(page);
  await page.goto('admin/#this/pending');
  const row = page.getByRole('row').filter({hasText: 'waiting@example.org'});
  await row.getByRole('button', {name: 'Approve'}).click();
  await expect(page.locator('.adm-note')).toHaveText('waiting@example.org approved and emailed.');
  await expect(page.getByText('Nobody is waiting for review.')).toBeVisible();
  expect(api.log.find(r => r.path === '/admin/users/u-pend/status')!.body).toEqual({action: 'approve'});
});

test('an approved account: revoke browsers, send a reset link, suspend with a reason, delete only with the email typed', async ({page}) => {
  const api = await adminApi(page);
  await signedIn(page);
  await page.goto('admin/#this/users');
  await page.getByRole('button', {name: 'member@example.org'}).click();
  const drawer = page.getByRole('complementary', {name: 'Account member@example.org'});
  await expect(drawer).toContainText('Annual report.pdf');
  await expect(drawer).toContainText('Chrome on macOS');
  await expect(drawer).toContainText('Signed in');
  await drawer.getByRole('button', {name: 'Revoke trusted browsers'}).click();
  await expect(drawer.locator('.adm-note')).toHaveText('Trusted browsers revoked.');
  page.once('dialog', d => d.accept());
  await drawer.getByRole('button', {name: 'Send password reset link'}).click();
  await expect(drawer.locator('.adm-note')).toHaveText('Reset link sent to member@example.org.');
  expect(api.log.some(r => r.path === '/admin/users/u-mem/password-reset' && r.method === 'POST')).toBe(true);
  page.once('dialog', d => d.accept('Spam uploads'));
  await drawer.getByRole('button', {name: 'Suspend'}).click();
  await expect(drawer.locator('.adm-note')).toContainText('Suspended');
  expect(api.log.find(r => r.path === '/admin/users/u-mem/status')!.body).toEqual({action: 'suspend', reason: 'Spam uploads'});
  await expect(drawer.getByRole('button', {name: 'Unsuspend'})).toBeVisible();
  for (const gone of ['Suspend', 'Send password reset link', 'Revoke trusted browsers', 'Approve'])
    await expect(drawer.getByRole('button', {name: gone, exact: true})).toHaveCount(0);   // only what fits a suspended account
  page.once('dialog', d => d.accept('someone-else@example.org'));
  await drawer.getByRole('button', {name: 'Delete account'}).click();
  await expect(drawer.locator('.adm-note')).toHaveText("Type the account's email address to confirm.");
  page.once('dialog', d => d.accept('member@example.org'));
  await drawer.getByRole('button', {name: 'Delete account'}).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('row').filter({hasText: 'member@example.org'})).toHaveCount(0);
  // The admin account itself has no actions.
  await page.getByRole('button', {name: ADMIN}).click();
  await expect(page.getByRole('complementary')).toContainText("This is the admin account; it can't be changed here.");
  await expect(page.getByRole('complementary').getByRole('button', {name: 'Suspend'})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary')).toHaveCount(0);
});

test('declining leaves only Approve and Delete; declined accounts stay out of Members and show no online status', async ({page}) => {
  await adminApi(page);
  await signedIn(page);
  await page.goto('admin/#this/pending');
  await page.getByRole('button', {name: 'waiting@example.org'}).click();
  const drawer = page.getByRole('complementary', {name: 'Account waiting@example.org'});
  await drawer.getByRole('button', {name: 'Decline'}).click();
  await expect(drawer.locator('.adm-note')).toHaveText("Declined. They've been sent a polite note.");
  await expect(drawer.locator('.adm-actions button')).toHaveText(['Approve', 'Delete account']);
  await page.keyboard.press('Escape');
  await sections(page).getByRole('button', {name: 'Users'}).click();
  await expect(page.getByRole('row').filter({hasText: 'member@example.org'})).toBeVisible();
  await expect(page.getByRole('row').filter({hasText: 'waiting@example.org'})).toHaveCount(0);    // not a member
  await page.getByRole('button', {name: 'Declined'}).click();
  const declined = page.getByRole('row').filter({hasText: 'waiting@example.org'});
  await expect(declined).toContainText('declined');
  await expect(declined.locator('td').nth(3)).toHaveText('—');                                    // no "online"/"last seen"
});

test('presence: Online, Away and Last seen, in the list and the drawer, refreshed every 30 s while the console is in use', async ({page}) => {
  await page.clock.install();
  const api = await adminApi(page);
  await signedIn(page);
  await page.goto('admin/#this/users');
  const cell = (email: string) => page.getByRole('row').filter({hasText: email}).locator('td').nth(3);
  await expect(page.getByRole('columnheader', {name: 'Presence'})).toBeVisible();
  await expect(cell(ADMIN)).toHaveText('Online');
  await expect(cell('member@example.org')).toHaveText(/^Last seen \d+ d ago$/);
  // The member opens the workspace, then switches to another tab.
  const member = api.users.find(u => u.email === 'member@example.org');
  Object.assign(member, {presence: 'away', online: false, last_seen_at: new Date(Date.now() - 3 * 60000).toISOString()});
  const lists = () => api.log.filter(r => r.path === '/admin/users').length;
  const before = lists();
  await page.mouse.move(300, 300);
  await page.clock.runFor(31_000);
  await expect.poll(lists).toBeGreaterThan(before);
  await expect(cell('member@example.org')).toHaveText('Away · 3 min ago');
  // The drawer says the same, and refreshes too.
  await page.getByRole('button', {name: 'member@example.org'}).click();
  const drawer = page.getByRole('complementary', {name: 'Account member@example.org'});
  await expect(drawer.locator('.adm-facts dd').nth(1)).toHaveText('Away · 3 min ago');
  Object.assign(member, {presence: 'online', online: true, last_seen_at: new Date().toISOString()});
  await page.mouse.move(320, 320);
  await page.clock.runFor(31_000);
  await expect(drawer.locator('.adm-facts dd').nth(1)).toHaveText('Online');
  await expect(cell('member@example.org')).toHaveText('Online');
  // Left alone, the console stops asking (and lets the server sleep).
  await page.clock.runFor(11 * 60_000);
  const settled = lists();
  await page.clock.runFor(10 * 60_000);
  expect(lists()).toBe(settled);
});

test('Overview: Online now refreshes every 30 s while the console is visible, and not while hidden', async ({page}) => {
  await page.clock.install();
  const api = await adminApi(page);
  await signedIn(page);
  await page.goto('admin/#this/overview');
  await expect(tile(page, 'ONLINE NOW').locator('strong')).toHaveText('1');
  api.users.find(u => u.email === 'member@example.org').presence = 'online';
  await page.mouse.move(300, 300);
  await page.clock.runFor(31_000);
  await expect(tile(page, 'ONLINE NOW').locator('strong')).toHaveText('2');
  const overviews = () => api.log.filter(r => r.path === '/admin/overview').length;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hidden = overviews();
  await page.clock.runFor(5 * 60_000);
  expect(overviews()).toBe(hidden);
});

test('limits: edit the numbers, one time or every day, and save', async ({page}) => {
  const api = await adminApi(page);
  await signedIn(page);
  await page.goto('admin/#this/limits');
  await expect(page.getByRole('heading', {name: 'Limits'})).toBeVisible();
  const save = page.getByRole('button', {name: 'Save limits'});
  await expect(save).toBeDisabled();                                                               // nothing changed yet
  await page.getByLabel('Uploads', {exact: true}).fill('5');
  await page.getByLabel('Questions', {exact: true}).fill('20');
  await page.getByRole('button', {name: 'Every day'}).click();
  await expect(page.locator('.adm-limits')).toContainText('Per account, each day.');
  await save.click();
  await expect(page.locator('.adm-note')).toHaveText('Saved. The new limits apply straight away.');
  expect(api.log.find(r => r.path === '/admin/limits' && r.method === 'PUT')!.body).toMatchObject({uploads: 5, questions: 20, period: 'daily', enabled: true});
  await sections(page).getByRole('button', {name: 'Overview'}).click();
  await expect(page.locator('.adm-card').filter({hasText: 'LIMITS'})).toContainText('5 uploads and 20 questions a day');
});

test('switching back to a section shows what it last loaded at once, while it refreshes', async ({page}) => {
  let calls = 0;
  await adminApi(page, {overviewDelayMs: () => (++calls > 2 ? 4000 : 0)});
  await signedIn(page);
  await page.goto('admin/#this/overview');
  await expect(page.locator('.adm-tile').filter({hasText: 'MEMBERS'})).toBeVisible();
  await sections(page).getByRole('button', {name: 'Users'}).click();
  await expect(page.getByRole('heading', {name: 'Users'})).toBeVisible();
  await sections(page).getByRole('button', {name: 'Overview'}).click();
  // The refresh is slow (a waking server), but the overview is there straight away.
  await expect(page.locator('.adm-tile').filter({hasText: 'MEMBERS'})).toBeVisible({timeout: 1000});
});

test('activity filters, demo requests, and an unreachable vector store shown as such', async ({page}) => {
  const api = await adminApi(page, {vectorsError: true});
  await signedIn(page);
  await page.goto('admin/#this/activity');
  await expect(page.locator('.adm-event')).toHaveCount(2);
  await expect(page.locator('.adm-event').first()).toContainText('kind: pdf · pages: 12');
  await page.getByRole('button', {name: 'Sign-ins'}).click();
  await expect.poll(() => api.log.filter(r => r.path === '/admin/events').at(-1)!.query).toContain('type=auth.login%2Cauth.login_failed%2Cauth.login_blocked');
  await sections(page).getByRole('button', {name: 'Demo requests'}).click();
  await page.locator('.adm-card').filter({hasText: 'Asha'}).getByRole('button', {name: 'Approve'}).click();
  await expect(page.locator('.adm-note')).toHaveText('asha@example.org approved and emailed.');
  await sections(page).getByRole('button', {name: 'Database'}).click();
  await expect(page.locator('.adm-tile').filter({hasText: 'VECTORS'})).toContainText('connection refused');
});

test("someone who isn't the admin, and an environment without the admin features yet", async ({page}) => {
  await adminApi(page, {overviewStatus: 403});
  await signedIn(page);
  await page.goto('admin/');
  await expect(page.locator('.adm-problem[role=alert]')).toContainText("isn't This site's admin");
  await page.getByRole('button', {name: 'Try again'}).click();          // signs out of this environment
  await expect(page.getByRole('heading', {name: 'Sign in to This site.'})).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('citely.admin.this.token'))).toBeNull();
});

test('an environment without the admin API says so', async ({page}) => {
  await adminApi(page, {overviewStatus: 404});
  await signedIn(page);
  await page.goto('admin/');
  await expect(page.locator('.adm-problem')).toContainText("doesn’t have the admin features yet");
});

test('a saved session and theme load without errors or a rebuilt page', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await adminApi(page);
  await signedIn(page);
  await page.addInitScript(() => localStorage.setItem('citely-modernist-mode', 'dark'));
  await page.goto('admin/#this/overview');
  await expect(page.getByRole('heading', {name: 'Overview'})).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(await page.locator('.adm').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(22, 22, 22)');
});

test('fits a phone, in light and dark', async ({page}) => {
  await adminApi(page);
  await signedIn(page);
  await page.setViewportSize({width: 360, height: 780});
  for (const section of ['overview', 'users', 'activity', 'database']) {
    await page.goto('admin/#this/' + section);
    await expect(page.locator('.adm-head h1')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), section).toBeLessThanOrEqual(0);
  }
  await page.getByRole('button', {name: /Switch to dark mode/}).click();
  const bg = await page.locator('.adm').evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(22, 22, 22)');
});

test('the header shows an account initial, not the whole address; its menu signs out', async ({page}) => {
  await adminApi(page);
  await signedIn(page);
  await page.goto('admin/');
  await expect(page.getByRole('heading', {name: 'Overview'})).toBeVisible();
  await expect(page.locator('.adm-top')).not.toContainText(ADMIN);
  const avatar = page.getByRole('button', {name: 'Account for This site'});
  await expect(avatar).toHaveText('A');
  await avatar.click();
  const menu = page.getByRole('menu');
  await expect(menu).toContainText('SIGNED IN TO THIS SITE');
  await expect(menu).toContainText('a••••@citely.example');
  await expect(menu).not.toContainText(ADMIN);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await avatar.click();
  await page.getByRole('menuitem', {name: 'Sign out of This site'}).click();
  await expect(page.getByRole('heading', {name: 'Sign in to This site.'})).toBeVisible();
});

test('back from Google: says it is finishing (no sign-in form), then asks for the code', async ({page}) => {
  const api = await adminApi(page);
  await page.goto('admin/');
  await page.evaluate(() => sessionStorage.setItem('citely.admin.oauth', 'admin:this:abc'));
  await page.goto('admin/?code=google-code&state=admin:this:abc');
  await expect(page.getByRole('heading', {name: 'Finishing Google sign-in…'})).toBeVisible();
  await expect(page.getByLabel('Password')).toHaveCount(0);
  await expect(page.getByRole('heading', {name: 'Check your inbox.'})).toBeVisible();
  expect(api.log.find(r => r.path === '/auth/google/callback')!.body.code).toBe('google-code');
  await expect(page).not.toHaveURL(/code=/);                           // Google's one-time code leaves the address bar
  await page.getByLabel('Sign-in code').fill('123456');
  await page.getByRole('button', {name: 'Verify and continue'}).click();
  await expect(page.getByRole('heading', {name: 'Overview'})).toBeVisible();
});

test('a cancelled Google sign-in says so', async ({page}) => {
  await adminApi(page);
  await page.goto('admin/?error=access_denied&state=admin:this:abc');
  await expect(page.locator('.adm-error')).toHaveText('Google sign-in was cancelled.');
  await expect(page.getByRole('heading', {name: 'Sign in to This site.'})).toBeVisible();
});

test('traffic: visits and page views per day, top lists, and the period', async ({page}) => {
  const api = await adminApi(page, {traffic: 'ok'});
  await signedIn(page);
  await page.goto('admin/#this/traffic');
  await expect(page.getByRole('heading', {name: 'Traffic'})).toBeVisible();
  await expect(tile(page, 'VISITS')).toContainText('40');
  await expect(tile(page, 'PAGE VIEWS')).toContainText('1.5 pages per visit');
  await expect(tile(page, 'TOP COUNTRY')).toContainText('India');
  await expect(page.locator('.adm-chart')).toHaveCount(2);
  const countries = page.locator('.adm-card').filter({hasText: 'COUNTRIES'});
  await expect(countries.locator('li')).toHaveCount(2);
  await expect(countries.locator('li').nth(1)).toContainText('United States');
  await expect(page.locator('.adm-card').filter({hasText: 'WHERE THEY CAME FROM'})).toContainText('www.google.com');
  await page.getByRole('button', {name: '30 days'}).click();
  await expect.poll(() => api.log.filter(r => r.path === '/admin/traffic').at(-1)!.query).toBe('?days=30');
  await expect(page.locator('.adm-chart').first().locator('table.sr-only tr')).toHaveCount(30);
});

test('traffic says what is missing', async ({page}) => {
  await adminApi(page, {traffic: 'missing'});
  await signedIn(page);
  await page.goto('admin/#this/traffic');
  await expect(page.locator('.adm-problem')).toContainText('missing CLOUDFLARE_ANALYTICS_TOKEN');
});

test('traffic shows a Cloudflare refusal with its reason', async ({page}) => {
  await adminApi(page, {traffic: 'refused'});
  await signedIn(page);
  await page.goto('admin/#this/traffic');
  await expect(page.locator('.adm-problem')).toContainText('not authorized for that account');
  await expect(page.getByRole('button', {name: 'Try again'})).toBeVisible();
});

test('uptime: both checks with daily history and problems, and Check now', async ({page}) => {
  const api = await adminApi(page, {uptime: true});
  await signedIn(page);
  await page.goto('admin/#this/server');
  const card = page.getByRole('region', {name: 'Uptime'});
  const site = card.locator('.adm-monitor').filter({hasText: 'Website'}), apiBox = card.locator('.adm-monitor').filter({hasText: 'API'});
  await expect(site).toContainText('99.40% up · checked hourly');
  await expect(site).toContainText('87 ms');
  await expect(site).toContainText('Connection Timeout');
  await expect(apiBox).toContainText('100% up · checked daily');
  await expect(apiBox).toContainText('29.4 s (includes waking the server)');
  await expect(apiBox).toContainText('No problems in 30 days.');
  await expect(site.locator('.adm-days i')).toHaveCount(30);
  await expect(site.locator('.adm-days i.none')).toHaveCount(27);             // before the checks existed: no data, not "up"
  await expect(site.locator('.adm-days i.warn')).toHaveCount(1);
  await card.getByRole('button', {name: 'Check now'}).click();
  const result = card.locator('.adm-check-result');
  await expect(result).toContainText('API answered in');
  await expect(result).toContainText('Website answered in 313 ms (HTTP 200) · checked from the server');
  expect(api.log.some(r => r.path === '/admin/uptime/check' && r.method === 'POST')).toBe(true);
});

test('uptime: Check now says so when the API does not answer', async ({page}) => {
  await adminApi(page, {uptime: true, healthDown: true});
  await signedIn(page);
  await page.goto('admin/#this/server');
  await page.getByRole('button', {name: 'Check now'}).click();
  await expect(page.locator('.adm-check-result')).toContainText("API didn’t answer: Service unavailable");
});

test('uptime: no card where uptime is not set up', async ({page}) => {
  await adminApi(page);
  await signedIn(page);
  await page.goto('admin/#this/server');
  await expect(page.getByRole('heading', {name: 'Server'})).toBeVisible();
  await expect(page.locator('.adm-tile').first()).toBeVisible();
  await expect(page.getByRole('region', {name: 'Uptime'})).toHaveCount(0);   // only prod has uptime checks
});

test('failed admin notifications: a banner on Overview and Pending review, and the list in Activity', async ({page}) => {
  const api = await adminApi(page, {notices: 'failed'});
  await signedIn(page);
  await page.goto('admin/#this/overview');
  const banner = page.locator('.adm-banner');
  await expect(banner).toContainText('1 admin notification failed in the last 7 days.');
  await expect(banner).toContainText('new account for new.person@work.example');
  await expect(banner).toContainText('EmailDroppedAllRecipientsSuppressed');
  await sections(page).getByRole('button', {name: 'Pending review'}).click();
  await expect(page.getByRole('heading', {name: 'Pending review'})).toBeVisible();
  await expect(page.locator('.adm-banner')).toContainText('You may have missed a sign-up or a demo request.');
  await page.locator('.adm-banner').getByRole('button', {name: 'See notifications in Activity'}).click();
  await expect(page.getByRole('heading', {name: 'Activity'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Notifications', exact: true})).toHaveAttribute('aria-pressed', 'true');
  const failed = page.locator('.adm-event').filter({hasText: 'new.person@work.example'});
  await expect(failed).toContainText('Admin notification');
  await expect(failed).toContainText('outcome: failed');
  expect(api.log.some(r => r.path === '/admin/events' && r.query.includes('type=admin.notified'))).toBe(true);
});

// Two tests, each with its own mock from the start: the console keeps working
// in the background (keep-warm, prefetch, live refresh), so swapping the mock
// mid-test could catch a request in flight with no server behind it.
test('no notification banner when they all went out', async ({page}) => {
  await adminApi(page, {notices: 'ok'});
  await signedIn(page);
  await page.goto('admin/#this/overview');
  await expect(page.locator('.adm-tile').first()).toBeVisible();
  await expect(page.locator('.adm-banner')).toHaveCount(0);
  await expect(page.locator('.adm-error')).toHaveCount(0);
});

test('no notification banner or error on a server without the feature', async ({page}) => {
  await adminApi(page, {notices: 'absent'});
  await signedIn(page);
  await page.goto('admin/#this/overview');
  await expect(page.locator('.adm-tile').first()).toBeVisible();
  await expect(page.locator('.adm-banner')).toHaveCount(0);
  await expect(page.locator('.adm-error')).toHaveCount(0);
});

test('the Server page leaves out the Notifications card on a server without the feature, instead of an error', async ({page}) => {
  await adminApi(page, {notices: 'absent'});
  await signedIn(page);
  await page.goto('admin/#this/server');
  await expect(page.getByRole('heading', {name: 'Server'})).toBeVisible();
  await expect(page.locator('.adm-tile').first()).toBeVisible();
  await expect(page.getByRole('button', {name: 'Send test notification'})).toHaveCount(0);
  await expect(page.locator('.adm-problem')).toHaveCount(0);
  await expect(page.getByText('Not Found')).toHaveCount(0);
});

test('Server: Send test notification shows the masked address, accepted, then sent', async ({page}) => {
  const api = await adminApi(page);
  await signedIn(page);
  await page.goto('admin/#this/server');
  const card = page.getByRole('region', {name: 'Notifications'});
  await expect(card).toContainText('emailed to a••••@citely.example from hello@citely.example');
  await expect(card).not.toContainText(ADMIN);
  await expect(card.locator('.adm-list li')).toContainText(['Demo request · asha@example.org']);
  await card.getByRole('button', {name: 'Send test notification'}).click();
  await expect(card.getByRole('status')).toContainText('Accepted by the email service');
  await expect(card.getByRole('status')).toContainText('Sent to a••••@citely.example', {timeout: 10_000});
  await expect(card.getByRole('status')).toContainText('Spam folder');
  await expect(card.locator('.adm-list li').first()).toContainText('Test');
  expect(api.log.filter(r => r.path === '/admin/notifications/test' && r.method === 'POST')).toHaveLength(1);
  expect(api.log.some(r => r.path === '/admin/notifications' && r.query === '?test_id=tst1')).toBe(true);
});

test('Server: a test notification that fails later says why', async ({page}) => {
  await adminApi(page, {testNotice: 'failed'});
  await signedIn(page);
  await page.goto('admin/#this/server');
  const card = page.getByRole('region', {name: 'Notifications'});
  await card.getByRole('button', {name: 'Send test notification'}).click();
  await expect(card.getByRole('status')).toContainText('Not sent: RuntimeError: status Failed: EmailDroppedAllRecipientsSuppressed', {timeout: 10_000});
});

test('Server: a test notification the email service refuses says why', async ({page}) => {
  await adminApi(page, {testNotice: 'refused'});
  await signedIn(page);
  await page.goto('admin/#this/server');
  const card = page.getByRole('region', {name: 'Notifications'});
  await card.getByRole('button', {name: 'Send test notification'}).click();
  await expect(card.getByRole('status')).toContainText('Not sent: Refused by the email service: RuntimeError: DomainNotLinked');
});

test("an account's panel shows what it has used, and Reset limits gives it back", async ({page}) => {
  const api = await adminApi(page);
  await signedIn(page);
  await page.goto('admin/#this/users');
  await page.getByRole('button', {name: 'member@example.org'}).click();
  const drawer = page.getByRole('complementary', {name: 'Account member@example.org'});
  await expect(drawer).toContainText('2 in total · 1 today');            // uploads
  await expect(drawer).toContainText('4 in total · 2 today');            // questions
  page.once('dialog', d => d.accept());
  await drawer.getByRole('button', {name: 'Reset limits'}).click();
  await expect(drawer.locator('.adm-note')).toContainText('Limits reset: their uploads and questions are back.');
  await expect(drawer.locator('.adm-note')).toContainText("shared daily limit only leaves 3 questions for everyone");
  expect(api.log.some(r => r.path === '/admin/users/u-mem/reset-usage' && r.method === 'POST')).toBe(true);
  await expect(drawer).toContainText('0 in total');
});

test('Limits: reset one account by email', async ({page}) => {
  const api = await adminApi(page);
  await signedIn(page);
  await page.goto('admin/#this/limits');
  const card = page.getByRole('region', {name: 'Reset one account'});
  await card.getByLabel('Email address of the account to reset').fill('nobody@example.org');
  await card.getByRole('button', {name: 'Reset their limits'}).click();
  await expect(card.locator('.adm-note').first()).toHaveText('No account with the address nobody@example.org.');
  await card.getByLabel('Email address of the account to reset').fill(ADMIN);
  await card.getByRole('button', {name: 'Reset their limits'}).click();
  await expect(card.locator('.adm-note').first()).toHaveText('The admin account has no limits to reset.');
  expect(api.log.filter(r => r.path.endsWith('/reset-usage'))).toHaveLength(0);
  page.once('dialog', d => d.accept());
  await card.getByLabel('Email address of the account to reset').fill('Member@Example.org');
  await card.getByRole('button', {name: 'Reset their limits'}).click();
  await expect(card.locator('.adm-note').first()).toContainText('Reset for member@example.org: 2 uploads and 4 questions given back.');
  expect(api.log.filter(r => r.path === '/admin/users/u-mem/reset-usage')).toHaveLength(1);
});

test("Limits: clear today's shared count", async ({page}) => {
  const api = await adminApi(page);
  await page.route(/\/admin\/limits\/reset-today$/, route => route.fulfill({status: 200, contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'},
    body: JSON.stringify({cleared: {question: 7, upload: 1}, shared: {question: {used: 0, limit: 10, left: 10}, upload: {used: 0, limit: 3, left: 3}}})}));
  await signedIn(page);
  await page.goto('admin/#this/limits');
  const card = page.getByRole('region', {name: 'Reset one account'});
  page.once('dialog', d => d.accept());
  await card.getByRole('button', {name: "Clear today's shared count"}).click();
  await expect(card.getByText("Today's shared count is cleared (it was 7 questions and 1 upload)")).toBeVisible();
  void api;
});
