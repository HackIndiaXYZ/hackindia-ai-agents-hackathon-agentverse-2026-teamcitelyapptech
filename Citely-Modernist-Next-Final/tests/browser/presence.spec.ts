import {test, expect, Page} from '@playwright/test';
import {mockApi, signedIn} from './mock-api';

const MIN = 60_000;
// The keep-warm ping: a health read until the server is confirmed awake, then
// the tab's presence signal (active or idle; it also tells the admin who is online).
const keepWarmCalls = (api: any) => api.log.filter((r: any) => r.path === '/health' || (r.path === '/me/presence' && ['active', 'idle'].includes(r.body?.state))).length;
const states = (api: any) => api.presence.map((p: any) => p.state);
const nudge = (page: Page) => page.mouse.move(200 + Math.random() * 400, 300 + Math.random() * 200);
/** Advance the fake clock a minute at a time, letting requests go out. */
async function pass(page: Page, minutes: number) {
  for (let m = 0; m < minutes; m++) { await page.clock.runFor(MIN); await page.waitForTimeout(20); }
}
const setVisible = (page: Page, visible: boolean) => page.evaluate(v => {
  Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => (v ? 'visible' : 'hidden')});
  document.dispatchEvent(new Event('visibilitychange'));
}, visible);

test('the workspace keeps the server awake while in use, then lets it sleep', async ({page}) => {
  await signedIn(page);
  await page.clock.install();
  const api = await mockApi(page);
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  // Thirty minutes of light use: a little input every 10 minutes.
  let start = keepWarmCalls(api);
  for (let i = 0; i < 3; i++) { await nudge(page); await pass(page, 10); }
  const during = keepWarmCalls(api) - start;
  expect(during).toBeGreaterThanOrEqual(27);                  // every minute, never a 5-minute gap
  // Walk away for an hour: checks stop 10 minutes after the last input.
  start = keepWarmCalls(api);
  await pass(page, 60);
  expect(keepWarmCalls(api) - start).toBeLessThanOrEqual(11);
  const settled = keepWarmCalls(api);
  await pass(page, 30);
  expect(keepWarmCalls(api)).toBe(settled);                     // asleep: nothing more
  // Coming back checks at once.
  await nudge(page);
  await expect.poll(() => keepWarmCalls(api)).toBeGreaterThan(settled);
});

test('a hidden workspace tab sends nothing, however long it stays open', async ({page}) => {
  await signedIn(page);
  await page.clock.install();
  const api = await mockApi(page);
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  await expect.poll(() => api.online()).toBe(true);
  await setVisible(page, false);
  await expect.poll(() => states(api).at(-1)).toBe('hidden');
  const start = api.log.length;
  await pass(page, 120);
  expect(api.log.slice(start).filter((r: any) => r.path === '/health' || r.path === '/me/presence')).toEqual([]);
  await setVisible(page, true);
  await expect.poll(() => states(api).at(-1)).toBe('active');
});

test('public sample interactions never wake the backend', async ({page}) => {
  await page.clock.install();
  const api = await mockApi(page);
  await page.goto('');
  await pass(page, 5);
  expect(api.log.filter((r: any) => ['/health', '/ready', '/warmup', '/me/presence'].includes(r.path))).toEqual([]);
  await nudge(page);
  await pass(page, 30);
  expect(keepWarmCalls(api)).toBe(0);
});

// ---- presence: what the admin console's "online" is made of -----------------------

test('the workspace reports active once a minute while in use; the first one records the visit', async ({page}) => {
  await signedIn(page);
  await page.clock.install();
  const api = await mockApi(page);
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  await expect.poll(() => api.presence.length).toBeGreaterThan(0);
  const first = api.presence[0];
  expect(first).toMatchObject({state: 'active', seq: 1, first: true});
  expect(typeof first.tab).toBe('string');
  expect(typeof first.browser).toBe('string');
  await nudge(page); await pass(page, 1);
  await nudge(page); await pass(page, 1);
  expect(states(api).slice(0, 3)).toEqual(['active', 'active', 'active']);
  expect(api.presence.slice(1).some((p: any) => p.first)).toBe(false);
  expect(api.online()).toBe(true);
});

test('no input for 5 minutes is idle (away), and any input is active again at once', async ({page}) => {
  await signedIn(page);
  await page.clock.install();
  const api = await mockApi(page);
  await page.goto('studio.html?space=org');
  await expect.poll(() => api.online()).toBe(true);
  await pass(page, 6);
  expect(states(api).at(-1)).toBe('idle');
  expect(api.online()).toBe(false);
  await nudge(page);
  await expect.poll(() => states(api).at(-1)).toBe('active');
});

