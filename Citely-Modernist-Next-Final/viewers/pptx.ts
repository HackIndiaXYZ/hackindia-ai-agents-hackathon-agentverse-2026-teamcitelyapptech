// Lazily loaded slide viewer: @aiden0z/pptx-renderer draws the deck; only
// fetched when a .pptx original is opened.
//
// Citations name a shape by its cNvPr id (the renderer's text-index nodeId),
// optionally a table cell, and the exact characters cited. The renderer marks
// only slides in its DOM, so a shape is found structurally: table cells by
// table order → row → cell, text shapes by their text and their position in
// the model, with ambiguous positions refused. Highlights are overlays drawn
// from a DOM Range over exactly the cited characters, re-drawn whenever the
// renderer re-renders (zoom, resize, slides mounting while scrolling).
import {
  PptxViewer, parseZip, buildPresentation, buildTextIndex, renderSlide, RECOMMENDED_ZIP_LIMITS,
  type TextIndexEntry, type PresentationData,
} from '@aiden0z/pptx-renderer';
import { mergeLineRects } from '../lib/rects.mjs';

export type Target = {
  slide_index: number; shape_id: number; row?: number | null; col?: number | null; cells?: [number, number][];
  quote?: string; offset?: number | null; occurrence?: number; classes: string[]; active?: boolean;
};
export type SlideAnchor = {
  format: 'pptx'; slide_index: number; shape_id: number; row: number | null; col: number | null; quote: string; occurrence: number;
};

type State = {
  viewer: PptxViewer; pres: PresentationData; index: TextIndexEntry[];
  root: HTMLElement; host: HTMLElement; layer: HTMLElement; targets: Target[];
  pending: Target | null; scroll: { top: number; left: number }; resize: ResizeObserver; zoom: number;
};
const states = new WeakMap<HTMLElement, State>();
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
// The renderer lays each paragraph out as its own element with nothing between
// them, so "ago.\nThe" in the model reads "ago.The" in the DOM. Text is
// therefore compared with all whitespace removed.
const squash = (s: string) => s.replace(/\s+/g, '');
/** `text` without whitespace, plus each kept character's index in `text`. */
function squashMap(text: string) {
  let out = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) { out += text[i]; at.push(i); }
  return { text: out, at };
}

function entryFor(st: State, t: { slide_index: number; shape_id: number; row?: number | null; col?: number | null }) {
  return st.index.find(e => e.slideIndex === t.slide_index && Number(e.nodeId) === t.shape_id &&
    (t.row != null && t.col != null ? e.textKind === 'table-cell' && e.rowIndex === t.row && e.cellIndex === t.col
      : t.row != null ? e.textKind === 'table-cell' && e.rowIndex === t.row : e.textKind === 'shape'));
}

const slideEl = (st: State, i: number) => st.host.querySelector<HTMLElement>(`[data-slide-index="${i}"]`);

/** The nth table on a slide is the nth table node in the model's order. */
function tableEl(st: State, slide: number, shapeId: number) {
  const el = slideEl(st, slide);
  if (!el) return null;
  const ids = [...new Set(st.index.filter(e => e.slideIndex === slide && e.textKind === 'table-cell').map(e => Number(e.nodeId)))];
  const at = ids.indexOf(shapeId);
  return at < 0 ? null : el.querySelectorAll('table')[at] || null;
}
const cellEl = (st: State, slide: number, shapeId: number, row: number, col: number) =>
  (tableEl(st, slide, shapeId)?.querySelectorAll('tr')[row]?.children[col] as HTMLElement | undefined) || null;

/** A text shape's element: same text, nearest the model position; refused
 *  when two unrelated elements are equally near. */
function shapeEl(st: State, entry: TextIndexEntry): HTMLElement | null {
  const slide = slideEl(st, entry.slideIndex);
  if (!slide) return null;
  const want = squash(entry.text);
  const box = slide.getBoundingClientRect(), scale = box.width / st.pres.width;
  const at = { x: box.left + entry.bounds.x * scale, y: box.top + entry.bounds.y * scale };
  const scored = [...slide.querySelectorAll<HTMLElement>('div,p,span')]
    .filter(el => !el.closest('table') && squash(visibleText(el)) === want)
    .map(el => { const b = el.getBoundingClientRect(); return { el, d: Math.hypot(b.left - at.x, b.top - at.y) }; })
    .sort((a, b) => a.d - b.d);
  if (!scored.length) return null;
  // Nested elements share a position; prefer the outermost at the best spot.
  const best = scored[0], rivals = scored.filter(s => s.d - best.d < 2 && !best.el.contains(s.el) && !s.el.contains(best.el));
  if (rivals.length > 1 || best.d > 40 * scale + 40) return null;
  let el = best.el;
  while (el.parentElement && el.parentElement !== slide && squash(visibleText(el.parentElement)) === want) el = el.parentElement;
  return el;
}

