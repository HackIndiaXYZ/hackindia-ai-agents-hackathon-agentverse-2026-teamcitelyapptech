import {test, expect, Page} from '@playwright/test';

/** Switching environments in the admin console (admin.citely.example has
 *  Prod and Dev). The test build has no NEXT_PUBLIC_ADMIN_ENVS, so the two
 *  environments are handed to the page the way an unset build variable is
 *  read in the browser (Next's process.env falls back to window.process).
 *  Each environment's API is mocked on its own port, with its own data and
 *  a controllable response time. */

const ADMIN = 'admin@citely.example';
const ENVS = [{id: 'prod', name: 'Prod', site: 'https://citely.example', api: 'http://127.0.0.1:8000'},
  {id: 'dev', name: 'Dev', site: 'https://dev.citely.example', api: 'http://127.0.0.1:8001'}];
const MEMBERS: Record<string, number> = {prod: 120, dev: 7};
const token = () => 'e30.' + Buffer.from(JSON.stringify({exp: 9999999999})).toString('base64') + '.t';
const day = (back: number) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);

type Call = {env: string; path: string; at: number};

async function twoEnvironments(page: Page, signedInto = ['prod', 'dev']) {
  await page.addInitScript(([envs, t, signed]) => {
    (window as any).process = {env: {NEXT_PUBLIC_ADMIN_ENVS: envs}};
    for (const id of signed as string[]) { localStorage.setItem(`citely.admin.${id}.token`, t as string); localStorage.setItem(`citely.admin.${id}.email`, 'admin@citely.example'); }
  }, [JSON.stringify(ENVS), token(), signedInto]);
  const log: Call[] = [];
  const delay: Record<string, number> = {prod: 0, dev: 0};
  await page.route(/127\.0\.0\.1:800[01]/, async route => {
    const url = new URL(route.request().url()), env = url.port === '8001' ? 'dev' : 'prod', path = url.pathname;
    log.push({env, path, at: Date.now()});
    if (delay[env]) await new Promise(r => setTimeout(r, delay[env]));
    const json = (data: any, status = 200) => route.fulfill({status, contentType: 'application/json', headers: {'access-control-allow-origin': '*'}, body: JSON.stringify(data)})
      .catch(() => { /* the page went away while this answer was held back */ });
    if (path === '/health') return json({status: 'ok'});
    if (path === '/admin/overview') return json({users: {total: MEMBERS[env] + 2, members: MEMBERS[env], by_status: {approved: MEMBERS[env], pending: 1, declined: 0, suspended: 0},
      new_24h: 0, new_7d: 1, online_now: 1, active_24h: 2, documents: 3, questions: 12, demo_requests_pending: 0, demo_requests_total: 0},
      per_day: Array.from({length: 14}, (_, i) => ({day: day(13 - i), uploads: 0, questions: 0, signups: 0, requests: 1, errors: 0})),
      limits: {enabled: true, period: 'total', uploads_per_account: 3, questions_per_account: 5, uploads_per_day: 200, questions_per_day: 1000, max_upload_mb: 50, max_pages: 300}, usage_today: {upload: 0, question: 0}});
    if (path === '/admin/database') return json({database: {engine: 'SQLite', bytes: 1_200_000, modified_at: new Date().toISOString(), tables: {users: MEMBERS[env], events: 40}},
      storage: {areas: {originals: {bytes: 9_000_000, files: 3}}, disk: {total_bytes: 100e9, used_bytes: 1e9, free_bytes: 99e9}, measured_at: new Date(Date.now() - 120000).toISOString(), refresh_error: null},
      vectors: {collection: `chunks_${env}`, status: 'green', points: 420}});
    return json({detail: 'Not Found'}, 404);
  });
  return {log, delay};
}

const membersTile = (page: Page) => page.locator('.adm-tile').filter({hasText: 'MEMBERS'}).locator('strong');
const envTab = (page: Page, name: string) => page.getByRole('navigation', {name: 'Environment'}).getByRole('button', {name});
const sections = (page: Page) => page.getByRole('navigation', {name: 'Sections'});

