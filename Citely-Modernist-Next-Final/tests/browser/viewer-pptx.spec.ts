import {test, expect, Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {signedIn} from './mock-api';
import {expectFlashThenGone, expectNoBorders} from './highlight-style';

// Real decks: atlas_board_update.pptx (the regression deck: bullets, a table,
// two text boxes on one slide), adversarial.pptx (one sentence repeated on
// twelve slides) and sample.pptx. Citation anchors below are what the backend
// produced for them in scripts/office_regression.py.
const FX = path.join(__dirname, '..', 'fixtures', 'pptx');
const SNAPSHOT = JSON.parse(readFileSync(path.join(FX, 'native-units.json'), 'utf8')).units;
const DECKS: Record<string, {file: string; name: string; slides: number}> = {
  doc1: {file: 'atlas_board_update.pptx', name: 'Atlas deck.pptx', slides: 8},
  doc2: {file: 'adversarial.pptx', name: 'Repeated deck.pptx', slides: 3},
};
const cite = (doc: string, id: string, anchor: any, extra: any = {}) => ({
  citation_id: id, document_id: doc, evidence_role: 'cited', page: anchor.slide_index + 1, content: anchor.quote || 'row',
  quote: anchor.quote || 'row', extraction_version: 'v1', anchor: {format: 'pptx', ...anchor}, ...extra});
const CITATIONS: Record<string, any[]> = {
  doc1: [
    cite('doc1', 'p01', {slide_index: 1, shape_id: 3, quote: 'On-time delivery reached 96.4%, up from 93.8% a year ago.', offset: 0}),
    cite('doc1', 'p02', {slide_index: 1, shape_id: 3, quote: 'The Rotterdam cross-dock opened in May and now handles 1,150 pallets a day.', offset: 58}),
    cite('doc1', 'p03', {slide_index: 2, shape_id: 3, row: 4, cells: [[4, 0], [4, 1], [4, 2]]}),
    cite('doc1', 'p04', {slide_index: 2, shape_id: 3, row: 3, col: 2, quote: '74%', offset: 0}),
    cite('doc1', 'p06', {slide_index: 3, shape_id: 4, quote: 'Driver attrition in the Nordics is 19%', offset: 0}),
    cite('doc1', 'p10', {slide_index: 6, shape_id: 3, quote: 'Lost-time injuries fell to 0.8 per million hours worked.', offset: 35}),
    cite('doc1', 'stale', {slide_index: 3, shape_id: 3, quote: 'a sentence this shape never contained', offset: 0}),
    cite('doc1', 'old', {slide_index: 5, shape_id: 3, quote: 'Capex budget for FY2026: €12.5 million.', offset: 0}, {extraction_version: 'old'}),
    cite('doc1', 'ghost', {slide_index: 5, shape_id: 99, quote: 'Capex', offset: 0}),
  ],
  doc2: [],
};

async function setup(page: Page) {
  const state: any = {annotations: [] as any[], viewerRequests: 0, errors: [] as string[]};
  page.on('request', r => { if (r.url().includes('/viewers/pptx.js')) state.viewerRequests++; });
  page.on('pageerror', e => state.errors.push(e.message));
  await signedIn(page);
  await page.route(/127\.0\.0\.1:8000/, async route => {
    const req = route.request(), p = decodeURIComponent(new URL(req.url()).pathname), m = req.method();
    const json = (data: any, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(data)});
    const docId = Object.keys(DECKS).find(id => p.includes('/' + id + '/') || p.endsWith('/' + id)) || p.match(/org:(doc\d)/)?.[1];
    if (p === '/health' || p === '/ready') return json({status: 'ok', ready: true, readiness: 'ready'});
    if (p === '/warmup') return json({status: 'warm'});
    if (p === '/documents') return json([...Object.entries(DECKS).map(([id, d]) => ({id, filename: d.name, pages: d.slides, ingested_at: '2026-10-01', has_original: true, original_compatible: true})),
                                         {id: 'doc9', filename: 'Notes.txt', pages: 1, ingested_at: '2026-10-01', has_original: true, original_compatible: true}]);
    if (docId && p.endsWith('/file')) return route.fulfill({status: 200, contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', body: readFileSync(path.join(FX, DECKS[docId].file))});
    if (p.endsWith('/pages')) return json(docId ? Array.from({length: DECKS[docId].slides}, (_, i) => ({page: i + 1, text: `Slide ${i + 1}`, extraction_version: 'v1'})) : [{page: 1, text: 'Plain notes text.', extraction_version: 'v1'}]);
    if (p.endsWith('/history')) return json(docId && CITATIONS[docId]?.length ? [{id: 't1', question: 'Where?', answer: 'Here.', sources: CITATIONS[docId], created_at: '2026-10-01T00:00:00Z'}] : []);
    if (p.startsWith('/state/catalog')) {
      if (m === 'PUT') return json({revision: 2, updated: 'now'});
      return json({value: {orgs: [{id: 'personal', name: 'Personal', spaces: [{id: 'org', name: 'My workspace', folders: [], docs: [
        ...Object.entries(DECKS).map(([id, d]) => ({id, name: d.name, status: 'Ready', folder: null, pages: d.slides})),
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

const deck = (page: Page) => page.locator('.original-pptx');
const current = (page: Page) => deck(page).locator('.pp-mark.current-citation');
async function open(page: Page, doc: string) {
  await page.goto(`studio.html?desk=${doc}&space=org`);
  await expect(deck(page).locator('[data-slide-index]').first()).toBeVisible();
}
/** What is under each overlay: the slide it sits on and the text beneath its centre. */
const under = (page: Page, selector: string) => page.evaluate(sel => [...document.querySelectorAll<HTMLElement>(sel)].map(mark => {
  const r = mark.getBoundingClientRect();
  mark.style.visibility = 'hidden';
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement | null;
  mark.style.visibility = '';
  return {slide: hit?.closest('[data-slide-index]')?.getAttribute('data-slide-index') ?? null, text: hit?.textContent?.replace(/\s+/g, ' ').trim() ?? '', cell: !!hit?.closest('td'),
          row: hit?.closest('tr') ? [...hit.closest('table')!.querySelectorAll('tr')].indexOf(hit.closest('tr')!) : null};
}), selector);

test('a deck original opens as slides, lazily, with no errors', async ({page}) => {
  const state = await setup(page);
  await page.goto('studio.html?desk=doc9&space=org');
  await expect(page.locator('[data-page-text]')).toHaveText('Plain notes text.');
  expect(state.viewerRequests).toBe(0);
  await open(page, 'doc1');
  expect(state.viewerRequests).toBe(1);
  await expect(deck(page).locator('[data-slide-index]')).not.toHaveCount(0);
  await expect(page.locator('#paper-viewport')).not.toContainText('EXTRACTED DOCUMENT TEXT');
  expect(state.errors).toEqual([]);
});

test('every citation overlays exactly its characters, on its own slide and shape', async ({page}) => {
  const state = await setup(page);
  await open(page, 'doc1');
  for (const [id, slide, words] of [['p01', '1', 'On-time delivery'], ['p02', '1', 'Rotterdam cross-dock'], ['p06', '3', 'Driver attrition'], ['p10', '6', 'Lost-time injuries']] as const) {
    await page.locator(`[data-citation="${id}"]`).last().click();
    await expect(current(page).first(), id).toBeInViewport();
    const hits = await under(page, '.original-pptx .pp-mark.current-citation');
    expect(hits.length, id).toBeGreaterThan(0);
    for (const h of hits) { expect(h.slide, id).toBe(slide); expect(h.text, id).toContain(words.split(' ')[0]); }
  }
  // Two sentences in one shape: the second citation never covers the first.
  await page.locator('[data-citation="p02"]').last().click();
  const p02 = await under(page, '.original-pptx .pp-mark.current-citation');
  expect(p02.every(h => !h.text.startsWith('On-time'))).toBe(true);
  expect(state.errors).toEqual([]);
});

test('table citations cover exactly their cells: a cited row, or one cell', async ({page}) => {
  await setup(page);
  await open(page, 'doc1');
  await page.locator('[data-citation="p03"]').last().click();
  await expect(current(page)).toHaveCount(3);
  const row = await under(page, '.original-pptx .pp-mark.current-citation');
  expect(row.map(h => [h.slide, h.cell, h.row, h.text])).toEqual([['2', true, 4, 'DACH'], ['2', true, 4, '171'], ['2', true, 4, '90%']]);
  await page.locator('[data-citation="p04"]').last().click();
  const cell = await under(page, '.original-pptx .pp-mark.current-citation');
  expect(cell.map(h => [h.slide, h.cell, h.row, h.text])).toEqual([['2', true, 3, '74%']]);
});

test('stale, unknown and older-extraction anchors are refused, never placed elsewhere', async ({page}) => {
  await setup(page);
  await open(page, 'doc1');
  for (const id of ['stale', 'ghost', 'old']) {
    await page.locator(`[data-citation="${id}"]`).last().click();
    await expect(page.locator('#highlight-hint'), id).toContainText('cannot be highlighted here');
    await expect(current(page), id).toHaveCount(0);
  }
});

test('the viewer finds every shape and cell the backend can cite, with the same text', async ({page}) => {
  await setup(page);
  for (const [doc, file] of [['doc1', 'atlas_board_update.pptx'], ['doc2', 'adversarial.pptx']]) {
    await open(page, doc);
    const results = await page.evaluate(async units => {
      const mod = await (window as any).CitelyAPI.loadViewer('pptx');
      const root = document.querySelector('.original-pptx') as HTMLElement;
      const out: any[] = [];
      for (const [slide_index, shape_id, row, col, text] of units) {
        mod.showSlide(root, slide_index);
        await new Promise(r => setTimeout(r, 120));
        const placed = mod.setTargets(root, [{slide_index, shape_id, row, col, quote: text, classes: ['citation-range']}])[0];
        out.push({unit: `${slide_index}/${shape_id}/${row}/${col}`, placed, marks: root.querySelectorAll('.pp-mark').length});
      }
      mod.setTargets(root, []);
      return out;
    }, SNAPSHOT[file]);
    const failed = results.filter((r: any) => !r.placed || r.marks === 0);
    expect(failed, file).toEqual([]);
  }
});

test('one sentence repeated twelve times: each citation lands on its own slide, shape or cell', async ({page}) => {
  await setup(page);
  await open(page, 'doc2');
  // Every shape or cell containing the shared sentence, cited by that sentence alone.
  const SENTENCE = 'Shared evidence sentence.';
  const repeated = (SNAPSHOT['adversarial.pptx'] as any[]).filter(u => u[4].includes(SENTENCE))
    .map(([s, id, row, col, text]) => [s, id, row, col, SENTENCE, text.indexOf(SENTENCE), text]);
  expect(repeated.length).toBe(12);
  const landed = await page.evaluate(async units => {
    const mod = await (window as any).CitelyAPI.loadViewer('pptx');
    const root = document.querySelector('.original-pptx') as HTMLElement;
    const out: any[] = [];
    for (const [slide_index, shape_id, row, col, quote, offset] of units) {
      const target = {slide_index, shape_id, row, col, quote, offset, classes: ['current-citation'], active: true};
      mod.reveal(root, target);
      mod.setTargets(root, [target]);
      await new Promise(r => setTimeout(r, 250));
      const marks = [...root.querySelectorAll<HTMLElement>('.pp-mark')];
      const b = marks[0].getBoundingClientRect();
      marks.forEach(m => { m.style.visibility = 'hidden'; });
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) as HTMLElement;
      const tr = hit?.closest('tr');
      out.push([hit?.closest('[data-slide-index]')?.getAttribute('data-slide-index'), tr ? [...tr.closest('table')!.querySelectorAll('tr')].indexOf(tr) : null,
                tr ? [...tr.children].indexOf(hit.closest('td')!) : null, (hit?.closest('div')?.textContent || '').replace(/\s+/g, ' ').trim(), marks.length]);
    }
    return out;
  }, repeated);
  landed.forEach(([slide, row, col, text, marks]: any, i: number) => {
    const [s, , r, c, , , full] = repeated[i];
    expect(slide, `#${i}`).toBe(String(s));
    expect([row, col], `#${i}`).toEqual([r, c]);
    if (r === null) expect(text, `#${i}`).toContain(String(full).split(':')[0]);   // the left or right box, not its twin
    expect(marks, `#${i}`).toBeGreaterThan(0);
  });
});

test('a highlight made on a slide is saved as a shape anchor and survives a reload; one spanning two shapes is refused', async ({page}) => {
  const state = await setup(page);
  await open(page, 'doc1');
  await page.locator('[data-citation="p06"]').last().click();                 // brings slide 4 into view
  await expect(current(page).first()).toBeInViewport();
  await page.locator('[data-dx-pop="tools"]').click();await page.locator('#highlight-tool').click();
  const select = (from: string, to: string) => page.evaluate(([a, b]) => {
    const slide = document.querySelector('.original-pptx [data-slide-index="3"]')!;
    const w = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT); let n: Node | null, start: [Node, number] | null = null, end: [Node, number] | null = null;
    while ((n = w.nextNode())) { const v = n.nodeValue!; if (!start && v.includes(a)) start = [n, v.indexOf(a)]; if (v.includes(b)) end = [n, v.indexOf(b) + b.length]; }
    const r = document.createRange(); r.setStart(...start!); r.setEnd(...end!);
    const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
    document.querySelector('#paper')!.dispatchEvent(new Event('pointerup', {bubbles: true}));
  }, [from, to]);
  await select('hedging covers', '60%');
  await expect(page.locator('#highlight-hint')).toHaveText('Highlight saved.');
  expect(state.annotations[0]).toMatchObject({kind: 'manual-highlight', page_number: 4, extraction_version: 'v1',
    anchor: {format: 'pptx', slide_index: 3, shape_id: 3, row: null, col: null, quote: 'hedging covers 60%', occurrence: 0}});
  await expect(page.locator('.highlight-card small').first()).toContainText('Slide 4');
  await select('Fuel price', 'Driver attrition');                             // two text boxes
  await expect(page.locator('#highlight-hint')).toContainText('within one text box');
  expect(state.annotations).toHaveLength(1);
  await page.reload();
  await expect(deck(page).locator('[data-slide-index]').first()).toBeVisible();
  await page.locator('[data-dx-tab="hls"]').click();await page.locator('[data-annotation="h1"]').click();
  await expect(deck(page).locator('.pp-mark.permanent-mark').first()).toBeInViewport();
  const saved = await under(page, '.original-pptx .pp-mark.permanent-mark');
  expect(saved.every(h => h.slide === '3')).toBe(true);
});

test('highlights stay on their characters after zooming', async ({page}) => {
  await setup(page);
  await open(page, 'doc1');
  await page.locator('[data-citation="p10"]').last().click();
  await expect(current(page).first()).toBeInViewport();
  const before = await current(page).first().boundingBox();
  // The View menu stays open while zooming, so both steps happen in one visit.
  await page.locator('[data-dx-pop="view"]').click();await page.locator('[data-zoom="10"]').click();
  await expect(page.locator('#dx-pop-view')).toBeVisible();
  await page.locator('[data-zoom="10"]').click();
  await expect.poll(async () => (await current(page).first().boundingBox())?.width ?? 0).toBeGreaterThan(before!.width * 1.1);
  await expect(current(page).first()).toBeInViewport();                          // zooming keeps the citation in view
  const hits = await under(page, '.original-pptx .pp-mark.current-citation');
  expect(hits.every(h => h.slide === '6' && /Lost-time|injuries|million|hours|worked|0\.8/.test(h.text))).toBe(true);
});

test('slide highlights: a citation flashes then fades, overlays never stack, no borders', async ({page}) => {
  const state = await setup(page);
  state.annotations.push({id: 'h1', document_id: 'doc1', kind: 'manual-highlight', page_number: 2, quote: 'Rotterdam cross-dock', extraction_version: 'v1',
    anchor: {format: 'pptx', slide_index: 1, shape_id: 3, row: null, col: null, quote: 'Rotterdam cross-dock', occurrence: 0}, conversation_id: 'x', created_at: 'n', updated_at: 'n'});
  await open(page, 'doc1');
  await page.locator('[data-citation="p02"]').last().click();
  const mark = current(page).first();
  await expect(mark).toBeInViewport();
  await expectFlashThenGone(mark);
  await expectNoBorders(page, '.original-pptx .pp-mark');
  // One box per line: no point on the slide is covered by two overlays of the same passage.
  const overlaps = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll<HTMLElement>('.original-pptx .pp-mark.citation-range')].map(m => m.getBoundingClientRect());
    let n = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) n++;
    }
    return n;
  });
  expect(overlaps).toBe(0);
  const saved = deck(page).locator('.pp-mark.permanent-mark').first();
  await expect(saved).toHaveCSS('background-color', 'rgba(255, 213, 0, 0.28)');
});

test('opening a slide citation does not claim its location is unavailable', async ({page}) => {
  await setup(page);
  await open(page, 'doc1');
  await page.locator('[data-citation="p01"]').last().click();
  await expect(current(page).first()).toBeInViewport();
  await expect(page.locator('#toast')).not.toHaveText('Precise passage location unavailable.');
  await expect(page.locator('#highlight-hint')).not.toContainText('unavailable');
});
