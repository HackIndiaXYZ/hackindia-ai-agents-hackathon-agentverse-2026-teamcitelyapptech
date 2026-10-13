import {test, expect, Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {signedIn} from './mock-api';
import {expectFlashThenGone, expectNoBorders} from './highlight-style';

// The real synthetic .docx and the text Azure Document Intelligence actually
// extracted from it — what a deployed document's pages.json contains.
const FX = path.join(__dirname, '..', 'fixtures', 'docx');
const DOCX = readFileSync(path.join(FX, 'sample.docx'));
const PAGE = readFileSync(path.join(FX, 'sample.azure.txt'), 'utf8');
const span = (q: string) => { const s = PAGE.indexOf(q); return {page_char_start: s, page_char_end: s + q.length, quote: q}; };
const QA = 'CITATION_TARGET_A: operating cash flow was 8.4 million dollars.';
const QB = 'CITATION_TARGET_B: enterprise revenue 62%';          // inside a table cell
const QC = 'CITATION_TARGET_C: principal planning risks are slower cycles.';
const cite = (id: string, q: string) => ({citation_id: id, document_id: 'doc1', evidence_role: 'cited', page: 1, content: q, extraction_version: 'v1', ...span(q)});

type Opts = {hasOriginal?: boolean; compatible?: boolean; fileStatus?: number; pagesText?: string; attachFlow?: boolean; uploadLater?: boolean; folder?: boolean};
async function setup(page: Page, o: Opts = {}) {
  const state: any = {uploaded: !o.uploadLater, annotations: [] as any[], attachCalls: [] as string[], fileRequests: 0, viewerRequests: 0, hasOriginal: o.hasOriginal ?? true, compatible: o.compatible ?? true};
  page.on('request', r => { if (r.url().includes('/viewers/docx.js')) state.viewerRequests++; });
  await signedIn(page);
  await page.route(/127\.0\.0\.1:8000/, async route => {
    const req = route.request(), p = decodeURIComponent(new URL(req.url()).pathname), m = req.method();
    const json = (data: any, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(data)});
    if (p === '/health' || p === '/ready') return json({status: 'ok', ready: true, readiness: 'ready'});
    if (p === '/warmup') return json({status: 'warm'});
    if (p === '/ingest/async') return json({job_id: 'j1', status: 'queued', filename: 'Alpha report.docx', created_at: 0, updated_at: 0}, 202);
    if (p === '/ingest/jobs/j1') { state.uploaded = true; return json({job_id: 'j1', status: 'succeeded', filename: 'Alpha report.docx', result: {document_id: 'doc1', pages: 1}, created_at: 0, updated_at: 0}); }
    if (p === '/documents' && !state.uploaded) return json([{id: 'doc2', filename: 'Notes.txt', pages: 1, ingested_at: '2026-10-01', has_original: true, original_compatible: true}]);
    if (p === '/documents') return json([{id: 'doc1', filename: 'Alpha report.docx', pages: 1, ingested_at: '2026-10-01', has_original: state.hasOriginal, original_compatible: state.hasOriginal ? state.compatible : null},
                                         {id: 'doc2', filename: 'Notes.txt', pages: 1, ingested_at: '2026-10-01', has_original: true, original_compatible: true}]);
    if (p === '/documents/doc1/file') { state.fileRequests++; return o.fileStatus ? json({detail: 'nope'}, o.fileStatus) : route.fulfill({status: 200, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: DOCX}); }
    if (p === '/documents/doc1/original') {
      const confirm = (req.postData() || '').includes('name="confirm"\r\n\r\ntrue');
      state.attachCalls.push(confirm ? 'confirm' : 'check');
      if (!confirm) return json({detail: 'This file does not match the document as it was originally processed.', compatible: false, attached: false}, 409);
      state.hasOriginal = true; state.compatible = false;
      return json({attached: true, compatible: false});
    }
    if (p.endsWith('/pages')) return json([{page: 1, text: p.includes('doc1') ? (o.pagesText ?? PAGE) : 'Plain notes text.', extraction_version: 'v1'}]);
    if (p.endsWith('/history')) return json(p.includes('doc1') ? [{id: 't1', question: 'Where is the evidence?', answer: 'See [1] [2] [3].', sources: [cite('a', QA), cite('b', QB), cite('c', QC)], created_at: '2026-10-01T00:00:00Z'}] : []);
    if (p.startsWith('/state/catalog')) {
      if (m === 'PUT') return json({revision: 2, updated: 'now'});
      return json({value: {orgs: [{id: 'personal', name: 'Personal', spaces: [{id: 'org', name: 'My workspace', folders: [], docs: [
        ...(state.uploaded ? [{id: 'doc1', name: 'Alpha report.docx', status: 'Ready', folder: o.folder ? 'f1' : null, pages: 1}] : []), {id: 'doc2', name: 'Notes.txt', status: 'Ready', folder: o.folder ? 'f1' : null, pages: 1}],
        ...(o.folder ? {folders: [{id: 'f1', name: 'Mixed folder'}]} : {})}]}]}, revision: 1});
    }
    if (p.startsWith('/state/')) return json(m === 'PUT' ? {revision: 1, updated: 'now'} : {value: null, revision: 0});
    if (p.endsWith('/annotations')) {
      if (m === 'POST') { const a = {...req.postDataJSON(), id: 'h' + (state.annotations.length + 1), conversation_id: 'org:doc1', created_at: 'n', updated_at: 'n'}; state.annotations.push(a); return json(a, 201); }
      return json(state.annotations);
    }
    if (p.endsWith('/notes/versions')) return json([]);
    if (p.endsWith('/notes')) return json({conversation_id: 'org:doc1', workspace_id: 'org', content: '', revision: 0});
    return json({detail: 'unexpected ' + p}, 404);
  });
  return state;
}
const marks = (page: Page, cls: string) => page.locator(`.original-docx mark.${cls}`);
const selectInOriginal = (page: Page, text: string) => page.evaluate(t => {
  const host = document.querySelector('.original-docx')!;
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT); let n: Node | null;
  while ((n = w.nextNode())) { const i = n.nodeValue!.indexOf(t); if (i >= 0) {
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + t.length);
    const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
    document.querySelector('#paper')!.dispatchEvent(new Event('pointerup', {bubbles: true})); return true; } }
  return false;
}, text);

