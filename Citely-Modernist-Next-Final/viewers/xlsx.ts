// Lazily loaded spreadsheet viewer: SheetJS reads the workbook, AG Grid
// Community draws it. Only fetched when an .xlsx original is opened.
//
// Everything Excel-like here is ours, not the grid's: sheet tabs, column
// letters and row numbers, merged cells, the formula display rule, cell
// highlighting, and mouse/keyboard range selection (the grid's own range
// selection is an Enterprise feature and is deliberately not used).
//
// Merges are drawn with the grid's colSpan/rowSpan where it can: a spanning
// cell only exists while its top row is rendered, so each sheet's row buffer
// is raised to its tallest merge. Merges too tall (over MAX_ROW_BUFFER rows) or
// wide enough to leave a virtualized column band are instead drawn by an
// overlay that tracks scrolling, so their content and highlight never vanish.
import * as XLSX from 'xlsx';
import {
  createGrid, ModuleRegistry, themeQuartz,
  ClientSideRowModelModule, CellStyleModule, ScrollApiModule, RenderApiModule,
  CellSpanModule, EventApiModule, RowStyleModule,
  type GridApi, type ColDef, type CellClassParams, type ICellRendererComp, type ICellRendererParams,
} from 'ag-grid-community';
import { displayCell } from '../lib/cellvalue.mjs';
import { colName, decodeRange, encodeRange, mergeIndex, snapToMerges, targetCells, rangeText } from '../lib/sheet-model.mjs';

ModuleRegistry.registerModules([
  ClientSideRowModelModule, CellStyleModule, ScrollApiModule, RenderApiModule,
  CellSpanModule, EventApiModule, RowStyleModule,
]);

type Cell = { r: number; c: number };
type Range = { s: Cell; e: Cell };
type Merge = Range;
export type Target = { sheet_name: string; sheet_index: number; range: string; cells?: string[]; classes: string[]; active?: boolean };
export type CellAnchor = { format: 'xlsx'; sheet_name: string; sheet_index: number; range: string; quote: string };

const MAX_ROW_BUFFER = 400;           // tallest merge the grid draws itself
const MAX_UNVIRTUALIZED_COLS = 200;   // wider sheets keep column virtualization
const BASE = { row: 24, header: 26, font: 13, gutter: 52, col: 100 };
const HIT_CLASSES = ['citation-range', 'current-citation', 'permanent-mark'] as const;

const theme = themeQuartz.withParams({
  fontFamily: 'inherit',
  backgroundColor: '#ffffff',
  foregroundColor: '#1f2328',
  headerBackgroundColor: '#f3f4f6',
  headerTextColor: '#4b5563',
  borderColor: '#d9dce1',
  rowBorder: { color: '#e5e7eb' },
  columnBorder: { color: '#e5e7eb' },
  headerColumnBorder: { color: '#d9dce1' },
  oddRowBackgroundColor: '#ffffff',
  rowHoverColor: 'transparent',
  wrapperBorderRadius: 0,
  cellHorizontalPadding: 6,
});

type Sheet = {
  name: string; index: number; rows: any[][]; range: Range | null; merges: Merge[];
  idx: ReturnType<typeof mergeIndex>; widths: number[]; oversized: Merge[]; rowBuffer: number; virtualCols: boolean;
  spanRows: Set<number>;   // rows holding the top of a multi-row merge the grid draws
};

type State = {
  sheets: Sheet[]; current: number; zoom: number; api: GridApi | null;
  host: HTMLElement; tabs: HTMLElement; overlay: HTMLElement; layer: HTMLElement;
  targets: Target[]; hits: Map<string, Set<string>>;          // "r,c" → classes, current sheet only
  sel: { anchor: Cell; focus: Cell } | null; dragging: boolean; scroll: { top: number; left: number };
  pending: Cell | null;    // a cell to bring into view once the grid has laid out
  pressed: Cell | null;    // cell of the last mouse press; the grid focuses it a moment later
  requested: string[];     // focus moves we asked the grid for; their events arrive later, in any order
  ready: boolean;          // the current grid has rendered rows (and so has a scroll height)
  onMouseUp: () => void;
};

