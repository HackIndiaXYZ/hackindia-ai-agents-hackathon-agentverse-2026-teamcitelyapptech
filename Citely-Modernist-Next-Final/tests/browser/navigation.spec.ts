import {test, expect} from '@playwright/test';
import {mockApi, signedIn, markDocument, isSameDocument} from './mock-api';

const deskName = (page: any) => page.locator('.desk-identity strong');
const openDoc = (page: any, id: string) => page.locator(`button.lx-name[data-open="${id}"]`).click();

test.beforeEach(async ({page}) => { await signedIn(page); });

test('home ↔ conversations swap in place, with browser back/forward and no reload or leaked state', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await mockApi(page);
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  await markDocument(page);

  await openDoc(page, 'doc1');
  await expect(deskName(page)).toHaveText('Alpha report.txt');
  await expect(page.locator('#notes-editor')).toHaveValue('Notes for ALPHA');
  expect(new URL(page.url()).searchParams.get('desk')).toBe('doc1');

  await page.locator('.desk-back-home').click();
  await expect(page.locator('#file-search')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('desk')).toBeNull();

  await openDoc(page, 'doc2');
  await expect(deskName(page)).toHaveText('Beta report.txt');
  await expect(page.locator('#notes-editor')).toHaveValue('Notes for BETA');   // never ALPHA's notes

  for (let round = 0; round < 10; round++) {
    await page.goBack();  await expect(page.locator('#file-search')).toBeVisible();
    await page.goBack();  await expect(deskName(page)).toHaveText('Alpha report.txt');
    await expect(page.locator('#notes-editor')).toHaveValue('Notes for ALPHA');
    await page.goForward(); await expect(page.locator('#file-search')).toBeVisible();
    await page.goForward(); await expect(deskName(page)).toHaveText('Beta report.txt');
    await expect(page.locator('#notes-editor')).toHaveValue('Notes for BETA');
  }
  expect(await isSameDocument(page)).toBe(true);   // 40 transitions, zero page loads
  expect(errors).toEqual([]);
});

test('leaving while slow reads are still loading stays in place, and the stale reads never land in the next conversation', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  // ALPHA's notes and annotations are slow; BETA's arrive instantly.
  await mockApi(page, {delayMs: {'/conversations/org:doc1/notes': 1500, '/conversations/org:doc1/annotations': 1500, '/state/view:doc1': 1500}});
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  await markDocument(page);
  await openDoc(page, 'doc1');
  await expect(deskName(page)).toHaveText('Alpha report.txt');   // rendered, tail reads still pending
  await page.locator('.desk-back-home').click();
  await expect(page.locator('#file-search')).toBeVisible();
  await openDoc(page, 'doc2');
  await expect(page.locator('#notes-editor')).toHaveValue('Notes for BETA');
  await page.waitForTimeout(2000);                                // ALPHA's slow reads resolve now
  await expect(page.locator('#notes-editor')).toHaveValue('Notes for BETA');
  // The screen is not enough: what the next save would persist must be BETA's.
  expect(await page.evaluate('work.notes')).toBe('Notes for BETA');
  expect(await page.evaluate('noteBase.content')).toBe('Notes for BETA');
  await expect(deskName(page)).toHaveText('Beta report.txt');
  expect(await isSameDocument(page)).toBe(true);                  // no fallback reload for reads
  expect(errors).toEqual([]);
});

test('refreshing a conversation URL still opens that conversation', async ({page}) => {
  await mockApi(page);
  await page.goto('studio.html?space=org');
  await openDoc(page, 'doc2');
  await expect(deskName(page)).toHaveText('Beta report.txt');
  await page.reload();
  await expect(deskName(page)).toHaveText('Beta report.txt');
  await expect(page.locator('#notes-editor')).toHaveValue('Notes for BETA');
});

test('leaving while an answer is in flight reloads cleanly and never writes into another conversation', async ({page}) => {
  const api = await mockApi(page, {queryDelayMs: 2500});
  await page.goto('studio.html?space=org');
  await openDoc(page, 'doc1');
  await expect(page.locator('#notes-editor')).toBeEnabled();
  await markDocument(page);

  await page.locator('#message-input').fill('Question asked in ALPHA');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect.poll(() => api.log.some(r => r.path === '/query/stream')).toBe(true);

  page.once('dialog', d => d.accept());           // the unsent turn makes the desk dirty
  await page.locator('.desk-back-home').click();
  await expect(page.locator('#file-search')).toBeVisible();
  expect(await isSameDocument(page)).toBe(false);  // fell back to a full reload

  await openDoc(page, 'doc2');
  await expect(deskName(page)).toHaveText('Beta report.txt');
  await page.waitForTimeout(3500);                 // well past the delayed answer

  // Nothing from ALPHA — neither the question nor its late answer — may reach
  // BETA's stored conversation or its screen.
  const leaked = (text: string) => text.includes('ALPHA') || text.includes('ANSWER FOR doc1');
  const intoBeta = api.log.filter(r => r.method === 'PUT' && r.path === '/state/chat:org:doc2');
  expect(intoBeta.filter(r => leaked(JSON.stringify(r.body)))).toEqual([]);
  expect(leaked(JSON.stringify(api.records.get('chat:org:doc2')?.value ?? null))).toBe(false);
  await expect(page.locator('#messages')).not.toContainText('ANSWER FOR doc1');
});

