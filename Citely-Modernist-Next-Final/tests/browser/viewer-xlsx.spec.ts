import {test, expect, Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {signedIn} from './mock-api';
import {expectFlashThenGone, expectNoBorders} from './highlight-style';

// Real workbooks: sample.xlsx (date, 120-column and 5,000-row sheets, a
// chart), merge_formula_cached.xlsx (six merges, formulas with saved results),
// merge_formula.xlsx (the same formulas never calculated) and oversized.xlsx
// (a 2,000-row merge, and a 60-column merge on a 260-column sheet).
const FX = path.join(__dirname, '..', 'fixtures', 'xlsx');
const BOOKS: Record<string, {file: string; name: string; sheets: string[]}> = {
  doc1: {file: 'sample.xlsx', name: 'Sample book.xlsx', sheets: ['Summary', 'Wide', 'Large']},
  doc2: {file: 'merge_formula_cached.xlsx', name: 'Merges book.xlsx', sheets: ['Merges', 'Formulas']},
  doc3: {file: 'merge_formula.xlsx', name: 'Uncalculated book.xlsx', sheets: ['Merges', 'Formulas']},
  doc4: {file: 'oversized.xlsx', name: 'Oversized book.xlsx', sheets: ['Tall', 'Wide']},
};
const cite = (doc: string, id: string, sheet: string, range: string, extra: any = {}) => {
  const sheet_index = BOOKS[doc].sheets.indexOf(sheet);
  return {citation_id: id, document_id: doc, evidence_role: 'cited', page: sheet_index + 1, content: `${sheet}!${range}`, quote: `${sheet}!${range}`,
          extraction_version: 'v1', anchor: {format: 'xlsx', sheet_name: sheet, sheet_index, range}, ...extra};
};
const CITATIONS: Record<string, any[]> = {
  doc1: [cite('doc1', 'merged', 'Summary', 'A8:C8'), cite('doc1', 'date', 'Summary', 'B5'), cite('doc1', 'number', 'Summary', 'B2'),
         cite('doc1', 'deep', 'Large', 'C5000'), cite('doc1', 'far', 'Wide', 'DP59'),
         cite('doc1', 'stale', 'Summary', 'B3', {extraction_version: 'old'})],
  doc2: [cite('doc2', 'cached', 'Formulas', 'B8'), cite('doc2', 'zero', 'Formulas', 'B9'), cite('doc2', 'error', 'Formulas', 'B10'),
         cite('doc2', 'm1', 'Merges', 'B1:D1'), cite('doc2', 'm2', 'Merges', 'B5:B9'), cite('doc2', 'm3', 'Merges', 'C12:D15'),
         cite('doc2', 'm4', 'Merges', 'B100:B180'), cite('doc2', 'm5', 'Merges', 'C300:D360'), cite('doc2', 'm6', 'Merges', 'B700:D702'),
         cite('doc2', 'row', 'Formulas', 'A8:B8', {anchor: {format: 'xlsx', sheet_name: 'Formulas', sheet_index: 1, range: 'A8:B8', cells: ['B8']}})],
  doc3: [],
  doc4: [cite('doc4', 'tall', 'Tall', 'B10:B2009'), cite('doc4', 'wide', 'Wide', 'D5:BK5')],
};

async function setup(page: Page) {
  const state: any = {annotations: [] as any[], viewerRequests: 0, consoleErrors: [] as string[]};
  page.on('request', r => { if (r.url().includes('/viewers/xlsx.js')) state.viewerRequests++; });
  page.on('console', m => { if (m.type() === 'error' && /AG Grid|ag-grid/i.test(m.text())) state.consoleErrors.push(m.text()); });
  page.on('pageerror', e => state.consoleErrors.push(e.message));
  await signedIn(page);
  await page.route(/127\.0\.0\.1:8000/, async route => {
    const req = route.request(), p = decodeURIComponent(new URL(req.url()).pathname), m = req.method();
    const json = (data: any, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(data)});
    const docId = Object.keys(BOOKS).find(id => p.includes('/' + id + '/') || p.endsWith('/' + id)) || p.match(/org:(doc\d)/)?.[1];
    if (p === '/health' || p === '/ready') return json({status: 'ok', ready: true, readiness: 'ready'});
    if (p === '/warmup') return json({status: 'warm'});
    if (p === '/documents') return json([...Object.entries(BOOKS).map(([id, b]) => ({id, filename: b.name, pages: b.sheets.length, ingested_at: '2026-10-01', has_original: true, original_compatible: true})),
                                         {id: 'doc9', filename: 'Notes.txt', pages: 1, ingested_at: '2026-10-01', has_original: true, original_compatible: true}]);
    if (docId && p.endsWith('/file')) return route.fulfill({status: 200, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: readFileSync(path.join(FX, BOOKS[docId].file))});
    if (p.endsWith('/pages')) return json(docId ? BOOKS[docId].sheets.map((s, i) => ({page: i + 1, text: `Sheet: ${s}`, extraction_version: 'v1'})) : [{page: 1, text: 'Plain notes text.', extraction_version: 'v1'}]);
    if (p.endsWith('/history')) return json(docId && CITATIONS[docId].length ? [{id: 't1', question: 'Where?', answer: 'Here.', sources: CITATIONS[docId], created_at: '2026-10-01T00:00:00Z'}] : []);
    if (p.startsWith('/state/catalog')) {
      if (m === 'PUT') return json({revision: 2, updated: 'now'});
      return json({value: {orgs: [{id: 'personal', name: 'Personal', spaces: [{id: 'org', name: 'My workspace', folders: [], docs: [
        ...Object.entries(BOOKS).map(([id, b]) => ({id, name: b.name, status: 'Ready', folder: null, pages: b.sheets.length})),
        {id: 'doc9', name: 'Notes.txt', status: 'Ready', folder: null, pages: 1}]}]}]}, revision: 1});
    }
    if (p.startsWith('/state/')) return json(m === 'PUT' ? {revision: 1, updated: 'now'} : {value: null, revision: 0});
    if (p.endsWith('/annotations')) {
      if (m === 'POST') { const a = {...req.postDataJSON(), id: 'h' + (state.annotations.length + 1), conversation_id: 'x', created_at: 'n', updated_at: 'n'}; state.annotations.push(a); return json(a, 201); }
      return json(state.annotations);
    }
    if (p.endsWith('/notes/versions')) return json([]);
    if (p.endsWith('/notes')) return json({conversation_id: 'x', workspace_id: 'org', content: '', revision: 0});
    return json({detail: 'unexpected ' + p}, 404);
  });
  return state;
}