const states = new WeakMap<HTMLElement, State>();

function readSheets(data: ArrayBuffer): Sheet[] {
  const wb = XLSX.read(data, { type: 'array', dense: true, cellDates: true, cellFormula: true, cellNF: true, sheetStubs: true });
  return wb.SheetNames.map((name, index) => {
    const ws: any = wb.Sheets[name] || {};
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    const merges: Merge[] = ws['!merges'] || [];
    const cols: any[] = ws['!cols'] || [];
    const width = (c: number) => {
      const spec = cols[c];
      const px = spec?.wpx ?? (spec?.wch ? spec.wch * 7 + 5 : spec?.width ? spec.width * 7 + 5 : BASE.col);
      return Math.max(40, Math.min(400, Math.round(px)));
    };
    const ncols = range ? range.e.c + 1 : 0;
    const virtualCols = ncols > MAX_UNVIRTUALIZED_COLS;
    const oversized = merges.filter(m => m.e.r - m.s.r + 1 > MAX_ROW_BUFFER || (virtualCols && m.e.c - m.s.c + 1 > 1));
    const spanned = merges.filter(m => !oversized.includes(m));
    const tallest = spanned.reduce((n, m) => Math.max(n, m.e.r - m.s.r + 1), 0);
    return {
      name, index, rows: ws['!data'] || [], range, merges, idx: mergeIndex(merges),
      widths: Array.from({ length: ncols }, (_, c) => width(c)), oversized,
      rowBuffer: Math.max(10, Math.min(MAX_ROW_BUFFER, tallest)), virtualCols,
      spanRows: new Set(spanned.filter(m => m.e.r > m.s.r).map(m => m.s.r)),
    };
  });
}

const cellAt = (sheet: Sheet, r: number, c: number) => sheet.rows[r]?.[c];
const shown = (sheet: Sheet, r: number, c: number) => displayCell(cellAt(sheet, r, c)).text;
const isOversized = (sheet: Sheet, m: Merge | null) => !!m && sheet.oversized.includes(m);

class CellText implements ICellRendererComp {
  private el!: HTMLElement;
  init(p: ICellRendererParams) {
    this.el = document.createElement('span');
    const d = p.value as ReturnType<typeof displayCell> | undefined;
    this.el.textContent = d?.text ?? '';
    if (d?.title) this.el.title = d.title;
  }
  getGui() { return this.el; }
  refresh() { return false; }
}

function columnDefs(st: State, sheet: Sheet): ColDef[] {
  const z = st.zoom, ncols = sheet.widths.length;
  const key = (p: CellClassParams, c: number) => `${p.data.r},${c}`;
  const selected = (r: number, c: number) => {
    if (!st.sel) return false;
    const range = selectionRange(st, sheet);
    return !!range && r >= range.s.r && r <= range.e.r && c >= range.s.c && c <= range.e.c && !sheet.idx.isCovered(r, c);
  };
  const defs: ColDef[] = [{
    colId: 'rownum', headerName: '', pinned: 'left', width: Math.round(BASE.gutter * z), suppressMovable: true,
    valueGetter: p => ({ text: String(p.data.r + 1), kind: 'rownum' }), cellRenderer: CellText, cellClass: 'xl-rownum',
  }];
  for (let c = 0; c < ncols; c++) {
    defs.push({
      colId: 'c' + c, headerName: colName(c), width: Math.round(sheet.widths[c] * z), suppressMovable: true,
      valueGetter: p => {
        const r = p.data.r, m = sheet.idx.anchoredAt(r, c);
        if (sheet.idx.isCovered(r, c) || isOversized(sheet, m)) return { text: '', kind: 'covered' };
        return displayCell(cellAt(sheet, r, c));
      },
      cellRenderer: CellText,
      colSpan: p => { const m = sheet.idx.anchoredAt(p.data.r, c); return m && !isOversized(sheet, m) ? m.e.c - m.s.c + 1 : 1; },
      rowSpan: p => { const m = sheet.idx.anchoredAt(p.data.r, c); return m && !isOversized(sheet, m) ? m.e.r - m.s.r + 1 : 1; },
      cellClassRules: {
        'xl-covered': p => sheet.idx.isCovered(p.data.r, c) || isOversized(sheet, sheet.idx.anchoredAt(p.data.r, c)),
        'xl-merge': p => !!sheet.idx.anchoredAt(p.data.r, c),
        'xl-uncalculated': p => p.value?.kind === 'formula-uncalculated',
        'xl-error': p => p.value?.kind === 'formula-error',
        'xl-number': p => { const t = cellAt(sheet, p.data.r, c)?.t; return t === 'n' || t === 'd'; },
        'xl-selected': p => selected(p.data.r, c),
        ...Object.fromEntries(HIT_CLASSES.map(cls => [cls, (p: CellClassParams) => !!st.hits.get(key(p, c))?.has(cls)])),
      },
    });
  }
  return defs;
}