test('a .docx with its original renders as a document, lazily, with real headings', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const state = await setup(page);
  await page.goto('studio.html?desk=doc2&space=org');                     // a .txt document first
  await expect(page.locator('[data-page-text]')).toHaveText('Plain notes text.');
  expect(state.viewerRequests).toBe(0);                                    // renderer not loaded for it
  await page.goto('studio.html?desk=doc1&space=org');
  await expect(page.locator('.original-docx section.docx').first()).toBeVisible();
  expect(state.viewerRequests).toBe(1);
  await expect(page.locator('#paper-viewport')).not.toContainText('EXTRACTED DOCUMENT TEXT');
  await expect(page.locator('.original-docx [role=heading][aria-level="1"]').first()).toHaveText('Heading One');
  await expect(page.locator('.original-docx [role=heading][aria-level="2"]').first()).toHaveText('Heading Two');
  expect(errors).toEqual([]);
});

test('citations highlight exactly their passage in the original, including a table cell', async ({page}) => {
  await setup(page);
  await page.goto('studio.html?desk=doc1&space=org');
  await expect(marks(page, 'citation-range')).toHaveCount(3);
  for (const [id, quote] of [['a', QA], ['b', QB], ['c', QC]]) {
    await page.locator(`[data-citation="${id}"]`).last().click();
    await expect(page.locator('.original-docx mark.current-citation')).toHaveText(quote);
    await expect(page.locator(`#citation-${id}`)).toBeVisible();
  }
  await expect(page.locator('.original-docx td mark.current-citation')).toHaveCount(0);  // last one clicked is C
  await page.locator('[data-citation="b"]').last().click();
  await expect(page.locator('.original-docx td mark.current-citation')).toHaveText(QB);  // B lands in the table cell
});

