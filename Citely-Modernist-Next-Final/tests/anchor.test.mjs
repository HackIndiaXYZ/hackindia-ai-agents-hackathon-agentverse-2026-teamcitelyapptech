import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeWithMap, normalize, anchorFromRaw, resolveAnchor, toRaw, locateOnPages } from '../lib/anchor.mjs';

const fx = name => readFileSync(new URL('./fixtures/docx/' + name, import.meta.url), 'utf8');
const occ = (T, q) => { const a = []; let i = -1; while ((i = T.indexOf(q, i + 1)) >= 0) a.push(i); return a; };

test('normalisation folds spacing, quotes and dashes, and maps back to raw text', () => {
  const raw = 'A  B  “q” — x\n\ny';
  const m = normalizeWithMap(raw);
  assert.equal(m.text, 'A B "q" - x y');
  assert.equal(m.start.length, m.text.length);
  const i = m.text.indexOf('"q"'); const r = toRaw(m, i, i + 3);
  assert.equal(raw.slice(r.start, r.end), '“q”');
});

test('decomposed and composed accents match each other', () => {
  assert.equal(normalize('café'), normalize('café'));
});

test('anchors round-trip from page offsets to the same raw passage', () => {
  const page = fx('sample.azure.txt'); const q = 'CITATION_TARGET_B: enterprise revenue 62%';
  const s = page.indexOf(q); const a = anchorFromRaw(page, s, s + q.length);
  const m = normalizeWithMap(page); const r = resolveAnchor(m.text, a);
  assert.equal(r.status, 'resolved');
  const back = toRaw(m, r.index, r.index + r.length);
  assert.equal(page.slice(back.start, back.end), q);
});

test('ambiguity is refused, never guessed', () => {
  const T = normalize(fx('ambiguous.rendered.txt')), Q = normalize('The margin improved materially this quarter.');
  for (const [name, anchor] of [
    ['no context, 4 duplicates', { quote: Q, before: '', after: '' }],
    ['1-character context', { quote: Q, before: ' ', after: ' ' }],
    ['context from another document', { quote: Q, before: 'zzz nothing like this zzz', after: 'qqq also wrong qqq' }],
  ]) assert.equal(resolveAnchor(T, anchor).status, 'ambiguous', name);
  assert.equal(resolveAnchor(T, { quote: 'This sentence is not in the document', before: '', after: '' }).status, 'not_found');
  assert.equal(resolveAnchor(T, { quote: Q, before: 'Middle bravo. ', after: ' Middle charlie.' }).status, 'resolved');
});

// Every line of the stored (Azure DI) text treated as a saved highlight and
// placed in the rendered original; ground truth by occurrence ordinal.
for (const [label, azure, rendered, headerFooter] of [
  ['sample.docx', 'sample.azure.txt', 'sample.rendered.txt', ['HEADER: Citely', 'FOOTER: page footer']],
  ['ambiguous.docx', 'ambiguous.azure.txt', 'ambiguous.rendered.txt', ['Repeated header line']],
]) test(`existing highlights land on the right passage or are refused: ${label}`, () => {
  const az = fx(azure), AZ = normalizeWithMap(az).text, DOM = normalizeWithMap(fx(rendered)).text;
  const seen = new Map(); let correct = 0, wrong = 0, refused = 0;
  for (const line of az.split('\n')) {
    const q = normalize(line); if (q.length < 4 || headerFooter.some(h => q.includes(h))) continue;
    const k = seen.get(q) || 0; seen.set(q, k + 1);
    const at = occ(AZ, q)[k];
    const r = resolveAnchor(DOM, { quote: q, before: AZ.slice(Math.max(0, at - 48), at), after: AZ.slice(at + q.length, at + q.length + 48) });
    if (r.status !== 'resolved') { refused++; continue; }
    occ(DOM, q).indexOf(r.index) === k ? correct++ : wrong++;
  }
  assert.equal(wrong, 0, `${wrong} highlights would be misplaced`);
  assert.ok(correct >= (label === 'sample.docx' ? 300 : 11), `only ${correct} placed`);
});

test('a selection in the original is placed on exactly one extracted page', () => {
  const pages = [{ page: 1, text: 'Alpha intro. Shared line here.' }, { page: 2, text: 'Beta body. Unique sentence on page two. Shared line here.' }];
  const sel = { quote: 'Unique sentence on page two.', before: 'Beta body. ', after: ' Shared line' };
  const r = locateOnPages(sel, pages);
  assert.equal(r.status, 'resolved'); assert.equal(r.page, 2);
  assert.equal(pages[1].text.slice(r.start, r.end), 'Unique sentence on page two.');
  assert.notEqual(locateOnPages({ quote: 'Shared line here.', before: '', after: '' }, pages).status, 'resolved');
});

test('a soft hyphen the PDF draws as a hyphen matches the space its text layer reports', () => {
  const extracted = 'Data structures that are directly operated upon the machine\u00adlevel instructions.';
  const rendered = 'Data structures that are directly operated upon the machine level instructions.';
  assert.equal(normalize(extracted), normalize(rendered));
  const map = normalizeWithMap(extracted);
  assert.ok(!map.text.includes('\u00ad'));
  assert.equal(map.text.length, map.start.length);               // every kept character still maps back to the raw text
  const i = map.text.indexOf('level'), raw = toRaw(map, i, i + 5);
  assert.equal(extracted.slice(raw.start, raw.end), 'level');
});

test('a ligature in the extracted text matches its letters on the rendered page, and maps back to the raw character', () => {
  const extracted = 'This procedure \ufb01nds the o\ufb03cial \ufb02oor.';
  assert.equal(normalize(extracted), normalize('This procedure finds the official floor.'));
  const map = normalizeWithMap(extracted);
  assert.equal(map.text.length, map.start.length);
  const i = map.text.indexOf('finds'), raw = toRaw(map, i, i + 5);
  assert.equal(extracted.slice(raw.start, raw.end), '\ufb01nds');       // the whole ligature is covered, never half of it
});