function selectionRange(st: State, sheet: Sheet): Range | null {
  if (!st.sel) return null;
  const { anchor: a, focus: f } = st.sel;
  return snapToMerges({ s: { r: Math.min(a.r, f.r), c: Math.min(a.c, f.c) }, e: { r: Math.max(a.r, f.r), c: Math.max(a.c, f.c) } }, sheet.merges);
}

function computeHits(st: State) {
  const sheet = st.sheets[st.current];
  st.hits = new Map();
  for (const t of st.targets) {
    if (resolveSheet(st, t) !== sheet) continue;
    const keys = targetCells(t, sheet.idx);
    if (!keys) continue;
    for (const k of keys) {
      const set = st.hits.get(k) || st.hits.set(k, new Set()).get(k)!;
      t.classes.forEach(cls => set.add(cls));
    }
  }
}

/** A target's sheet: the name must match, and the position too — a renamed or
 *  reordered sheet is a different workbook than the one cited. */
function resolveSheet(st: State, t: { sheet_name: string; sheet_index: number }) {
  const sheet = st.sheets[t.sheet_index];
  return sheet && sheet.name === t.sheet_name ? sheet : null;
}

function emit(root: HTMLElement, type: string, detail: unknown) {
  root.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
}

function drawTabs(root: HTMLElement, st: State) {
  st.tabs.replaceChildren(...st.sheets.map(sheet => {
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'tab';
    b.textContent = sheet.name;
    b.dataset.sheetIndex = String(sheet.index);
    b.setAttribute('aria-selected', String(sheet.index === st.current));
    b.tabIndex = sheet.index === st.current ? 0 : -1;
    b.addEventListener('click', () => { showSheet(root, sheet.index); emit(root, 'viewer-page', { index: sheet.index }); });
    return b;
  }));
}

function geometry(st: State, sheet: Sheet) {
  const z = st.zoom, left: number[] = [0];
  for (const w of sheet.widths) left.push(left[left.length - 1] + Math.round(w * z));
  return { rowH: Math.round(BASE.row * z), left };
}

/** Oversized merges, drawn over the grid and moved with its scroll position. */
function drawOverlay(st: State) {
  const sheet = st.sheets[st.current];
  st.layer.replaceChildren();
  if (!sheet.oversized.length) { st.overlay.hidden = true; return; }
  st.overlay.hidden = false;
  const { rowH, left } = geometry(st, sheet);
  for (const m of sheet.oversized) {
    const box = document.createElement('div');
    box.className = 'xl-merge-box';
    const hit = st.hits.get(m.s.r + ',' + m.s.c);
    HIT_CLASSES.forEach(cls => box.classList.toggle(cls, !!hit?.has(cls)));
    const range = selectionRange(st, sheet);
    box.classList.toggle('xl-selected', !!range && m.s.r >= range.s.r && m.e.r <= range.e.r && m.s.c >= range.s.c && m.e.c <= range.e.c);
    Object.assign(box.style, { top: m.s.r * rowH + 'px', left: left[m.s.c] + 'px', width: left[m.e.c + 1] - left[m.s.c] + 'px', height: (m.e.r - m.s.r + 1) * rowH + 'px' });
    box.dataset.range = encodeRange(m);
    const label = document.createElement('span');
    label.textContent = shown(sheet, m.s.r, m.s.c);
    box.append(label);
    box.addEventListener('mousedown', e => { if (e.button !== 0) return; st.sel = { anchor: m.s, focus: m.e }; st.dragging = true; repaint(st); });
    st.layer.append(box);
  }
  placeOverlay(st);
}