test('a highlight made in the original is saved against the extracted text, exactly', async ({page}) => {
  const state = await setup(page);
  await page.goto('studio.html?desk=doc1&space=org');
  await expect(page.locator('.original-docx section.docx').first()).toBeVisible();
  await expect(page.locator('#highlight-tool')).toBeEnabled();
  await page.locator('[data-dx-pop="tools"]').click();await page.locator('#highlight-tool').click();
  const target = 'Unicode: café';
  expect(await selectInOriginal(page, target)).toBe(true);
  await expect(page.locator('#highlight-hint')).toHaveText('Highlight saved.');
  const [saved] = state.annotations;
  expect(saved).toMatchObject({kind: 'manual-highlight', document_id: 'doc1', page_number: 1, extraction_version: 'v1', quote: target});
  expect(PAGE.slice(saved.page_char_start, saved.page_char_end)).toBe(target);   // canonical offsets: the text view can show it too
  await page.reload();
  await expect(marks(page, 'permanent-mark')).toHaveText(target);
});

test('a selection that cannot be matched to the extracted text is refused, not guessed', async ({page}) => {
  const state = await setup(page, {pagesText: 'Completely different extracted text that shares nothing.'});
  await page.goto('studio.html?desk=doc1&space=org');
  await expect(page.locator('.original-docx section.docx').first()).toBeVisible();
  await page.locator('[data-dx-pop="tools"]').click();await page.locator('#highlight-tool').click();
  await selectInOriginal(page, 'Heading Two');
  await expect(page.locator('#highlight-hint')).toContainText('could not be matched');
  expect(state.annotations).toEqual([]);
});

test('if the original cannot be loaded, the extracted text is shown instead', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await setup(page, {fileStatus: 500});
  await page.goto('studio.html?desk=doc1&space=org');
  await expect(page.locator('[data-page-text]')).toContainText('CITATION_TARGET_A');
  await expect(page.locator('#highlight-hint')).toContainText('could not be displayed');
  expect(errors).toEqual([]);
});

test('a document uploaded before originals were kept shows its text, with no prompt to upload again', async ({page}) => {
  const state = await setup(page, {hasOriginal: false});
  await page.goto('studio.html?desk=doc1&space=org');
  await expect(page.locator('[data-page-text]')).toContainText('CITATION_TARGET_A');
  await expect(page.locator('text=Add original')).toHaveCount(0);
  await expect(page.locator('input[type=file][accept=".docx"]')).toHaveCount(0);
  expect(state.fileRequests).toBe(0);
});

test('dark mode keeps document pages readable as paper, and zoom scales the original', async ({page}) => {
  await setup(page);
  await page.goto('studio.html?desk=doc1&space=org');
  await expect(page.locator('.original-docx section.docx').first()).toBeVisible();
  await page.locator('button.dx-avatar').click();await page.locator(`#dx-pop-account [data-theme-choice="${await page.evaluate(()=>document.body.dataset.mode==='dark'?'light':'dark')}"]`).click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'dark');
  const bg = await page.locator('.original-docx section.docx').first().evaluate(e => getComputedStyle(e).backgroundColor);
  expect(bg).toBe('rgb(255, 255, 255)');
  // The document's text keeps its own colour, not Citely's muted grey.
  const ink = await page.locator('.original-docx p', {hasText: 'Unicode'}).first().evaluate(e => getComputedStyle(e).color);
  expect(ink).toBe('rgb(0, 0, 0)');
  const headingInk = await page.locator('.original-docx [role=heading]').first().evaluate(e => getComputedStyle(e.querySelector('span') || e).color);
  expect(headingInk).not.toBe('rgb(0, 0, 0)');                             // the document's own heading colour survives
  const before = await page.locator('.original-paper').evaluate(e => getComputedStyle(e).getPropertyValue('--zoom').trim());
  await page.locator('[data-dx-pop="view"]').click();await page.locator('[data-zoom="10"]').click();
  const after = await page.locator('.original-paper').evaluate(e => getComputedStyle(e).getPropertyValue('--zoom').trim());
  expect(Number(after)).toBeGreaterThan(Number(before));
  await expect(marks(page, 'citation-range')).toHaveCount(3);              // highlights survive zoom and re-render
});

test('a .docx uploaded during the session opens as a document without a reload', async ({page}) => {
  // Reproduces the live failure: original-file info used to arrive only at boot.
  await setup(page, {uploadLater: true});
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  await page.evaluate(() => { (window as any).__sameDocument = true; });
  await page.locator('[data-upload]').first().click();
  await page.locator('#upload-input').setInputFiles({name: 'Alpha report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: DOCX});
  const row = page.locator('[data-file-id]').filter({hasText: 'Alpha report.docx'});
  await expect(row.locator('.status')).toHaveText('Ready', {timeout: 15000});
  await row.locator('button.lx-name').click();
  await expect(page.locator('.original-docx section.docx').first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).__sameDocument)).toBe(true);
});