test('hiding the tab says hidden at once; coming back says active at once', async ({page}) => {
  await signedIn(page);
  await page.clock.install();
  const api = await mockApi(page);
  await page.goto('studio.html?space=org');
  await expect.poll(() => api.online()).toBe(true);
  await setVisible(page, false);
  await expect.poll(() => states(api).at(-1)).toBe('hidden');
  expect(api.online()).toBe(false);
  await setVisible(page, true);
  await expect.poll(() => states(api).at(-1)).toBe('active');
  expect(api.online()).toBe(true);
});

test('closing the page says closed', async ({page}) => {
  await signedIn(page);
  const api = await mockApi(page);
  await page.goto('studio.html?space=org');
  await expect.poll(() => api.online()).toBe(true);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false})));
  await expect.poll(() => states(api).at(-1)).toBe('closed');
  expect(api.online()).toBe(false);
});

test('signing out of the workspace ends presence for every tab of this browser, and the tab goes quiet', async ({page}) => {
  await signedIn(page);
  await page.clock.install();
  const api = await mockApi(page);
  await page.goto('studio.html?space=org');
  await expect.poll(() => api.online()).toBe(true);
  const browser = api.presence[0].browser;
  await page.evaluate(() => (window as any).CitelyAPI.logout());
  await expect.poll(() => api.presence.at(-1)).toMatchObject({state: 'signed_out', browser});
  await expect(page).toHaveURL(/signin/);
  expect(api.online()).toBe(false);
});

test('signing out from the site header also ends presence, without a workspace open', async ({page}) => {
  await signedIn(page);
  const api = await mockApi(page);
  await page.goto('studio.html?space=org');
  await expect.poll(() => api.online()).toBe(true);
  const browser = api.presence[0].browser;
  await page.goto('approve/');
  await page.getByRole('banner').getByRole('button', {name: 'Sign out'}).click();
  await expect.poll(() => api.presence.at(-1)).toMatchObject({state: 'signed_out', browser});
  expect(api.online()).toBe(false);
});

test('a pending account (never online) signs out without telling the presence server anything', async ({page}) => {
  await signedIn(page);
  const api = await mockApi(page, {account: {status: 'pending'}});
  await page.goto('review/');
  const signOut = page.getByRole('button', {name: 'Sign out'});
  await expect(signOut.first()).toBeVisible();
  await signOut.first().click();
  await expect(page).toHaveURL(/signin/);
  expect(api.presence).toEqual([]);
});

test('sign out everywhere: the server ends presence itself; no extra signal with the dead token', async ({page}) => {
  await signedIn(page);
  const api = await mockApi(page);
  await page.goto('studio.html?space=org');
  await expect.poll(() => api.online()).toBe(true);
  const before = api.presence.length;
  await page.evaluate(() => (window as any).CitelyAPI.signOutEverywhere());
  await expect(page).toHaveURL(/signin/);
  expect(api.account.signedOutEverywhere).toBe(1);
  expect(api.presence.slice(before).filter((p: any) => p.state === 'signed_out')).toEqual([]);
});

test('two tabs: hiding one does not take the person offline while the other is in use', async ({context}) => {
  const a = await context.newPage(), b = await context.newPage();
  await signedIn(a); await signedIn(b);
  const api = await mockApi(a);
  const apiB = await mockApi(b);
  await a.goto('studio.html?space=org');
  await b.goto('studio.html?space=org');
  await expect.poll(() => api.presence.length).toBeGreaterThan(0);
  await expect.poll(() => apiB.presence.length).toBeGreaterThan(0);
  const tabA = api.presence[0].tab, tabB = apiB.presence[0].tab;
  expect(tabA).not.toBe(tabB);                                   // each tab reports for itself...
  expect(api.presence[0].browser).toBe(apiB.presence[0].browser); // ...in the same browser
  await setVisible(a, false);
  await expect.poll(() => api.presence.at(-1)?.state).toBe('hidden');
  // Tab B never said anything but active: the person is still online.
  expect(apiB.presence.every((p: any) => p.state === 'active')).toBe(true);
  expect(apiB.online()).toBe(true);
});

test('a suspended account is signed out by the first presence signal it sends', async ({page}) => {
  await signedIn(page);
  await mockApi(page);
  await page.route(/127\.0\.0\.1:8000\/me\/presence/, r => r.fulfill({status: 403, headers: {'X-Citely-Account': 'suspended', 'Access-Control-Expose-Headers': 'X-Citely-Account'}, json: {detail: 'This account is suspended.'}}));
  await page.goto('studio.html?space=org');
  await expect(page).toHaveURL(/signin/);
  await expect(page.getByText('This account is suspended.')).toBeVisible();
});