// AG Grid 36 scrolls both axes in one viewport, with the header and the
// pinned row-number column sticky inside it.
const viewportOf = (st: State) => st.host.querySelector<HTMLElement>('.ag-grid-viewport');

function placeOverlay(st: State) {
  if (st.overlay.hidden) return;
  const view = viewportOf(st);
  if (view) {
    const a = st.host.getBoundingClientRect(), b = view.getBoundingClientRect();
    const header = Math.round(BASE.header * st.zoom), gutter = Math.round(BASE.gutter * st.zoom);
    Object.assign(st.overlay.style, { top: b.top - a.top + header + 'px', left: b.left - a.left + gutter + 'px',
      width: Math.max(0, view.clientWidth - gutter) + 'px', height: Math.max(0, view.clientHeight - header) + 'px' });
  }
  st.layer.style.transform = `translate(${-st.scroll.left}px, ${-st.scroll.top}px)`;
  // Keep each merge's text at the top of the part of the merge in view.
  for (const box of st.layer.children as any as HTMLElement[]) {
    const top = parseFloat(box.style.top), height = parseFloat(box.style.height), label = box.firstElementChild as HTMLElement;
    label.style.transform = `translateY(${Math.max(0, Math.min(st.scroll.top - top, height - label.offsetHeight))}px)`;
  }
}

function repaint(st: State) {
  // Not forced: that would rebuild every cell element and drop keyboard focus.
  // Class rules (highlights, selection) are re-applied either way.
  st.api?.refreshCells();
  drawOverlay(st);
}

