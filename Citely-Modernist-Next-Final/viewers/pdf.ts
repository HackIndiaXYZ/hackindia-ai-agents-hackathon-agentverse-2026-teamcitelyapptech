// Lazily loaded: only fetched when a PDF original is opened.
//
// Every page is a picture of the page (drawn lazily, only near the viewport)
// with a transparent text layer over it. The text layer is what makes the
// original behave like the Word viewer: the shared helpers read its text, find
// a cited passage in it and highlight that passage in place. A scanned page has
// no text layer; evidence read from a picture is shown as a marked region of
// the page instead (see paintRegions).
import * as pdfjs from 'pdfjs-dist';
import { collectText, locate, clearMarks, paintMarks, selectionAnchor } from '../lib/viewer-dom.mjs';
import { anchorFromRaw, locateOnPages } from '../lib/anchor.mjs';

export { collectText, locate, clearMarks, paintMarks, selectionAnchor, anchorFromRaw, locateOnPages };

// The worker sits beside this module (copied there by the studio build).
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.js', import.meta.url).href;
const standardFontDataUrl = new URL('pdfjs/standard_fonts/', import.meta.url).href;
const cMapUrl = new URL('pdfjs/cmaps/', import.meta.url).href;

/** CSS pixels per PDF point. The page is later fitted to its container. */
const SCALE = 1.25;
/** Pages whose text layer is built at the same time. */
const TEXT_CONCURRENCY = 6;
/** Rendered page images kept at once; farther ones are released. */
const MAX_DRAWN = 10;

interface State {
  pdf: pdfjs.PDFDocumentProxy;
  pages: Map<number, pdfjs.PDFPageProxy>;
  drawn: number[];                       // page numbers with a canvas, oldest first
  drawing: Set<number>;
  observer?: IntersectionObserver;
  resize?: ResizeObserver;
}
const states = new WeakMap<HTMLElement, State>();

function open(data: ArrayBuffer) {
  // pdf.js takes ownership of the bytes it is given: hand it a copy.
  return pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), enableXfa: false, stopAtErrors: false, standardFontDataUrl, cMapUrl, cMapPacked: true }).promise;
}

/** Runs `work` over `items`, `limit` at a time. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

/** Renders a .pdf into a fresh element. */
export async function render(data: ArrayBuffer): Promise<HTMLElement> {
  const pdf = await open(data);
  const root = document.createElement('div');
  root.className = 'original-pdf';
  const state: State = { pdf, pages: new Map(), drawn: [], drawing: new Set() };
  states.set(root, state);

  const numbers = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
  const sections = new Map<number, HTMLElement>();
  // Sizes first (cheap), so the scrollbar is right before any text arrives.
  for (const n of numbers) {
    const page = await pdf.getPage(n);
    state.pages.set(n, page);
    const viewport = page.getViewport({ scale: SCALE });
    const section = document.createElement('section');
    section.className = 'pdf-page';
    section.dataset.page = String(n);
    section.setAttribute('aria-label', `Page ${n}`);
    section.style.width = `${viewport.width}px`;
    section.style.height = `${viewport.height}px`;
    section.style.setProperty('--scale-factor', String(SCALE));
    const text = document.createElement('div');
    text.className = 'textLayer pdf-text';
    section.append(text);
    root.append(section);
    sections.set(n, section);
  }
  // Then every page's text, so any citation can be found wherever it is.
  await pool(numbers, TEXT_CONCURRENCY, async n => {
    const page = state.pages.get(n)!, container = sections.get(n)!.querySelector<HTMLElement>('.pdf-text')!;
    const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport: page.getViewport({ scale: SCALE }) });
    await layer.render();
    // The text helpers separate text that sits in different blocks. Every line of a
    // text layer shares one parent, so without this the end of one line would fuse
    // with the start of the next ("end" + "Next" = "endNext").
    container.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode(' ')));
    container.querySelectorAll('.endOfContent').forEach(el => el.remove());
  });
  return root;
}