test('switching to a prefetched environment shows its data at once, without waiting on its server', async ({page}) => {
  const api = await twoEnvironments(page);
  await page.goto('admin/#prod/overview');
  await expect(membersTile(page)).toHaveText('120');
  // Dev's overview was fetched in the background, once, and the signed-in
  // check and the Overview shared Prod's single request.
  await expect.poll(() => api.log.filter(c => c.env === 'dev' && c.path === '/admin/overview').length).toBe(1);
  expect(api.log.filter(c => c.env === 'prod' && c.path === '/admin/overview')).toHaveLength(1);
  // From here Dev's server takes 10 s to answer anything: switching must not wait for it.
  api.delay.dev = 10_000;
  const started = Date.now();
  await envTab(page, 'Dev').click();
  await expect(membersTile(page)).toHaveText('7', {timeout: 1000});
  expect(Date.now() - started).toBeLessThan(1000);
  await expect(page.locator('.adm-head .adm-label')).toContainText('DEV');
  // And back to Prod: still there.
  await envTab(page, 'Prod').click();
  await expect(membersTile(page)).toHaveText('120', {timeout: 1000});

  // A slower section: opening Database on Prod gets Dev's ready too.
  api.delay.dev = 0;
  await sections(page).getByRole('button', {name: 'Database'}).click();
  await expect(page.locator('.adm-tile').filter({hasText: 'VECTORS'})).toContainText('chunks_prod');
  await expect.poll(() => api.log.filter(c => c.env === 'dev' && c.path === '/admin/database').length).toBe(1);
  api.delay.dev = 10_000;
  await envTab(page, 'Dev').click();
  await expect(page.locator('.adm-tile').filter({hasText: 'VECTORS'})).toContainText('chunks_dev', {timeout: 1000});
  await expect(page.getByText(/Measured 2 min ago/)).toBeVisible();
});

test('nothing is fetched for an environment that is not signed in, beyond one wake-up on opening', async ({page}) => {
  const api = await twoEnvironments(page, ['prod']);
  await page.goto('admin/#prod/overview');
  await expect(membersTile(page)).toHaveText('120');
  await page.waitForTimeout(1000);
  expect(api.log.filter(c => c.env === 'dev').map(c => c.path)).toEqual(['/health']);
});

const MIN = 60_000;
const nudge = (page: Page) => page.mouse.move(200 + Math.random() * 400, 300 + Math.random() * 200);
async function pass(page: Page, minutes: number) {
  for (let m = 0; m < minutes; m++) { await page.clock.runFor(MIN); await page.waitForTimeout(20); }
}
const setVisible = (page: Page, visible: boolean) => page.evaluate(v => {
  Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => (v ? 'visible' : 'hidden')});
  document.dispatchEvent(new Event('visibilitychange'));
}, visible);

test('keeps both servers awake while the console is in use, and lets them sleep when hidden or left', async ({page}) => {
  await page.clock.install();
  const api = await twoEnvironments(page);
  await page.goto('admin/#prod/overview');
  await expect(membersTile(page)).toHaveText('120');
  const count = (env: string) => api.log.filter(c => c.env === env).length;
  // Twelve minutes of use: each server hears from the console at least every
  // 3 minutes (they sleep after 5 minutes without a request).
  let prod = count('prod'), dev = count('dev');
  for (let i = 0; i < 4; i++) { await nudge(page); await pass(page, 3); }
  expect(count('prod') - prod).toBeGreaterThanOrEqual(4);
  expect(count('dev') - dev).toBeGreaterThanOrEqual(4);
  // A hidden tab sends nothing.
  await setVisible(page, false);
  prod = count('prod'); dev = count('dev');
  await pass(page, 30);
  expect([count('prod') - prod, count('dev') - dev]).toEqual([0, 0]);
  // Visible but nobody there: it stops within 10 minutes of the last input.
  await setVisible(page, true);
  await pass(page, 12);
  prod = count('prod'); dev = count('dev');
  await pass(page, 30);
  expect([count('prod') - prod, count('dev') - dev]).toEqual([0, 0]);
});

test('an environment not signed in is woken once on opening, not kept awake while the console is used', async ({page}) => {
  await page.clock.install();
  const api = await twoEnvironments(page, ['prod']);
  await page.goto('admin/#prod/overview');
  await expect(membersTile(page)).toHaveText('120');
  for (let i = 0; i < 3; i++) { await nudge(page); await pass(page, 3); }
  expect(api.log.filter(c => c.env === 'dev').map(c => c.path)).toEqual(['/health']);
  expect(api.log.filter(c => c.env === 'prod').length).toBeGreaterThanOrEqual(3);     // the one in use stays awake
});
