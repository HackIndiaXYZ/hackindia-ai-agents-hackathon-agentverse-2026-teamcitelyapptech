import test from 'node:test';
import assert from 'node:assert/strict';
import { colName, decodeCell, decodeRange, encodeRange, mergeIndex, snapToMerges, targetCells, rangeText } from '../lib/sheet-model.mjs';
import { displayCell } from '../lib/cellvalue.mjs';

test('A1 addressing round-trips, including far columns', () => {
  assert.deepEqual([colName(0), colName(25), colName(26), colName(119), colName(16383)], ['A', 'Z', 'AA', 'DP', 'XFD']);
  assert.deepEqual(decodeCell('DP59'), { r: 58, c: 119 });
  assert.equal(decodeCell('A0'), null);
  assert.deepEqual(decodeRange('C5:A2'), { s: { r: 1, c: 0 }, e: { r: 4, c: 2 } });
  assert.equal(encodeRange(decodeRange('B100:B180')), 'B100:B180');
  assert.equal(encodeRange(decodeRange('B5')), 'B5');
});

const merges = [decodeRange('B5:B9'), decodeRange('C12:D15'), decodeRange('B1:D1')];

test('merged cells are painted once, on their top-left, never on covered cells', () => {
  const index = mergeIndex(merges);
  assert.deepEqual([...targetCells({ range: 'B7' }, index)], ['4,1']);           // inside B5:B9 → B5
  assert.deepEqual([...targetCells({ range: 'B5:B9' }, index)], ['4,1']);
  assert.deepEqual([...targetCells({ range: 'C12:D15' }, index)], ['11,2']);
  assert.equal(targetCells({ range: 'A1:D20' }, index).size, 4 * 20 - (5 - 1) - (8 - 1) - (3 - 1));
  assert.deepEqual([...targetCells({ range: 'A5:D5', cells: ['B5', 'D5'] }, index)].sort(), ['4,1', '4,3']);
  assert.equal(targetCells({ range: 'nonsense' }, index), null);
  assert.equal(targetCells({ range: 'A1:Z10000' }, index), null);                 // too large to enumerate
  assert.equal(index.isCovered(6, 1), true);
  assert.equal(index.isCovered(4, 1), false);
});

test('a selection grows to whole merges, including merges reached by growing', () => {
  const chain = [decodeRange('B2:B4'), decodeRange('B4:C4'), decodeRange('C4:C8')];
  assert.equal(encodeRange(snapToMerges(decodeRange('A3'), merges)), 'A3');
  assert.equal(encodeRange(snapToMerges(decodeRange('B7'), merges)), 'B5:B9');
  assert.equal(encodeRange(snapToMerges(decodeRange('A2:B6'), merges)), 'A2:B9');
  assert.equal(encodeRange(snapToMerges(decodeRange('B2'), [decodeRange('B2:B3'), decodeRange('B3:D3'), decodeRange('D3:D6')])), 'B2:D6');
  assert.equal(encodeRange(snapToMerges(decodeRange('B3'), chain)), 'B2:C8');
});

test('the quote of a selection is the shown text, row by row', () => {
  const index = mergeIndex([decodeRange('A1:B1')]);
  const text = { '0,0': 'Title', '0,1': 'hidden', '1,0': 'Region', '1,1': 'Q3', '2,0': 'Nordics', '2,1': '3,910,000' };
  assert.equal(rangeText(decodeRange('A1:B3'), index, (r, c) => text[r + ',' + c]), 'Title\nRegion | Q3\nNordics | 3,910,000');
});

test('formula display branches on type: a computed zero is 0, an uncalculated formula is —', () => {
  const cases = [
    [{ t: 'n', v: 0, w: '0' }, '0', 'literal'],
    [{ t: 'n', v: 0, w: '0', f: 'B3*0' }, '0', 'formula-cached'],
    [{ t: 'z', v: 0, f: 'B2+B3' }, '—', 'formula-uncalculated'],
    [{ t: 'z' }, '', 'blank'],
    [{ t: 'e', w: '#DIV/0!', f: '1/0' }, '#DIV/0!', 'formula-error'],
    [{ t: 's', v: 'ab', f: 'CONCATENATE("a","b")' }, 'ab', 'formula-cached'],
    [{ t: 'b', v: true, w: 'TRUE' }, 'TRUE', 'literal'],
    [{ t: 'd', v: new Date(Date.UTC(2026, 2, 31)), w: '2026-03-31' }, '2026-03-31', 'literal'],
    [{ t: 'n', v: 12345, w: '12,345', f: 'B2+B3' }, '12,345', 'formula-cached'],
    [undefined, '', 'empty'],
  ];
  for (const [cell, text, kind] of cases) assert.deepEqual([displayCell(cell).text, displayCell(cell).kind], [text, kind]);
});
