// Locating a passage of the stored extracted text inside a rendered original.
//
// Citations and highlights are anchored to the document's extracted text
// (page number + character offsets). A rendered original (DOCX, ...) lays the
// same words out differently: headers repeat on every page, whitespace and some
// characters differ, so offsets cannot be replayed. Instead a passage is found
// by its quote plus the text around it, and the match is accepted only when it
// is unambiguous. Measured against real Azure Document Intelligence output:
// 313 of 315 passages placed, 0 misplaced, 2 refused.

const FOLD = new Map([
  [' ', ' '], [' ', ' '], [' ', ' '], ['⁠', ''], ['​', ''], ['﻿', ''],
  ['‘', "'"], ['’', "'"], ['“', '"'], ['”', '"'],
  ['‐', '-'], ['‑', '-'], ['‒', '-'], ['–', '-'], ['—', '-'], ['―', '-'],
]);
// A soft hyphen is a hyphenation mark that PDFs (and PowerPoint exports) often draw as a
// real hyphen, and that a PDF text layer then reports as a space: "machine\u00adlevel" is
// "machine level" on the rendered page. Treating it as a separator makes both sides agree.
FOLD.set('\u00ad', ' ');
// Typographic ligatures are one character in some extractions and their letters in others.
for (const [ligature, letters] of [['\ufb00', 'ff'], ['\ufb01', 'fi'], ['\ufb02', 'fl'], ['\ufb03', 'ffi'], ['\ufb04', 'ffl'], ['\ufb05', 'st'], ['\ufb06', 'st']]) FOLD.set(ligature, letters);
const isSpace = c => /\s/.test(c);
const isMark = c => /\p{M}/u.test(c);

/** Normalises text for matching while remembering, for every output
 *  character, the raw range [start[i], end[i]) it came from. */
export function normalizeWithMap(raw) {
  let text = '';
  const start = [], end = [];
  let i = 0;
  while (i < raw.length) {
    let j = i + 1;
    if (raw.charCodeAt(i) >= 0xd800 && raw.charCodeAt(i) <= 0xdbff && j < raw.length) j++;   // surrogate pair
    while (j < raw.length && isMark(raw[j])) j++;                                            // combining marks
    let piece = raw.slice(i, j).normalize('NFC');
    piece = [...piece].map(c => (FOLD.has(c) ? FOLD.get(c) : c)).join('');
    for (const c of piece) {
      if (isSpace(c)) {
        if (!text.length || text[text.length - 1] === ' ') { if (text.length) end[end.length - 1] = j; continue; }
        text += ' '; start.push(i); end.push(j);
      } else {
        text += c; for (let k = 0; k < c.length; k++) { start.push(i); end.push(j); }
      }
    }
    i = j;
  }
  return { text, start, end };
}

export const normalize = raw => normalizeWithMap(raw).text.trim();

/** Normalised index of the first output character at or after raw index r. */
function toNormalized(map, r) {
  let lo = 0, hi = map.start.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (map.end[mid] <= r) lo = mid + 1; else hi = mid; }
  return lo;
}

const CONTEXT = 48;

/** Anchor for raw offsets [rawStart, rawEnd) of `raw` (e.g. a page's text). */
export function anchorFromRaw(raw, rawStart, rawEnd, map = normalizeWithMap(raw)) {
  let a = toNormalized(map, rawStart), b = toNormalized(map, rawEnd);
  while (a < b && map.text[a] === ' ') a++;
  while (b > a && map.text[b - 1] === ' ') b--;
  if (b <= a) return null;
  return {
    quote: map.text.slice(a, b),
    before: map.text.slice(Math.max(0, a - CONTEXT), a),
    after: map.text.slice(b, b + CONTEXT),
  };
}

function endsMatch(a, b) {          // shared suffix length / longer length
  const n = Math.min(a.length, b.length); if (!n) return a.length || b.length ? 0 : 1;
  let m = 0; while (m < n && a[a.length - 1 - m] === b[b.length - 1 - m]) m++;
  return m / Math.max(a.length, b.length);
}
function startsMatch(a, b) {        // shared prefix length / longer length
  const n = Math.min(a.length, b.length); if (!n) return a.length || b.length ? 0 : 1;
  let m = 0; while (m < n && a[m] === b[m]) m++;
  return m / Math.max(a.length, b.length);
}

/** Finds `anchor` in normalised text `T`.
 *  → {status:'resolved', index} | {status:'ambiguous', reason} | {status:'not_found'} */
export function resolveAnchor(T, anchor, { minScore = 0.6, minMargin = 0.15, minDistinctiveLen = 20 } = {}) {
  const Q = anchor?.quote;
  if (!Q) return { status: 'not_found' };
  const hits = []; let i = -1;
  while ((i = T.indexOf(Q, i + 1)) >= 0) hits.push(i);
  if (!hits.length) return { status: 'not_found' };
  const scored = hits.map(h => ({
    index: h,
    score: (endsMatch(anchor.before, T.slice(Math.max(0, h - anchor.before.length), h))
          + startsMatch(anchor.after, T.slice(h + Q.length, h + Q.length + anchor.after.length))) / 2,
  })).sort((a, b) => b.score - a.score);
  const [best, runner] = scored;
  // A quote unique in the target and long enough to be distinctive is trusted
  // even where its surroundings differ (a page break that repeats a header).
  const distinctive = hits.length === 1 && Q.length >= minDistinctiveLen;
  if (best.score < minScore && !distinctive) return { status: 'ambiguous', reason: 'low context confidence', candidates: hits.length };
  if (runner && best.score - runner.score < minMargin) return { status: 'ambiguous', reason: 'tie between candidates', candidates: hits.length };
  return { status: 'resolved', index: best.index, length: Q.length, candidates: hits.length };
}

/** Maps normalised [a, b) back to raw [start, end) through `map`. */
export function toRaw(map, a, b) {
  return { start: map.start[a], end: map.end[b - 1] };
}

/** Places a passage chosen in a rendered original back onto the extracted
 *  pages. Exactly one page must resolve; anything else is refused.
 *  pages: [{page, text}] → {page, start, end} | {status, reason} */
export function locateOnPages(anchor, pages) {
  const found = [];
  for (const p of pages) {
    const map = normalizeWithMap(p.text);
    const r = resolveAnchor(map.text, anchor);
    if (r.status === 'resolved') found.push({ page: p.page, ...toRaw(map, r.index, r.index + r.length) });
    else if (r.status === 'ambiguous') return { status: 'ambiguous', reason: r.reason };
  }
  if (found.length === 1) return { status: 'resolved', ...found[0] };
  return found.length ? { status: 'ambiguous', reason: 'passage appears on more than one page' } : { status: 'not_found' };
}