function mountGrid(root: HTMLElement, st: State) {
  st.api?.destroy();
  st.api = null;
  st.ready = false;
  st.host.replaceChildren();
  st.scroll = { top: 0, left: 0 };
  const sheet = st.sheets[st.current];
  root.dataset.sheetIndex = String(sheet.index);
  if (!sheet.range || !sheet.rows.length) {
    const p = document.createElement('p');
    p.className = 'original-status';
    p.textContent = sheet.range ? 'This sheet is empty.' : 'This sheet has no cells to show (charts are not displayed).';
    st.host.append(p);
    st.overlay.hidden = true;
    return;
  }
  const z = st.zoom;
  const rowData = Array.from({ length: sheet.range.e.r + 1 }, (_, r) => ({ r }));
  st.api = createGrid(st.host, {
    theme: theme.withParams({ fontSize: Math.round(BASE.font * z), headerFontSize: Math.round(BASE.font * z) }),
    rowData, columnDefs: columnDefs(st, sheet),
    rowHeight: Math.round(BASE.row * z), headerHeight: Math.round(BASE.header * z),
    suppressRowTransform: true, rowBuffer: sheet.rowBuffer, suppressColumnVirtualisation: !sheet.virtualCols,
    suppressMovableColumns: true, suppressCellFocus: false, animateRows: false, suppressDragLeaveHidesColumns: true,
    getRowId: p => String(p.data.r),
    // A rowSpan cell overflows its own row; later rows are later siblings and
    // would paint over it (and take its clicks). Its row is raised above them.
    rowClassRules: { 'xl-row-span': p => sheet.spanRows.has(p.data.r) },
    onCellFocused: e => {
      // Plain keyboard moves collapse the selection onto the focused cell;
      // Shift+arrow is handled in suppressKeyboardEvent below. The focus that
      // follows a mouse press is the grid catching up, not a keyboard move.
      if (e.rowIndex == null || !e.column || typeof e.column === 'string') return;
      const c = cellOf(e.column.getColId());
      if (c === null) return;
      const pressed = st.pressed, key = e.rowIndex + ',' + c, mine = st.requested.indexOf(key);
      st.pressed = null;
      if (mine >= 0) { st.requested.splice(mine, 1); return; }
      if (st.dragging || (pressed && pressed.r === e.rowIndex && pressed.c === c)) return;
      if (st.sel && st.sel.focus.r === e.rowIndex && st.sel.focus.c === c) return;
      st.sel = { anchor: { r: e.rowIndex, c }, focus: { r: e.rowIndex, c } };
      repaint(st);
    },
    onBodyScroll: e => { st.scroll = { top: e.top, left: e.left }; placeOverlay(st); },
    onGridSizeChanged: () => { placeOverlay(st); applyReveal(st); },
    onFirstDataRendered: () => { st.ready = true; drawOverlay(st); applyReveal(st); },
    defaultColDef: {
      sortable: false, resizable: false,
      suppressKeyboardEvent: p => {
        const ev = p.event as KeyboardEvent;
        if (ev.type !== 'keydown') return false;
        if (ev.key === 'Enter' && st.sel) { emit(root, 'viewer-select', anchorOf(st)); return true; }
        if (ev.key === 'Escape') { st.sel = null; repaint(st); return true; }
        const step = ({ ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] } as Record<string, number[]>)[ev.key];
        if (!ev.shiftKey || !step) return false;
        // After a saved highlight clears the selection, Shift extends from the focused cell.
        const from = st.sel || (() => { const f = focusedCell(st); return f && { anchor: f, focus: f }; })();
        if (!from) return false;
        const range = sheet.range!, f = from.focus;
        const focus = { r: Math.max(0, Math.min(range.e.r, f.r + step[0])), c: Math.max(0, Math.min(range.e.c, f.c + step[1])) };
        st.sel = { anchor: from.anchor, focus };
        st.requested.push(focus.r + ',' + focus.c);
        if (st.requested.length > 50) st.requested.shift();
        p.api.ensureIndexVisible(focus.r);
        p.api.ensureColumnVisible('c' + focus.c);
        p.api.setFocusedCell(focus.r, 'c' + focus.c);
        repaint(st);
        return true;
      },
    },
  });
}

/** Scrolls a pending cell into view, once the grid has a size to scroll in. A
 *  grid just created (new sheet, or still detached) has not laid out yet. */
function applyReveal(st: State) {
  const cell = st.pending, view = viewportOf(st);
  if (!cell || !st.api || !st.ready || !view || !view.clientHeight) return;
  st.pending = null;
  st.api.ensureIndexVisible(cell.r, 'middle');
  st.api.ensureColumnVisible('c' + cell.c, 'middle');
  // Record the new offsets now: the workspace may re-render (and re-attach
  // this element) before the browser delivers the scroll event.
  st.scroll = { top: view.scrollTop, left: view.scrollLeft };
  placeOverlay(st);
}

const cellOf = (colId: string) => (/^c\d+$/.test(colId) ? Number(colId.slice(1)) : null);

/** The grid's focused cell; it keeps this even while DOM focus is elsewhere. */
function focusedCell(st: State): Cell | null {
  const f = st.api?.getFocusedCell(), c = f && cellOf(f.column.getColId());
  return f && c !== null && c !== undefined ? { r: f.rowIndex, c } : null;
}

function cellFromEvent(e: Event): Cell | null {
  const el = (e.target as Element | null)?.closest?.('.ag-cell');
  const c = cellOf(el?.getAttribute('col-id') || ''), r = Number(el?.closest('.ag-row')?.getAttribute('row-index'));
  return c === null || !Number.isInteger(r) ? null : { r, c };
}

