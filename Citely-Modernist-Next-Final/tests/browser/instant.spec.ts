import {test, expect, Page} from '@playwright/test';
import {mockApi, signedIn} from './mock-api';

test.beforeEach(async ({page}) => { await signedIn(page); });

/** Puts the backend to sleep: every API request gets the platform's 503 until woken. */
async function sleepingServer(page: Page) {
  const state = {asleep: true, during: [] as string[]};
  await page.route(/127\.0\.0\.1:8000\//, route => {
    if (!state.asleep) return route.fallback();
    state.during.push(route.request().method() + ' ' + new URL(route.request().url()).pathname);
    return route.fulfill({status: 503, json: {detail: 'Service unavailable'}});
  });
  return state;
}
const snapshotKey = 'citely.snapshot.v1.test-owner';

test('the second visit opens instantly from this device while the server wakes, then refreshes', async ({page}) => {
  const api = await mockApi(page);
  await page.goto('studio.html?space=org');                          // first visit: the server is up
  await expect(page.locator('#file-search')).toBeVisible();
  await expect.poll(() => page.evaluate(k => !!localStorage.getItem(k), snapshotKey)).toBe(true);

  // Meanwhile a folder was created on another device, and the server went to sleep.
  const catalog = api.records.get('catalog')!;
  catalog.value.orgs[0].spaces[0].folders.push({id: 'f-new', name: 'Made on another device'});
  catalog.revision++;
  const server = await sleepingServer(page);
  await page.reload();
  await expect(page.locator('#file-search')).toBeVisible({timeout: 2000});   // no waiting screen
  await expect(page.locator('#file-items')).toContainText('Alpha report.txt');
  await expect(page.locator('#connecting-pill')).toContainText('Waking up the server');
  await expect(page.locator('#file-items')).not.toContainText('Made on another device');

  // Actions that need the server are held, not sent.
  await page.locator('[data-upload]').first().click();
  await expect(page.locator('#toast')).toContainText('Connecting to the server');
  await expect(page.locator('#upload-input')).toHaveCount(0);
  // Nothing but the wake itself (/warmup) was sent while asleep.
  expect(server.during.filter(r => (r.startsWith('POST') || r.startsWith('PUT')) && r !== 'POST /warmup')).toEqual([]);

  server.asleep = false;                                             // it wakes
  await expect(page.locator('#connecting-pill')).toHaveCount(0, {timeout: 20000});
  await expect(page.locator('#file-items')).toContainText('Made on another device');
  // Once awake, the first presence signal records the visit (and who is online, for the admin console).
  await expect.poll(() => api.presence.some(b => b.state === 'active' && b.first === true && typeof b.timezone === 'string')).toBe(true);
});

test('a saved conversation opens instantly, read-only, and becomes live when the server answers', async ({page}) => {
  await mockApi(page);
  await page.goto('studio.html?desk=doc1&space=org');
  await expect(page.locator('#notes-editor')).toHaveValue('Notes for ALPHA');
  await expect(page.locator('[data-page-text]')).toHaveText('Page text of doc1.');
  await expect.poll(() => page.evaluate(k => JSON.parse(localStorage.getItem(k) || '{}').desk?.id, snapshotKey)).toBe('doc1');

  const server = await sleepingServer(page);
  await page.reload();
  await expect(page.locator('.desk-identity strong')).toHaveText('Alpha report.txt', {timeout: 2000});
  await expect(page.locator('#notes-editor')).toHaveValue('Notes for ALPHA');
  await expect(page.locator('#notes-editor')).toBeDisabled();
  await expect(page.locator('.connecting-doc')).toContainText('Alpha report.txt will open here');
  await expect(page.locator('#message-input')).toHaveAttribute('placeholder', /Connecting to the server/);
  await page.locator('#message-input').fill('A question typed while waking');
  await page.locator('#message-input').press('Enter');
  await expect(page.locator('#toast')).toContainText('Connecting to the server');
  expect(server.during.filter(r => r.includes('/query'))).toEqual([]);

  server.asleep = false;
  await expect(page.locator('[data-page-text]')).toHaveText('Page text of doc1.', {timeout: 20000});
  await expect(page.locator('#notes-editor')).toBeEnabled();
  await expect(page.locator('#connecting-pill')).toHaveCount(0);
});

test('a copy saved by another account is never shown, and signing out removes it', async ({page}) => {
  await mockApi(page);
  await page.addInitScript(() => sessionStorage.getItem('seeded') || (sessionStorage.setItem('seeded', '1'), localStorage.setItem('citely.snapshot.v1.someone-else', JSON.stringify({v: 1, user: {id: 'someone-else', name: 'X', email: 'x'},
    catalog: {orgs: [{id: 'p', name: 'P', spaces: [{id: 'org', name: 'Their workspace', folders: [], docs: [{id: 'z', name: 'THEIR SECRET.pdf', status: 'Ready', folder: null}]}]}]}, documents: [], desk: null}))));
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('THEIR SECRET');
  await expect.poll(() => page.evaluate(k => !!localStorage.getItem(k), snapshotKey)).toBe(true);
  await page.locator('[data-menu="avatar"]').click();
  await page.locator('[data-logout]').click();
  await page.waitForURL(/signin/);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('citely.snapshot.')))).toEqual([]);
});