/** Elements a target covers, or null when it cannot be placed. */
function elementsOf(st: State, t: Target): HTMLElement[] | null {
  if (t.cells?.length) {
    const els = t.cells.map(([r, c]) => cellEl(st, t.slide_index, t.shape_id, r, c));
    return els.every(Boolean) ? (els as HTMLElement[]) : null;
  }
  if (t.row != null && t.col != null) { const el = cellEl(st, t.slide_index, t.shape_id, t.row, t.col); return el ? [el] : null; }
  if (t.row != null) {
    const tr = tableEl(st, t.slide_index, t.shape_id)?.querySelectorAll('tr')[t.row];
    return tr ? ([...tr.children] as HTMLElement[]) : null;
  }
  const entry = entryFor(st, t), el = entry && shapeEl(st, entry);
  return el ? [el] : null;
}

// Bullets and auto-numbers are drawn as a leading span of their own in each
// paragraph ("• ", "1. "); they are not part of the slide's text.
const MARKER = /^\s*(?:[•◦▪▫‣⁃○●■□➢➤✓✔–—*·\-]|\d{1,3}[.)]|[a-zA-Z][.)]|[ivxlcIVXLC]{1,5}[.)])\s*$/;
function isMarker(node: Node) {
  const span = node.parentElement;
  return !!span && span.parentElement?.firstElementChild === span && !!span.nextElementSibling && MARKER.test(node.nodeValue || '');
}
const visibleText = (el: HTMLElement) => textNodes(el).raw;

function textNodes(el: HTMLElement) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: n => (isMarker(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const nodes: { node: Text; start: number }[] = [];
  let raw = '', n: Node | null;
  while ((n = walker.nextNode())) { nodes.push({ node: n as Text, start: raw.length }); raw += n.nodeValue; }
  return { raw, nodes };
}

/** A Range over the `occurrence`th appearance of `quote` in `el`, matched with
 *  whitespace ignored. */
function quoteRange(el: HTMLElement, quote: string, occurrence: number): Range | null {
  const { raw, nodes } = textNodes(el), map = squashMap(raw), needle = squash(quote);
  if (!needle) return null;
  let at = -1;
  for (let i = 0; i <= occurrence; i++) { at = map.text.indexOf(needle, at + 1); if (at < 0) return null; }
  const start = map.at[at], end = map.at[at + needle.length - 1] + 1;
  const locate = (pos: number, isEnd: boolean) => {
    for (let i = nodes.length - 1; i >= 0; i--) if (isEnd ? nodes[i].start < pos : nodes[i].start <= pos) return { node: nodes[i].node, offset: pos - nodes[i].start };
    return null;
  };
  const a = locate(start, false), b = locate(end, true);
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, Math.min(b.offset, b.node.length));
  return range;
}

/** Which occurrence of the quote a model offset refers to, counted the way
 *  selections are: whitespace folded on both sides. */
function occurrenceAt(text: string, quote: string, offset: number) {
  const map = squashMap(text), needle = squash(quote);
  let count = 0, at = -1;
  while ((at = map.text.indexOf(needle, at + 1)) >= 0 && map.at[at] < offset) count++;
  return count;
}

/** Identity check against the model: the shape (and cell) exist, and a quoted
 *  target's characters are really in that shape's text. */
function identityOk(st: State, t: Target) {
  if (t.cells?.length) return t.cells.every(([row, col]) => entryFor(st, { ...t, row, col }));
  const entry = entryFor(st, t);
  if (!entry) return false;
  return !t.quote || squash(entry.text).includes(squash(t.quote));
}

