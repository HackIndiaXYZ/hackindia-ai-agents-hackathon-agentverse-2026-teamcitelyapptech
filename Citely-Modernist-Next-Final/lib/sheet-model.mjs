// Spreadsheet addressing for the viewer: A1 ranges, merges, and which cells a
// citation, saved highlight or selection covers. DOM-free, so it is tested on
// its own. Rows and columns are 0-based here; A1 strings are what the backend
// sends ("B5", "A2:D9", a merge such as "B100:B180").

export function colName(c) {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function decodeCell(a1) {
  const m = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(a1 || '');
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}

export function decodeRange(a1) {
  const [a, b = a] = String(a1 || '').split(':');
  const s = decodeCell(a), e = decodeCell(b);
  if (!s || !e) return null;
  return { s: { r: Math.min(s.r, e.r), c: Math.min(s.c, e.c) }, e: { r: Math.max(s.r, e.r), c: Math.max(s.c, e.c) } };
}

export function encodeRange({ s, e }) {
  const a = colName(s.c) + (s.r + 1), b = colName(e.c) + (e.r + 1);
  return a === b ? a : a + ':' + b;
}

const inside = (m, r, c) => r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c;
const overlaps = (a, b) => a.s.r <= b.e.r && a.e.r >= b.s.r && a.s.c <= b.e.c && a.e.c >= b.s.c;

/** Lookups over a sheet's merges ({s:{r,c}, e:{r,c}}, as SheetJS reports them). */
export function mergeIndex(merges = []) {
  const byAnchor = new Map(merges.map(m => [m.s.r + ',' + m.s.c, m]));
  // Bucket by row so a lookup scans only merges that can contain that row.
  const byRow = new Map();
  for (const m of merges) for (let r = m.s.r; r <= m.e.r; r++) (byRow.get(r) || byRow.set(r, []).get(r)).push(m);
  const containing = (r, c) => (byRow.get(r) || []).find(m => inside(m, r, c)) || null;
  return {
    merges,
    containing,
    anchoredAt: (r, c) => byAnchor.get(r + ',' + c) || null,
    /** A cell hidden under a merge (every merged cell except its top-left). */
    isCovered: (r, c) => { const m = containing(r, c); return !!m && !(m.s.r === r && m.s.c === c); },
    /** The cell that owns (r, c): itself, or its merge's top-left. */
    ownerOf: (r, c) => { const m = containing(r, c); return m ? m.s : { r, c }; },
  };
}

/** Grows a range until no merge is cut by its edge, so a selection never
 *  holds half a merged cell. Iterates because growing can reach new merges. */
export function snapToMerges(range, merges = []) {
  let out = { s: { ...range.s }, e: { ...range.e } }, grown = true;
  while (grown) {
    grown = false;
    for (const m of merges) {
      if (!overlaps(out, m)) continue;
      const next = { s: { r: Math.min(out.s.r, m.s.r), c: Math.min(out.s.c, m.s.c) }, e: { r: Math.max(out.e.r, m.e.r), c: Math.max(out.e.c, m.e.c) } };
      if (next.s.r !== out.s.r || next.s.c !== out.s.c || next.e.r !== out.e.r || next.e.c !== out.e.c) { out = next; grown = true; }
    }
  }
  return out;
}

export const MAX_TARGET_CELLS = 200_000;

/** The cells to paint for a target: each named cell (or every cell of its
 *  range) mapped onto its owner, so a merge is painted once and its covered
 *  cells never. Returns a Set of "r,c" keys, or null when the target is too
 *  large to enumerate or names nothing valid. */
export function targetCells(target, index) {
  const ranges = (target.cells?.length ? target.cells : [target.range]).map(decodeRange);
  if (ranges.some(r => !r)) return null;
  let count = 0;
  for (const r of ranges) count += (r.e.r - r.s.r + 1) * (r.e.c - r.s.c + 1);
  if (count > MAX_TARGET_CELLS) return null;
  const keys = new Set();
  for (const range of ranges)
    for (let r = range.s.r; r <= range.e.r; r++)
      for (let c = range.s.c; c <= range.e.c; c++) { const o = index.ownerOf(r, c); keys.add(o.r + ',' + o.c); }
  return keys;
}

/** The text a range shows, row by row: owners only, empty cells skipped. */
export function rangeText(range, index, textAt) {
  const lines = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const parts = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (index.isCovered(r, c)) continue;
      const t = textAt(r, c);
      if (t) parts.push(t);
    }
    if (parts.length) lines.push(parts.join(' | '));
  }
  return lines.join('\n');
}
