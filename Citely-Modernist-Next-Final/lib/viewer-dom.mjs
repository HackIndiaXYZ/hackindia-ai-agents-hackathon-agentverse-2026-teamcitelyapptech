// DOM side of locating passages in a rendered original: read its text,
// highlight a matched passage across however many text nodes it spans, and
// turn a reader's selection back into an anchor.

import { normalizeWithMap, resolveAnchor, toRaw } from './anchor.mjs';

const BLOCK = /^(P|DIV|LI|TD|TH|TR|H[1-6]|SECTION|ARTICLE|HEADER|FOOTER|TABLE|BR)$/;
const blockOf = node => {
  let el = node.parentElement;
  while (el && !BLOCK.test(el.tagName)) el = el.parentElement;
  return el;
};

/** The rendered text in reading order. A space is inserted wherever reading
 *  crosses from one block to another, so "end." + "Next" never fuses into
 *  "end.Next". Each segment records which raw range a text node owns. */
export function collectText(root) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentElement?.closest('style,script') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let raw = '', lastBlock = null, node;
  const segments = [];
  while ((node = walker.nextNode())) {
    const block = blockOf(node);
    if (raw && block !== lastBlock) raw += ' ';
    lastBlock = block;
    segments.push({ node, start: raw.length, end: raw.length + node.nodeValue.length });
    raw += node.nodeValue;
  }
  return { raw, segments, map: normalizeWithMap(raw) };
}

/** Finds an anchor in the collected text → raw [start, end) or a refusal. */
export function locate(collected, anchor) {
  const r = resolveAnchor(collected.map.text, anchor);
  if (r.status !== 'resolved') return r;
  return { status: 'resolved', ...toRaw(collected.map, r.index, r.index + r.length) };
}

/** Removes every highlight this module added and re-joins split text. */
export function clearMarks(root) {
  const marks = root.querySelectorAll('mark[data-viewer-mark]');
  const parents = new Set();
  for (const m of marks) { parents.add(m.parentNode); m.replaceWith(...m.childNodes); }
  for (const p of parents) p.normalize();
}

/** Paints several highlights at once. Each target is
 *  {start, end, classes: string[], id?: string} in raw collected coordinates.
 *  Overlapping targets share the overlapping text, carrying both classes. */
export function paintMarks(root, collected, targets) {
  const doc = root.ownerDocument;
  for (const seg of collected.segments) {
    const hits = targets.filter(t => t.start < seg.end && t.end > seg.start);
    if (!hits.length) continue;
    const text = seg.node.nodeValue;
    const cuts = new Set([0, text.length]);
    for (const t of hits) { cuts.add(Math.max(0, t.start - seg.start)); cuts.add(Math.min(text.length, t.end - seg.start)); }
    const points = [...cuts].sort((a, b) => a - b);
    const fragment = doc.createDocumentFragment();
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1]; if (a === b) continue;
      const piece = text.slice(a, b);
      const covering = hits.filter(t => t.start - seg.start < b && t.end - seg.start > a);
      if (!covering.length) { fragment.append(doc.createTextNode(piece)); continue; }
      const mark = doc.createElement('mark');
      mark.dataset.viewerMark = '';
      mark.className = [...new Set(covering.flatMap(t => t.classes))].join(' ');
      const withId = covering.find(t => t.id && !doc.getElementById(t.id));
      if (withId) { mark.id = withId.id; mark.tabIndex = -1; }
      mark.textContent = piece;
      fragment.append(mark);
    }
    seg.node.replaceWith(fragment);
  }
}

/** A reader's selection inside `root` → anchor in the rendered text, or null. */
export function selectionAnchor(root, collected, range, context = 48) {
  if (!range || range.collapsed || !root.contains(range.commonAncestorContainer)) return null;
  const inside = collected.segments.filter(s => range.intersectsNode(s.node));
  if (!inside.length) return null;
  const first = inside[0], last = inside[inside.length - 1];
  const rawStart = first.start + (first.node === range.startContainer ? range.startOffset : 0);
  const rawEnd = last.start + (last.node === range.endContainer ? range.endOffset : last.node.nodeValue.length);
  const { map } = collected;
  const toNorm = r => { let i = 0; while (i < map.end.length && map.end[i] <= r) i++; return i; };
  let a = toNorm(rawStart), b = toNorm(rawEnd);
  while (a < b && map.text[a] === ' ') a++;
  while (b > a && map.text[b - 1] === ' ') b--;
  if (b <= a) return null;
  return { quote: map.text.slice(a, b), before: map.text.slice(Math.max(0, a - context), a), after: map.text.slice(b, b + context) };
}