const grid = (page: Page) => page.locator('.original-xlsx');
const cell = (page: Page, row: number, col: number) => grid(page).locator(`.ag-row[row-index="${row}"] .ag-cell[col-id="c${col}"]`);
const viewport = (page: Page) => grid(page).locator('.ag-grid-viewport');
const current = (page: Page) => grid(page).locator('.ag-cell.current-citation, .xl-merge-box.current-citation');
const tab = (page: Page, name: string) => grid(page).locator('.xl-tabs button', {hasText: name});
async function open(page: Page, doc: string) {
  await page.goto(`studio.html?desk=${doc}&space=org`);
  await expect(grid(page).locator('.ag-row').first()).toBeVisible();
}

test('a spreadsheet original opens as a grid with sheet tabs, column letters and row numbers, lazily', async ({page}) => {
  const state = await setup(page);
  await page.goto('studio.html?desk=doc9&space=org');
  await expect(page.locator('[data-page-text]')).toHaveText('Plain notes text.');
  expect(state.viewerRequests).toBe(0);
  await open(page, 'doc1');
  expect(state.viewerRequests).toBe(1);
  await expect(grid(page).locator('.xl-tabs button')).toHaveText(['Summary', 'Wide', 'Large']);
  await expect(tab(page, 'Summary')).toHaveAttribute('aria-selected', 'true');
  await expect(grid(page).locator('.ag-header-cell[col-id="c0"]')).toHaveText('A');
  await expect(grid(page).locator('.ag-row[row-index="0"] .ag-cell[col-id="rownum"]')).toHaveText('1');
  await expect(page.locator('#paper-viewport')).not.toContainText('EXTRACTED DOCUMENT TEXT');
  expect(state.consoleErrors).toEqual([]);
});