function anchorOf(st: State): CellAnchor | null {
  const sheet = st.sheets[st.current], range = selectionRange(st, sheet);
  if (!range) return null;
  return { format: 'xlsx', sheet_name: sheet.name, sheet_index: sheet.index, range: encodeRange(range), quote: rangeText(range, sheet.idx, (r: number, c: number) => shown(sheet, r, c)) };
}

/** Renders a workbook into a fresh element. */
export async function render(data: ArrayBuffer): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.className = 'original-xlsx';
  const tabs = document.createElement('div');
  tabs.className = 'xl-tabs';
  tabs.role = 'tablist';
  tabs.ariaLabel = 'Sheets';
  const frame = document.createElement('div');
  frame.className = 'xl-frame';
  const host = document.createElement('div');
  host.className = 'xl-grid';
  const overlay = document.createElement('div');
  overlay.className = 'xl-overlay';
  overlay.hidden = true;
  const layer = document.createElement('div');
  layer.className = 'xl-overlay-layer';
  overlay.append(layer);
  frame.append(host, overlay);
  root.append(tabs, frame);
  const sheets = readSheets(data);
  const first = Math.max(0, sheets.findIndex(s => s.range));
  const st: State = {
    sheets, current: first, zoom: 1, api: null, host, tabs, overlay, layer, targets: [], hits: new Map(),
    sel: null, dragging: false, scroll: { top: 0, left: 0 }, pending: null, ready: false, pressed: null, requested: [],
    onMouseUp: () => { if (!st.dragging) return; st.dragging = false; const a = anchorOf(st); if (a) emit(root, 'viewer-select', a); },
  };
  states.set(root, st);
  // Selection uses native events on the host (which outlives each sheet's
  // grid): the grid's own cellMouseDown arrives asynchronously, after the
  // mouseup of a quick click.
  host.addEventListener('mousedown', e => {
    const cell = e.button === 0 ? cellFromEvent(e) : null;
    if (!cell) return;
    st.pressed = cell;
    st.sel = e.shiftKey && st.sel ? { anchor: st.sel.anchor, focus: cell } : { anchor: cell, focus: cell };
    st.dragging = true;
    repaint(st);
  });
  host.addEventListener('mouseover', e => {
    const cell = st.dragging && st.sel ? cellFromEvent(e) : null;
    if (!cell || !st.sel || (st.sel.focus.r === cell.r && st.sel.focus.c === cell.c)) return;
    st.sel = { anchor: st.sel.anchor, focus: cell };
    repaint(st);
  });
  document.addEventListener('mouseup', st.onMouseUp);
  drawTabs(root, st);
  mountGrid(root, st);
  return root;
}

export const sheets = (root: HTMLElement) => (states.get(root)?.sheets || []).map(s => ({ name: s.name, index: s.index, empty: !s.range }));
export const currentSheet = (root: HTMLElement) => states.get(root)?.current ?? 0;

export function showSheet(root: HTMLElement, index: number) {
  const st = states.get(root);
  if (!st || !st.sheets[index] || st.current === index) return;
  st.current = index;
  st.sel = null;
  computeHits(st);
  drawTabs(root, st);
  mountGrid(root, st);
}

/** Paints citations and saved highlights. Returns, per target, whether its
 *  sheet and range exist in this workbook. */
export function setTargets(root: HTMLElement, targets: Target[]): boolean[] {
  const st = states.get(root);
  if (!st) return targets.map(() => false);
  st.targets = targets;
  const placed = targets.map(t => {
    const sheet = resolveSheet(st, t), range = decodeRange(t.range);
    return !!sheet && !!sheet.range && !!range && range.e.r <= sheet.range.e.r && range.e.c <= sheet.range.e.c && !!targetCells(t, sheet.idx);
  });
  computeHits(st);
  repaint(st);
  return placed;
}