function paint(st: State) {
  st.layer.replaceChildren();
  const rootBox = st.root.getBoundingClientRect();
  for (const t of st.targets) {
    if (!identityOk(st, t) || !slideEl(st, t.slide_index)) continue;   // unmounted slides paint when they mount
    const els = elementsOf(st, t);
    if (!els) continue;
    let rects: { left: number; top: number; width: number; height: number }[] = [];
    if (t.quote && els.length === 1) {
      const entry = entryFor(st, t)!;
      const occurrence = t.offset != null ? occurrenceAt(entry.text, t.quote, t.offset) : t.occurrence ?? 0;
      const range = quoteRange(els[0], t.quote, occurrence);
      if (!range) continue;
      // One box per line: the renderer's nested spans would otherwise give
      // overlapping boxes that stack into a dark band.
      rects = mergeLineRects([...range.getClientRects()]);
    } else rects = els.map(el => el.getBoundingClientRect());
    for (const r of rects) {
      const mark = document.createElement('div');
      mark.className = ['pp-mark', ...t.classes].join(' ');
      Object.assign(mark.style, {
        left: r.left - rootBox.left + st.root.scrollLeft + 'px', top: r.top - rootBox.top + st.root.scrollTop + 'px',
        width: r.width + 'px', height: r.height + 'px',
      });
      if (t.active) mark.dataset.active = '';
      st.layer.append(mark);
    }
  }
  const pending = st.pending, mark = pending && st.layer.querySelector<HTMLElement>('.pp-mark[data-active]');
  if (pending && mark) { st.pending = null; mark.scrollIntoView({ block: 'center' }); st.scroll = { top: st.root.scrollTop, left: st.root.scrollLeft }; }
}

export async function render(data: ArrayBuffer): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.className = 'original-pptx';
  const host = document.createElement('div');
  host.className = 'pp-slides';
  const layer = document.createElement('div');
  layer.className = 'pp-overlays';
  root.append(host, layer);
  const pres = buildPresentation(await parseZip(data, RECOMMENDED_ZIP_LIMITS));
  const st = {} as State;
  const viewer = new PptxViewer(host, {
    fitMode: 'contain', scrollContainer: root, zipLimits: RECOMMENDED_ZIP_LIMITS,
    onRenderComplete: () => paint(st),
    onSlideRendered: () => paint(st),
    onSlideChange: index => root.dispatchEvent(new CustomEvent('viewer-page', { detail: { index }, bubbles: true })),
  });
  Object.assign(st, {
    viewer, pres, index: buildTextIndex(pres), root, host, layer, targets: [], pending: null,
    scroll: { top: 0, left: 0 }, zoom: 1, resize: new ResizeObserver(() => paint(st)),
  });
  states.set(root, st);
  root.addEventListener('scroll', () => { st.scroll = { top: root.scrollTop, left: root.scrollLeft }; }, { passive: true });
  st.resize.observe(root);
  viewer.load(pres);
  await viewer.renderList({ windowed: true });
  return root;
}

/** Places targets; returns, per target, whether its shape exists in this deck
 *  (and, for a quote, whether those characters are in that shape). */
export function setTargets(root: HTMLElement, targets: Target[]): boolean[] {
  const st = states.get(root);
  if (!st) return targets.map(() => false);
  st.targets = targets;
  paint(st);
  return targets.map(t => identityOk(st, t));
}

export function reveal(root: HTMLElement, target: Target) {
  const st = states.get(root);
  if (!st || !identityOk(st, target)) return false;
  st.pending = target;
  void st.viewer.goToSlide(target.slide_index).then(() => requestAnimationFrame(() => paint(st)));
  return true;
}

export function showSlide(root: HTMLElement, index: number) {
  const st = states.get(root);
  if (st && index >= 0 && index < st.viewer.slideCount && st.viewer.currentSlideIndex !== index) void st.viewer.goToSlide(index);
}

export function setZoom(root: HTMLElement, zoom: number) {
  const st = states.get(root);
  if (!st || Math.abs(st.zoom - zoom) < 0.001) return;
  st.zoom = zoom;
  // Repaint once the zoomed layout has settled, keeping the current citation
  // in view: resizing the slides moves everything below the first one.
  void st.viewer.setZoom(Math.round(zoom * 100)).then(() => requestAnimationFrame(() => {
    st.pending = st.targets.find(t => t.active) || null;
    paint(st);
  }));
}

/** Called after the workspace re-inserts this element: a detached scroll
 *  container forgets its offset. */