test('a .docx uploaded during the session gets a thumbnail of the original, not its text', async ({page}) => {
  // Live report: the card showed the extracted-text fallback while the reader showed the original.
  await setup(page, {uploadLater: true});
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  await page.locator('[data-upload]').first().click();
  await page.locator('#upload-input').setInputFiles({name: 'Alpha report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: DOCX});
  const row = page.locator('[data-file-id]').filter({hasText: 'Alpha report.docx'});
  await expect(row.locator('.status')).toHaveText('Ready', {timeout: 15000});
  await expect(row.locator('.lx-thumb-stage.kind-docx')).toBeVisible({timeout: 15000});
  await expect(row.locator('.lx-thumb-stage.kind-text')).toHaveCount(0);
  await expect(row).toContainText('1 page ·');
  await expect(row).not.toContainText('0.0 MB');
});

test('in a folder of mixed file types, each source tab shows its own original or text', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const state = await setup(page, {folder: true});
  await page.goto('studio.html?desk=f1&space=org');
  await expect(page.locator('.desk-identity strong')).toHaveText('Mixed folder');
  const tabs = page.locator('.source-tabs button, .source-tabs [data-source]');
  await expect(tabs).toHaveCount(2);
  await page.locator('[data-dx-pop="sources"]').click(); await tabs.filter({hasText: 'Alpha report.docx'}).click();
  await expect(page.locator('.original-docx section.docx').first()).toBeVisible();     // .docx: from its stored original
  await page.locator('[data-dx-pop="sources"]').click(); await tabs.filter({hasText: 'Notes.txt'}).click();
  await expect(page.locator('[data-page-text]')).toHaveText('Plain notes text.');     // .txt: extracted text
  await page.locator('[data-dx-pop="sources"]').click(); await tabs.filter({hasText: 'Alpha report.docx'}).click();
  await expect(page.locator('.original-docx section.docx').first()).toBeVisible();     // back again, no re-download
  expect(state.fileRequests).toBe(1);
  expect(errors).toEqual([]);
});

test('document highlights: a citation flashes then fades; saved text is light yellow with readable text', async ({page}) => {
  const state = await setup(page);
  await page.goto('studio.html?desk=doc1&space=org');
  await expect(page.locator('.original-docx section.docx').first()).toBeVisible();
  await page.locator('[data-dx-pop="tools"]').click();await page.locator('#highlight-tool').click();
  expect(await selectInOriginal(page, 'Unicode: café')).toBe(true);
  await expect(page.locator('#highlight-hint')).toHaveText('Highlight saved.');
  await page.locator('[data-citation="a"]').last().click();
  await expectFlashThenGone(page.locator('.original-docx mark.current-citation'));
  await expectNoBorders(page, '.original-docx mark[data-viewer-mark]');
  const saved = marks(page, 'permanent-mark').first();
  await expect(saved).toHaveCSS('background-color', 'rgba(255, 213, 0, 0.28)');
  // Contrast of the text against the highlight over white paper.
  const ratio = await saved.evaluate(e => {
    const rgb = (s: string) => s.match(/[\d.]+/g)!.map(Number);
    const [r, g, b, a = 1] = rgb(getComputedStyle(e).backgroundColor), bg = [r, g, b].map(c => c * a + 255 * (1 - a));
    const lum = (c: number[]) => { const [R, G, B] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * R + 0.7152 * G + 0.0722 * B; };
    const fg = rgb(getComputedStyle(e).color).slice(0, 3), [L1, L2] = [lum(bg), lum(fg)].sort((x, y) => y - x);
    return (L1 + 0.05) / (L2 + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
  expect(state.annotations).toHaveLength(1);
});

test('extracted text: a citation flashes then fades, and saved highlights keep no underline', async ({page}) => {
  await setup(page, {hasOriginal: false});
  await page.goto('studio.html?desk=doc1&space=org');
  await page.locator('[data-citation="a"]').last().click();
  await expectFlashThenGone(page.locator('[data-page-text] mark.current-citation'));
  await expectNoBorders(page, '[data-page-text] mark');
});
