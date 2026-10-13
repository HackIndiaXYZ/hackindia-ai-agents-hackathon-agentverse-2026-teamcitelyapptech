import {test, expect, Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {signedIn} from './mock-api';

// A real (tiny) PDF: pages 1 and 2 carry typed text, page 3 is a picture only, like a scan.
const PDF = readFileSync(path.join(__dirname, '..', 'fixtures', 'pdf', 'sample.pdf'));
const PAGES = [
  'Quarterly revenue grew by twelve percent.\nEnterprise sales led the growth.',
  'Costs were flat.\nHeadcount stayed at 40.',
  '',
];
const span = (pageIndex: number, quote: string) => { const s = PAGES[pageIndex].indexOf(quote); return {page_char_start: s, page_char_end: s + quote.length, quote}; };
const cite = (id: string, pageIndex: number, quote: string, extra: any = {}) =>
  ({citation_id: id, document_id: 'doc1', evidence_role: 'cited', page: pageIndex + 1, content: quote, extraction_version: 'v1', ...span(pageIndex, quote), ...extra});
const CITATIONS = [
  cite('t1', 0, 'Enterprise sales led the growth.'),
  cite('t2', 1, 'Headcount stayed at 40.'),
  cite('stale', 0, 'Quarterly revenue grew by twelve percent.', {extraction_version: 'old'}),
  // Text read from a picture on a scanned page: no text to mark, so its place on the page is marked.
  {citation_id: 'pic', document_id: 'doc1', evidence_role: 'cited', page: 3, content: 'Revenue 10 12 14', quote: 'Revenue 10 12 14', extraction_version: 'v1',
   provenance: 'ocr', anchor: {format: 'pdf', page: 3, box: [0.1, 0.2, 0.5, 0.3], evidence_region: true}},
];

async function setup(page: Page) {
  const state: any = {viewerRequests: 0, workerRequests: 0, errors: [] as string[]};
  page.on('request', r => { if (/\/viewers\/pdf\.js/.test(r.url())) state.viewerRequests++; if (/pdf\.worker/.test(r.url())) state.workerRequests++; });
  page.on('pageerror', e => state.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') state.errors.push(m.text()); });
  await signedIn(page);
  await page.route(/127\.0\.0\.1:8000/, async route => {
    const req = route.request(), p = decodeURIComponent(new URL(req.url()).pathname), m = req.method();
    const json = (data: any, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(data)});
    const docId = p.includes('/doc1/') || p.endsWith('/doc1') ? 'doc1' : p.includes('/doc9/') ? 'doc9' : p.match(/org:(doc\d)/)?.[1];
    if (p === '/health' || p === '/ready') return json({status: 'ok', ready: true, readiness: 'ready'});
    if (p === '/warmup') return json({status: 'warm'});
    if (p === '/me/usage') return json({limited: false});
    if (p === '/me/presence') return route.fulfill({status: 204});
    if (p === '/documents') return json([{id: 'doc1', filename: 'Report.pdf', pages: 3, ingested_at: '2026-10-01', has_original: true, original_compatible: true},
                                         {id: 'doc9', filename: 'Notes.txt', pages: 1, ingested_at: '2026-10-01', has_original: true, original_compatible: true}]);
    if (docId === 'doc1' && p.endsWith('/file')) return route.fulfill({status: 200, contentType: 'application/pdf', body: PDF});
    if (p.endsWith('/pages')) return json(docId === 'doc1' ? PAGES.map((text, i) => ({page: i + 1, text, extraction_version: 'v1'})) : [{page: 1, text: 'Plain notes text.', extraction_version: 'v1'}]);
    if (p.endsWith('/history')) return json(docId === 'doc1' ? [{id: 't1', question: 'Where?', answer: 'Here.', sources: CITATIONS, created_at: '2026-10-01T00:00:00Z'}] : []);
    if (p.startsWith('/state/catalog')) {
      if (m === 'PUT') return json({revision: 2, updated: 'now'});
      return json({value: {orgs: [{id: 'personal', name: 'Personal', spaces: [{id: 'org', name: 'My workspace', folders: [], docs: [
        {id: 'doc1', name: 'Report.pdf', status: 'Ready', folder: null, pages: 3}, {id: 'doc9', name: 'Notes.txt', status: 'Ready', folder: null, pages: 1}]}]}]}, revision: 1});
    }
    if (p.startsWith('/state/')) return json(m === 'PUT' ? {revision: 1, updated: 'now'} : {value: null, revision: 0});
    if (p.endsWith('/annotations')) return json([]);
    if (p.endsWith('/notes/versions')) return json([]);
    if (p.endsWith('/notes')) return json({conversation_id: 'x', workspace_id: 'org', content: '', revision: 0});
    return json({detail: 'unexpected ' + p}, 404);
  });
  return state;
}

const viewer = (page: Page) => page.locator('.original-pdf');
const marked = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.original-pdf mark.current-citation')].map(m => m.textContent).join(''));
async function open(page: Page, state?: any) {
  await page.goto('studio.html?desk=doc1&space=org');
  try { await expect(viewer(page).locator('section.pdf-page')).toHaveCount(3); }
  catch (e) { throw new Error(`${(e as Error).message}\nPage errors: ${JSON.stringify(state?.errors ?? [])}\nStatus: ${await page.locator('#highlight-hint, .status, [role=status]').allInnerTexts()}`); }
}

test('a PDF original opens as its real pages, loaded only when needed, with drawn pictures and a text layer', async ({page}) => {
  const state = await setup(page);
  await page.goto('studio.html?desk=doc9&space=org');
  await expect(page.locator('[data-page-text]')).toHaveText('Plain notes text.');
  expect(state.viewerRequests).toBe(0);                                                   // a text file never loads the PDF viewer
  await open(page, state);
  expect(state.viewerRequests).toBe(1);
  await expect(viewer(page).locator('canvas.pdf-canvas').first()).toBeVisible();          // the page itself is drawn
  await expect(viewer(page).locator('section.pdf-page').nth(0).locator('.pdf-text')).toContainText('Enterprise sales led the growth.');
  await expect(viewer(page).locator('section.pdf-page').nth(1).locator('.pdf-text')).toContainText('Headcount stayed at 40.');
  await expect(viewer(page).locator('section.pdf-page').nth(2).locator('.pdf-text')).toHaveText('');   // the scanned page has no text layer
  await expect(page.locator('#paper-viewport')).not.toContainText('EXTRACTED DOCUMENT TEXT');
  expect(state.workerRequests).toBeGreaterThan(0);
  expect(state.errors).toEqual([]);
});

test('a citation highlights exactly its passage on the right page, and brings it into view', async ({page}) => {
  const state = await setup(page);
  await open(page, state);
  await page.locator('[data-citation="t1"]').last().click();
  await expect.poll(() => marked(page)).toBe('Enterprise sales led the growth.');
  await expect(page.locator('.original-pdf mark.current-citation').first()).toBeInViewport();
  await page.locator('[data-citation="t2"]').last().click();
  await expect.poll(() => marked(page)).toBe('Headcount stayed at 40.');
  await expect(page.locator('.original-pdf mark.current-citation').first()).toBeInViewport();
  await expect(page.locator('.page-control span')).toContainText('2 / 3');
  expect(state.errors).toEqual([]);
});

test('text read from a picture on a scanned page is shown as a marked region of that page', async ({page}) => {
  const state = await setup(page);
  await open(page, state);
  await page.locator('[data-citation="pic"]').last().click();
  const region = viewer(page).locator('section.pdf-page').nth(2).locator('.pdf-region.current-citation');
  await expect(region).toHaveCount(1);
  await expect(region).toHaveCSS('left', /^\d/);
  const style = await region.evaluate(el => ({left: (el as HTMLElement).style.left, top: (el as HTMLElement).style.top, width: (el as HTMLElement).style.width, height: (el as HTMLElement).style.height}));
  expect(style).toEqual({left: '10%', top: '20%', width: '50%', height: '30%'});
  expect(await marked(page)).toBe('');                                                      // and no text is marked elsewhere
  await expect(region).toBeInViewport();
});

test('a citation made against other text than this original is never moved onto it', async ({page}) => {
  const state = await setup(page);
  await open(page, state);
  await page.locator('[data-citation="stale"]').last().click();
  await expect(page.locator('.original-pdf mark.current-citation')).toHaveCount(0);
  await expect(page.locator('.original-pdf .pdf-region.current-citation')).toHaveCount(0);
});

test('opening another citation clears the previous mark instead of stacking them', async ({page}) => {
  const state = await setup(page);
  await open(page, state);
  await page.locator('[data-citation="pic"]').last().click();
  await expect(viewer(page).locator('.pdf-region.current-citation')).toHaveCount(1);
  await page.locator('[data-citation="t1"]').last().click();
  await expect(viewer(page).locator('.pdf-region')).toHaveCount(0);                      // none is left behind, not even an invisible one
  await expect.poll(() => marked(page)).toBe('Enterprise sales led the growth.');
});

test('the file list shows the first page of the PDF as its thumbnail', async ({page}) => {
  const state = await setup(page);
  await page.goto('studio.html?space=org');
  await expect(page.locator('.thumb-pdf canvas').first()).toBeVisible({timeout: 20000});
  expect(state.errors).toEqual([]);
});

test('the page itself never scrolls: only the document pane does, and the top bar stays in view', async ({page}) => {
  const state = await setup(page);
  await open(page, state);
  const windowState = () => page.evaluate(() => ({y: window.scrollY, spare: document.documentElement.scrollHeight - window.innerHeight}));
  expect(await windowState()).toEqual({y: 0, spare: 0});                                    // pdf.js's measuring canvas is hidden, so the page is exactly the window's height
  await expect(page.locator('body > canvas.hiddenCanvasElement')).toBeHidden();
  for (const id of ['t2', 'pic', 't1']) {
    await page.locator(`[data-citation="${id}"]`).last().click();
    await page.waitForTimeout(700);
    expect((await windowState()).y, id).toBe(0);
  }
  // The app's frame starts at the very top of the window, so nothing of its top bar is cut off.
  expect(await page.evaluate(() => Math.round(document.querySelector('.dx-shell')!.getBoundingClientRect().top))).toBe(0);
});

test('the document keeps its place when the workspace redraws', async ({page}) => {
  const state = await setup(page);
  await open(page, state);
  await page.evaluate(() => { const v = document.querySelector('#paper-viewport') as HTMLElement; v.style.scrollBehavior = 'auto'; v.scrollTop = 1500; });
  const top = () => page.evaluate(() => Math.round((document.querySelector('#paper-viewport') as HTMLElement).scrollTop));
  expect(await top()).toBe(1500);
  await page.locator('[data-dx-hl]').first().click();                                          // any redraw of the workspace
  await page.waitForTimeout(500);
  expect(await top()).toBe(1500);
  await page.locator('[data-dx-hl]').first().click();
  await page.waitForTimeout(500);
  expect(await top()).toBe(1500);
});