/** Brings a target into view: its sheet, then its first cell, row and column. */
export function reveal(root: HTMLElement, target: Target) {
  const st = states.get(root);
  const sheet = st && resolveSheet(st, target), range = decodeRange(target.range);
  if (!st || !sheet || !range) return false;
  if (st.current !== sheet.index) { showSheet(root, sheet.index); emit(root, 'viewer-page', { index: sheet.index }); }
  const first = target.cells?.length ? decodeRange(target.cells[0])!.s : range.s;
  st.pending = sheet.idx.ownerOf(first.r, first.c);
  applyReveal(st);
  return true;
}

export function setZoom(root: HTMLElement, zoom: number) {
  const st = states.get(root);
  if (!st || Math.abs(st.zoom - zoom) < 0.001) return;
  st.zoom = zoom;
  mountGrid(root, st);
}

/** Called after the workspace re-inserts this element (it rebuilds the pane
 *  on every render). A detached element loses its scroll offsets without a
 *  scroll event, which would leave the grid drawing rows for the old position. */
export function attached(root: HTMLElement) {
  const st = states.get(root);
  if (!st) return;
  const view = viewportOf(st);
  if (view) { view.scrollTop = st.scroll.top; view.scrollLeft = st.scroll.left; }
  placeOverlay(st);
  applyReveal(st);
}

/** Puts keyboard focus back on the grid's focused cell, for when the
 *  workspace re-rendered while the reader was moving around the sheet. */
export function restoreFocus(root: HTMLElement) {
  const st = states.get(root), cell = st && focusedCell(st);
  if (st && cell) st.host.querySelector<HTMLElement>(`.ag-row[row-index="${cell.r}"] .ag-cell[col-id="c${cell.c}"]`)?.focus({ preventScroll: true });
}

export const selection = (root: HTMLElement) => { const st = states.get(root); return st ? anchorOf(st) : null; };

/** Clears the selection — only if it is still `range`, when given: the reader
 *  may have moved on while that selection was being saved. */
export function clearSelection(root: HTMLElement, range?: string) {
  const st = states.get(root);
  if (!st || !st.sel) return;
  if (range && anchorOf(st)?.range !== range) return;
  st.sel = null;
  repaint(st);
}

export function destroy(root: HTMLElement) {
  const st = states.get(root);
  if (!st) return;
  document.removeEventListener('mouseup', st.onMouseUp);
  st.api?.destroy();
  states.delete(root);
}

/** The top-left corner of the first sheet with data, as a plain table: the
 *  grid component is far too heavy for a thumbnail. Text only, escaped by the
 *  DOM (textContent), never parsed as HTML. */
export async function thumbnail(data: ArrayBuffer): Promise<{ element: HTMLElement; width: number; height: number }> {
  const sheets = readSheets(data);
  const sheet = sheets.find(s => s.range) || sheets[0];
  const table = document.createElement('table');
  table.className = 'thumb-sheet';
  const rows = Math.min(18, sheet?.range ? sheet.range.e.r + 1 : 0) || 12;
  const cols = Math.min(8, sheet?.range ? sheet.range.e.c + 1 : 0) || 6;
  let width = 34;
  const head = table.insertRow();
  head.className = 'thumb-sheet-head';
  head.insertCell().textContent = '';
  for (let c = 0; c < cols; c++) {
    const w = Math.min(160, sheet?.widths[c] || 72);
    width += w;
    const th = head.insertCell();
    th.textContent = XLSX.utils.encode_col(c);
    th.style.width = w + 'px';
  }
  for (let r = 0; r < rows; r++) {
    const tr = table.insertRow();
    tr.insertCell().textContent = String(r + 1);
    for (let c = 0; c < cols; c++) {
      const cell = sheet?.rows[r]?.[c];
      const td = tr.insertCell();
      const text = cell ? String(cell.w ?? cell.v ?? '') : '';
      td.textContent = text;
      if (typeof cell?.v === 'number') td.className = 'n';
    }
  }
  const root = document.createElement('div');
  root.className = 'thumb-xlsx';
  const tab = document.createElement('div');
  tab.className = 'thumb-sheet-tab';
  tab.textContent = sheet?.name || 'Sheet1';
  root.append(table, tab);
  return { element: root, width, height: 26 + rows * 24 + 30 };
}