test('unsaved notes: leaving asks first, and staying keeps the conversation', async ({page}) => {
  await mockApi(page);
  await page.goto('studio.html?space=org');
  await openDoc(page, 'doc1');
  await expect(page.locator('#notes-editor')).toBeEnabled();
  await page.locator('#notes-editor').click();
  await page.keyboard.type('An unsaved thought');

  page.once('dialog', d => { expect(d.type()).toBe('confirm'); d.dismiss(); });
  await page.locator('.desk-back-home').click();
  await expect(deskName(page)).toHaveText('Alpha report.txt');
  await expect(page.locator('#notes-editor')).toHaveValue('Notes for ALPHAAn unsaved thought');
  expect(new URL(page.url()).searchParams.get('desk')).toBe('doc1');

  page.once('dialog', d => d.accept());
  await page.locator('.desk-back-home').click();
  await expect(page.locator('#file-search')).toBeVisible();
});

test('browser Back with unsaved notes, dismissed, restores the conversation URL', async ({page}) => {
  await mockApi(page);
  await page.goto('studio.html?space=org');
  await openDoc(page, 'doc1');
  await expect(page.locator('#notes-editor')).toBeEnabled();
  await page.locator('#notes-editor').click();
  await page.keyboard.type('Keep me');
  page.once('dialog', d => d.dismiss());
  await page.goBack();
  await expect(deskName(page)).toHaveText('Alpha report.txt');
  await expect.poll(() => new URL(page.url()).searchParams.get('desk')).toBe('doc1');
  await expect(page.locator('#notes-editor')).toHaveValue('Notes for ALPHAKeep me');
});

test('boot survives one transient 503 on every read', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const api = await mockApi(page, {failOnce: ['/state/catalog', '/documents', '/state/chat:org:doc1', '/conversations/org:doc1/notes', '/conversations/org:doc1/annotations', '/documents/doc1/pages']});
  await page.goto('studio.html?desk=doc1&space=org');
  await expect(deskName(page)).toHaveText('Alpha report.txt');
  await expect(page.locator('#notes-editor')).toHaveValue('Notes for ALPHA');
  await expect(page.locator('[data-page-text]')).toHaveText('Page text of doc1.');
  await expect(page.locator('.boot')).toHaveCount(0);
  expect(api.log.filter(r => r.method === 'GET' && r.path === '/state/catalog').length).toBe(2);   // failed once, retried once
  expect(errors).toEqual([]);
});

test('cold start: the workspace says it is waking up, counts the wait, then opens', async ({page}) => {
  // Six failed probes span ~12 s of backoff, long enough for the counter to show.
  await mockApi(page, {readySequence: [503, 503, 503, 503, 503, 503, 200]});
  await page.goto('studio.html?space=org');
  await expect(page.locator('.boot span')).toHaveText(/Waking up the server/);
  await expect(page.locator('.boot span')).toHaveText(/0:\d\d so far\./, {timeout: 10000});
  await expect(page.locator('#file-search')).toBeVisible({timeout: 20000});
});

test('typing while the workspace re-renders in the background loses no keystrokes', async ({page}) => {
  // Annotations and page text arrive slowly, re-rendering the workspace while
  // the reader is already typing in the notes and the question box.
  await mockApi(page, {delayMs: {'/conversations/org:doc1/annotations': 900, '/documents/doc1/pages': 1300, '/state/view:doc1': 600}});
  await page.goto('studio.html?space=org');
  await openDoc(page, 'doc1');
  await expect(page.locator('#notes-editor')).toBeEnabled();
  await page.locator('#notes-editor').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' — typed during loading, every character', {delay: 40});
  await page.locator('#message-input').click();
  await page.keyboard.type('A question typed while things load', {delay: 30});
  await page.waitForTimeout(1500);                                   // all slow loads have landed
  await expect(page.locator('#notes-editor')).toHaveValue('Notes for ALPHA — typed during loading, every character');
  await expect(page.locator('#message-input')).toHaveValue('A question typed while things load');
});