export function attached(root: HTMLElement) {
  const st = states.get(root);
  if (!st) return;
  root.scrollTop = st.scroll.top;
  root.scrollLeft = st.scroll.left;
  paint(st);
}

/** A reader's selection on a slide → an anchor in one shape or table cell. */
export function selectionAnchor(root: HTMLElement, range: Range): { anchor?: SlideAnchor; error?: string } {
  const st = states.get(root);
  if (!st || range.collapsed || !root.contains(range.commonAncestorContainer)) return { error: 'Select text on a slide.' };
  const elOf = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement)!;
  const start = elOf(range.startContainer), end = elOf(range.endContainer);
  const slide = start.closest<HTMLElement>('[data-slide-index]');
  if (!slide || slide !== end.closest('[data-slide-index]')) return { error: 'Select text within one slide.' };
  const slideIndex = Number(slide.dataset.slideIndex);
  let target: HTMLElement | null = null, ident: { shape_id: number; row: number | null; col: number | null } | null = null;
  const td = start.closest('td');
  if (td || end.closest('td')) {
    if (!td || td !== end.closest('td')) return { error: 'Select text within one table cell.' };
    const table = td.closest('table')!, tables = [...slide.querySelectorAll('table')];
    const ids = [...new Set(st.index.filter(e => e.slideIndex === slideIndex && e.textKind === 'table-cell').map(e => Number(e.nodeId)))];
    const tr = td.closest('tr')!, rows = [...table.querySelectorAll('tr')];
    const shapeId = ids[tables.indexOf(table)];
    if (shapeId === undefined) return { error: 'That table could not be identified.' };
    target = td as HTMLElement;
    ident = { shape_id: shapeId, row: rows.indexOf(tr), col: [...tr.children].indexOf(td) };
  } else {
    const owners = st.index.filter(e => e.slideIndex === slideIndex && e.textKind === 'shape')
      .map(e => ({ e, el: shapeEl(st, e) })).filter(o => o.el && o.el.contains(start) && o.el.contains(end));
    if (owners.length !== 1) return { error: 'Select text within one text box.' };
    target = owners[0].el;
    ident = { shape_id: Number(owners[0].e.nodeId), row: null, col: null };
  }
  const quote = range.toString();
  if (norm(quote).length < 2) return { error: 'Select a longer passage to highlight.' };
  // Which occurrence: count the quote's appearances before the selection start.
  const { raw, nodes } = textNodes(target!);
  const startNode = nodes.find(n => n.node === range.startContainer);
  const startAt = startNode ? startNode.start + range.startOffset : 0;
  const map = squashMap(raw), needle = norm(quote);
  let occurrence = 0, at = -1;
  while ((at = map.text.indexOf(squash(quote), at + 1)) >= 0 && map.at[at] < startAt) occurrence++;
  const entry = entryFor(st, { slide_index: slideIndex, ...ident });
  if (!entry || !squash(entry.text).includes(squash(quote))) return { error: 'That passage could not be matched to the slide text, so it was not saved.' };
  return { anchor: { format: 'pptx', slide_index: slideIndex, ...ident, quote: needle, occurrence: Math.max(0, occurrence) } };
}

/** The renderer's text index, as [slide_index, shape_id, row, col, text] units. */
export const units = (root: HTMLElement) => (states.get(root)?.index || []).map(e =>
  [e.slideIndex, Number(e.nodeId), e.textKind === 'table-cell' ? e.rowIndex ?? null : null, e.textKind === 'table-cell' ? e.cellIndex ?? null : null, e.text, e.textKind]);

export function destroy(root: HTMLElement) {
  const st = states.get(root);
  if (!st) return;
  st.resize.disconnect();
  st.viewer.destroy();
  states.delete(root);
}

/** A still of the first slide for the file list: drawn once at the deck's own
 *  size; the caller scales it into the thumbnail. No viewer, no listeners. */
export async function thumbnail(data: ArrayBuffer): Promise<{ element: HTMLElement; width: number; height: number }> {
  const pres = buildPresentation(await parseZip(data, RECOMMENDED_ZIP_LIMITS));
  const slide = pres.slides[0];
  if (!slide) throw Error('This deck has no slides.');
  const handle = renderSlide(pres, slide);
  await handle.ready.catch(() => {});
  return { element: handle.element, width: pres.width, height: pres.height };
}