test('every citation highlights exactly one visible cell, on the right sheet, far rows and columns included', async ({page}) => {
  const state = await setup(page);
  for (const [doc, cases] of Object.entries({
    doc1: [['merged', 'Summary', 'CITATION_TARGET_MERGED'], ['date', 'Summary', '2026-03-31'], ['number', 'Summary', '1240000'],
           ['deep', 'Large', '7500'], ['far', 'Wide', '7080']],
    doc2: [['cached', 'Formulas', '12345'], ['zero', 'Formulas', '0'], ['error', 'Formulas', '#DIV/0!'], ['m4', 'Merges', 'VERT_MERGE_LONG']],
  })) {
    await open(page, doc);
    for (const [id, sheet, text] of cases) {
      await page.locator(`[data-citation="${id}"]`).last().click();
      await expect(tab(page, sheet), id).toHaveAttribute('aria-selected', 'true');
      await expect(current(page), id).toHaveCount(1);
      await expect(current(page), id).toHaveText(text);
      await expect(current(page), id).toBeInViewport();
    }
  }
  expect(state.consoleErrors).toEqual([]);
});

test('a citation narrowed to one cell lights that cell, not the whole row', async ({page}) => {
  await setup(page);
  await open(page, 'doc2');
  await page.locator('[data-citation="row"]').last().click();
  await expect(current(page)).toHaveCount(1);
  await expect(current(page)).toHaveText('12345');
});

test('merged cells: one highlight per merge, the merge owns its whole area, and tall merges stay visible when scrolled into', async ({page}) => {
  await setup(page);
  await open(page, 'doc2');
  for (const [id, range] of [['m1', 'B1:D1'], ['m2', 'B5:B9'], ['m3', 'C12:D15'], ['m4', 'B100:B180'], ['m5', 'C300:D360'], ['m6', 'B700:D702']]) {
    await page.locator(`[data-citation="${id}"]`).last().click();
    await expect(current(page), range).toHaveCount(1);
    await expect(current(page), range).toBeInViewport();
    // Sample a 5×5 lattice inside the merge's visible area: every point must
    // land on the merge itself, never on a covered cell drawn over it.
    const owned = await current(page).evaluate(el => {
      const r = el.getBoundingClientRect(), view = el.closest('.ag-grid-viewport')!.getBoundingClientRect();
      const header = el.closest('.original-xlsx')!.querySelector('.ag-header')!.getBoundingClientRect();
      const top = Math.max(r.top, header.bottom), bottom = Math.min(r.bottom, view.bottom);
      let hits = 0;
      for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) {
        const hit = document.elementFromPoint(r.left + (r.width * i) / 6, top + ((bottom - top) * j) / 6);
        if (hit && (hit === el || el.contains(hit))) hits++;
      }
      return hits;
    });
    expect(owned, range).toBe(25);
  }
  // Scrolled into the middle of B100:B180, its anchor row is long gone but the merge must still show.
  await page.locator('[data-citation="m4"]').last().click();
  await viewport(page).evaluate(el => { el.scrollTop = 139 * 24; });
  await expect(grid(page).locator('.ag-cell.xl-merge', {hasText: 'VERT_MERGE_LONG'})).toBeInViewport();
  // The tallest merge is 81 rows: that sheet renders a bounded number of rows, a plain sheet the default.
  const rendered = await grid(page).locator('.ag-row').count();
  expect(rendered).toBeLessThan(400);
  await tab(page, 'Formulas').click();
  await expect(grid(page).locator('.ag-row')).toHaveCount(11);
});

test('merges too tall or too wide for the grid are drawn by the overlay and stay visible anywhere inside them', async ({page}) => {
  const state = await setup(page);
  await open(page, 'doc4');
  await page.locator('[data-citation="tall"]').last().click();
  const tall = grid(page).locator('.xl-merge-box[data-range="B10:B2009"]');
  await expect(tall).toHaveClass(/current-citation/);
  await expect(tall.locator('span')).toHaveText('TALL_MERGE');
  await expect(tall.locator('span')).toBeInViewport();
  await viewport(page).evaluate(el => { el.scrollTop = 1500 * 24; });
  await expect(grid(page).locator('.ag-cell[col-id="c0"]', {hasText: 'row 1501'})).toBeVisible();
  await expect(tall.locator('span')).toBeInViewport();                     // label follows into view
  await page.locator('[data-citation="wide"]').last().click();
  await expect(tab(page, 'Wide')).toHaveAttribute('aria-selected', 'true');
  const wide = grid(page).locator('.xl-merge-box[data-range="D5:BK5"]');
  await expect(wide).toHaveClass(/current-citation/);
  await viewport(page).evaluate(el => { el.scrollLeft = 40 * 100; });
  await expect(wide).toBeInViewport();                                     // anchor column D virtualized away
  expect(state.consoleErrors).toEqual([]);
});

