import {test, expect} from '@playwright/test';
import {mockApi, signedIn} from './mock-api';

test.beforeEach(async ({page}) => { await signedIn(page); });

const files = (n: number) => Array.from({length: n}, (_, i) => ({name: `Deck ${i + 1}.txt`, mimeType: 'text/plain', buffer: Buffer.from(('Source text ' + i + '. ').repeat(40))}));
async function upload(page: any, count: number) {
  await page.locator('[data-upload]').first().click();
  await page.locator('#upload-input').setInputFiles(files(count));
}
const row = (page: any, name: string) => page.locator('[data-file-id]', {hasText: name});

test('uploads sent while the server sleeps wait for it, then each uploads once', async ({page}) => {
  const api = await mockApi(page);
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  // The server goes to sleep: until it is back, every request gets the
  // platform's 503 — health checks and uploads alike.
  let healthy = false;
  await page.route(/127\.0\.0\.1:8000\/(health|ingest\/async)/, r => healthy ? r.fallback() : r.fulfill({status: 503, json: {detail: 'Service unavailable'}}));
  await upload(page, 3);
  await expect(row(page, 'Deck 1.txt')).toContainText('Waiting for the server to wake up', {timeout: 10000});
  setTimeout(() => { healthy = true; }, 2500);
  for (const n of [1, 2, 3]) await expect(row(page, `Deck ${n}.txt`).locator('.status')).toHaveText(/Ready/, {timeout: 20000});
  expect(api.ingested.sort()).toEqual(['Deck 1.txt', 'Deck 2.txt', 'Deck 3.txt']);
  await expect(page.locator('.status.failed')).toHaveCount(0);
});

test('a lost response, a dropped request and a 503 are all retried without a duplicate or a failure', async ({page}) => {
  const api = await mockApi(page, {uploadAttempts: ['lost', 'abort', '503']});
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  await upload(page, 1);
  await expect(row(page, 'Deck 1.txt').locator('.status')).toHaveText(/Ready/, {timeout: 30000});
  expect(api.ingested).toEqual(['Deck 1.txt']);                          // the "lost" attempt was the only ingest
  const posts = api.log.filter(r => r.path === '/ingest/async');
  expect(posts.length).toBe(4);
  await expect(page.locator('.status.failed')).toHaveCount(0);
});

const SAMPLES = [
  {kind: 'PDF', items: [{id: 's-pdf', name: 'Annual report', filename: 'annual-report.pdf', kind: 'PDF', bytes: 300_000}]},
  {kind: 'XLSX', items: [{id: 's-xlsx', name: 'Quarterly numbers', filename: 'quarterly.xlsx', kind: 'XLSX', bytes: 52_000}]},
];

test('a sample is added like an upload: grouped by type, sent once with its upload id, then ready', async ({page}) => {
  const api = await mockApi(page, {samples: SAMPLES});
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  await page.locator('[data-upload]').first().click();
  const picker = page.locator('#sample-picker');
  await expect(picker.getByRole('heading', {name: 'No file to hand? Try a sample'})).toBeVisible();
  await expect(picker.locator('.sample-kind')).toHaveText(['PDF', 'Excel']);
  await expect(picker.locator('[data-sample="s-xlsx"]')).toContainText('quarterly.xlsx · 51 KB');
  await picker.locator('[data-sample="s-pdf"]').click();
  await expect(page.locator('#modal')).not.toBeVisible();
  await expect(row(page, 'annual-report.pdf').locator('.status')).toHaveText(/Ready/, {timeout: 15000});
  expect(api.ingested).toEqual(['annual-report.pdf']);
  const use = api.log.filter(r => r.path === '/samples/s-pdf/use');
  expect(use.length).toBe(1);
  // The row's id goes along, so a resend after a lost response can't add it twice.
  await expect(page.locator('.status.failed')).toHaveCount(0);
  // Back in the dialog it is marked as already here.
  await page.locator('[data-upload]').first().click();
  await expect(page.locator('[data-sample="s-pdf"]')).toContainText('already in this workspace');
});

test('a sample counts toward the upload limit', async ({page}) => {
  await mockApi(page, {samples: SAMPLES, usage: {limited: true, max_upload_mb: 50, max_pages: 200,
    uploads: {used: 10, limit: 10, remaining: 0, daily_exhausted: false}, questions: {used: 0, limit: 50, remaining: 50, daily_exhausted: false}}});
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  await page.locator('[data-upload]').first().click();
  await expect(page.locator('#sample-picker')).toHaveCount(0);           // the dialog doesn't open at the limit
});

test('no samples: the section is left out; samples that fail to load say so', async ({page}) => {
  await mockApi(page);
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  await page.locator('[data-upload]').first().click();
  await expect(page.locator('#upload-input')).toBeAttached();
  await expect(page.locator('#sample-picker')).toHaveCount(0);
  await page.unrouteAll({behavior: 'ignoreErrors'});
  await mockApi(page, {samples: 'error'});
  await page.reload();
  await expect(page.locator('#file-search')).toBeVisible();
  await page.locator('[data-upload]').first().click();
  await expect(page.locator('#sample-list')).toHaveText('Samples couldn’t load: Samples are unavailable right now.');
});