/** One element per page, for the page control. */
export const pages = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('section.pdf-page')];

async function draw(root: HTMLElement, n: number) {
  const state = states.get(root);
  if (!state || state.drawing.has(n) || state.drawn.includes(n)) return;
  const section = root.querySelector<HTMLElement>(`section.pdf-page[data-page="${n}"]`);
  const page = state.pages.get(n);
  if (!section || !page) return;
  state.drawing.add(n);
  try {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: SCALE });
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.setAttribute('aria-hidden', 'true');
    await page.render({ canvas, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] }).promise;
    section.prepend(canvas);
    state.drawn.push(n);
    // Release the oldest pictures: a long document must not hold them all.
    while (state.drawn.length > MAX_DRAWN) release(root, state.drawn.shift()!);
  } catch { /* a page that cannot be drawn keeps its text layer */ }
  finally { state.drawing.delete(n); }
}

function release(root: HTMLElement, n: number) {
  const canvas = root.querySelector<HTMLCanvasElement>(`section.pdf-page[data-page="${n}"] > canvas.pdf-canvas`);
  if (canvas) { canvas.width = canvas.height = 0; canvas.remove(); }
}

/** Called each time the original is put on screen: draws pages as they come
 *  near the viewport and keeps the page fitted to its container. */
export function attached(root: HTMLElement) {
  const state = states.get(root);
  if (!state) return;
  state.observer?.disconnect();
  state.resize?.disconnect();
  state.observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      const n = Number((e.target as HTMLElement).dataset.page);
      if (e.isIntersecting) void draw(root, n);
    }
  }, { rootMargin: '900px 0px' });
  pages(root).forEach(p => state.observer!.observe(p));
  const fit = () => {
    const host = root.parentElement;
    if (!host) return;
    const widest = Math.max(...pages(root).map(p => parseFloat(p.style.width) || 0), 1);
    root.style.setProperty('--pdf-fit', String(Math.min(1, Math.max(0.3, (host.clientWidth - 24) / widest))));
  };
  fit();
  state.resize = new ResizeObserver(fit);
  if (root.parentElement) state.resize.observe(root.parentElement);
}

/** Marks regions of pages: evidence read from a picture or a scanned page, which
 *  has no text to highlight. Each region is {page, box: [x, y, w, h] as fractions
 *  of the page, classes, id?}. */
export function paintRegions(root: HTMLElement, regions: { page: number; box?: number[]; classes: string[]; id?: string }[]) {
  clearRegions(root);
  for (const r of regions) {
    const section = root.querySelector<HTMLElement>(`section.pdf-page[data-page="${r.page}"]`);
    if (!section) continue;
    const [x, y, w, h] = r.box && r.box.length === 4 ? r.box : [0, 0, 1, 1];
    const mark = document.createElement('div');
    mark.className = ['pdf-region', ...r.classes].join(' ');
    mark.dataset.viewerRegion = '';
    Object.assign(mark.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
    if (r.id) { mark.id = r.id; mark.tabIndex = -1; }
    section.append(mark);
  }
}

export function clearRegions(root: HTMLElement) {
  root.querySelectorAll('[data-viewer-region]').forEach(el => el.remove());
}

/** Frees the pdf.js document and everything drawn. */
export function destroy(root: HTMLElement) {
  const state = states.get(root);
  if (!state) return;
  state.observer?.disconnect();
  state.resize?.disconnect();
  state.drawn.forEach(n => release(root, n));
  void state.pdf.destroy();
  states.delete(root);
}

/** The first page for the file list, at its natural size. */
export async function thumbnail(data: ArrayBuffer): Promise<{ element: HTMLElement; width: number; height: number }> {
  const pdf = await open(data);
  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const element = document.createElement('div');
    element.className = 'original-pdf thumb-pdf';
    element.style.background = '#fff';
    element.append(canvas);
    return { element, width: viewport.width, height: viewport.height };
  } finally { void pdf.destroy(); }
}