test('formulas without a saved result show —, never a fake zero', async ({page}) => {
  await setup(page);
  await open(page, 'doc3');
  await tab(page, 'Formulas').click();
  await expect(cell(page, 7, 1)).toHaveText('—');
  await expect(cell(page, 7, 1).locator('span')).toHaveAttribute('title', /no saved result/);
  await expect(cell(page, 2, 1)).toHaveText('0');                          // a literal zero is still 0
});

test('a stale citation is refused, and highlights never leak onto another sheet', async ({page}) => {
  await setup(page);
  await open(page, 'doc1');
  await page.locator('[data-citation="stale"]').last().click();
  await expect(current(page)).toHaveCount(0);
  await expect(page.locator('#highlight-hint')).toContainText('cannot be highlighted here');
  await page.locator('[data-citation="number"]').last().click();
  await expect(current(page)).toHaveCount(1);
  await tab(page, 'Wide').click();
  // Nothing from Summary is painted here; Wide's only citation is DP59.
  await expect(grid(page).locator('.ag-row')).not.toHaveCount(0);
  await expect(grid(page).locator('.ag-cell.citation-range:not([col-id="c119"]), .ag-cell.current-citation')).toHaveCount(0);
});

test('mouse selection saves a cell highlight that survives a reload', async ({page}) => {
  const state = await setup(page);
  await open(page, 'doc2');
  await tab(page, 'Formulas').click();
  await page.locator('[data-dx-pop="tools"]').click();await page.locator('#highlight-tool').click();
  const a2 = await cell(page, 1, 0).boundingBox(), b5 = await cell(page, 4, 1).boundingBox();
  await page.mouse.move(a2!.x + 10, a2!.y + 8);
  await page.mouse.down();
  await page.mouse.move(b5!.x + 10, b5!.y + 8, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('#highlight-hint')).toHaveText('Highlight saved.');
  expect(state.annotations[0]).toMatchObject({kind: 'manual-highlight', document_id: 'doc2', page_number: 2, extraction_version: 'v1',
    anchor: {format: 'xlsx', sheet_name: 'Formulas', sheet_index: 1, range: 'A2:B5'}});
  expect(state.annotations[0].quote.split('\n')).toHaveLength(4);
  await expect(page.locator('.highlight-card small').first()).toContainText('Formulas A2:B5');
  await page.reload();
  await expect(grid(page).locator('.ag-row').first()).toBeVisible();
  await page.locator('[data-dx-tab="hls"]').click();await page.locator('[data-annotation="h1"]').click();
  await expect(tab(page, 'Formulas')).toHaveAttribute('aria-selected', 'true');
  await expect(grid(page).locator('.ag-cell.permanent-mark')).toHaveCount(8);
});

test('a click inside a merge selects the whole merge; keyboard selection extends with Shift and saves with Enter', async ({page}) => {
  const state = await setup(page);
  await open(page, 'doc2');
  await tab(page, 'Merges').click();                                        // the desk opens on its first citation's sheet
  await page.locator('[data-dx-pop="tools"]').click();await page.locator('#highlight-tool').click();
  await cell(page, 4, 1).click();                                           // B5, the anchor of B5:B9
  await expect(page.locator('.highlight-card')).toHaveCount(1);
  expect(state.annotations[0].anchor.range).toBe('B5:B9');
  await tab(page, 'Formulas').click();
  await cell(page, 1, 0).click();                                           // A2: saved as a single cell
  await expect(page.locator('.highlight-card')).toHaveCount(2);
  expect(state.annotations[1].anchor.range).toBe('A2');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(grid(page).locator('.ag-cell.xl-selected')).toHaveCount(8);
  await page.keyboard.press('Enter');
  await expect(page.locator('.highlight-card')).toHaveCount(3);
  expect(state.annotations[2].anchor.range).toBe('A2:B5');
  await page.keyboard.press('ArrowDown');                                   // a plain move collapses the selection
  await expect(grid(page).locator('.ag-cell.xl-selected')).toHaveCount(1);
});

test('the grid keeps its scroll position when the workspace re-renders', async ({page}) => {
  await setup(page);
  await open(page, 'doc1');
  await tab(page, 'Large').click();
  await viewport(page).evaluate(el => { el.scrollTop = 2000 * 24; });
  await expect(grid(page).locator('.ag-cell[col-id="c0"]', {hasText: /^2001$/})).toBeVisible();
  await page.locator('[data-dx-pop="tools"]').click();await page.locator('#highlight-tool').click();                           // any action that re-renders the pane
  await page.locator('[data-dx-pop="tools"]').click();await page.locator('#highlight-tool').click();
  await expect(grid(page).locator('.ag-cell[col-id="c0"]', {hasText: /^2001$/})).toBeInViewport();
});

test('dark mode keeps the sheet white; zoom scales rows', async ({page}) => {
  await setup(page);
  await open(page, 'doc1');
  await page.locator('button.dx-avatar').click();await page.locator(`#dx-pop-account [data-theme-choice="${await page.evaluate(()=>document.body.dataset.mode==='dark'?'light':'dark')}"]`).click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'dark');
  const bg = await grid(page).evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(255, 255, 255)');
  const before = await cell(page, 1, 0).boundingBox();
  // The View menu stays open while zooming, so both steps happen in one visit.
  await page.locator('[data-dx-pop="view"]').click();await page.locator('[data-zoom="10"]').click();
  await expect(page.locator('#dx-pop-view')).toBeVisible();
  await page.locator('[data-zoom="10"]').click();
  await expect.poll(async () => (await cell(page, 1, 0).boundingBox())!.height).toBeGreaterThan(before!.height * 1.15);
});


test('moving on while a highlight is saving keeps the new selection', async ({page}) => {
  const state = await setup(page);
  await page.route(/127\.0\.0\.1:8000\/conversations\/.*\/annotations/, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    await new Promise(r => setTimeout(r, 700));                              // a slow save
    return route.fallback();
  });
  await open(page, 'doc2');
  await tab(page, 'Formulas').click();
  await page.locator('[data-dx-pop="tools"]').click();await page.locator('#highlight-tool').click();
  await cell(page, 1, 0).click();                                           // saves A2 (slowly)
  await page.keyboard.press('ArrowDown');                                   // reader moves on to A3 at once
  await expect(page.locator('.highlight-card')).toHaveCount(1);
  expect(state.annotations[0].anchor.range).toBe('A2');
  await expect(grid(page).locator('.ag-cell.xl-selected')).toHaveCount(1);  // A3 is still selected
});

test('cell highlights: a citation flashes then fades; saved cells are light yellow; no borders', async ({page}) => {
  const state = await setup(page);
  state.annotations.push({id: 'h1', document_id: 'doc1', kind: 'manual-highlight', page_number: 1, quote: 'Revenue', extraction_version: 'v1',
    anchor: {format: 'xlsx', sheet_name: 'Summary', sheet_index: 0, range: 'A2'}, conversation_id: 'x', created_at: 'n', updated_at: 'n'});
  await open(page, 'doc1');
  await page.locator('[data-citation="number"]').last().click();
  await expect(current(page)).toHaveCount(1);
  await expectFlashThenGone(current(page));
  await expectNoBorders(page, '.original-xlsx .ag-cell.current-citation, .original-xlsx .ag-cell.permanent-mark', '.original-xlsx .ag-row[row-index="5"] .ag-cell[col-id="c0"]');
  await expect(cell(page, 1, 0)).toHaveCSS('background-color', 'rgb(255, 243, 184)');
  // Other cited cells are not painted blue at all.
  await expect(cell(page, 4, 1)).not.toHaveCSS('background-color', 'rgb(232, 240, 255)');
});
