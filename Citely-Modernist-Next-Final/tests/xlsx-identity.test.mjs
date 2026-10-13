// The viewer must address exactly the cells the backend cites. The snapshot is
// what the backend's native pass emits (tests/test_xlsx_native.py pins that
// half); this checks SheetJS — what the viewer renders — sees the same cells
// with the same displayed text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { displayCell } from '../lib/cellvalue.mjs';
import { mergeIndex, encodeRange } from '../lib/sheet-model.mjs';

const dir = new URL('./fixtures/xlsx/', import.meta.url);
const snapshot = JSON.parse(readFileSync(new URL('native-units.json', dir), 'utf8')).units;

for (const [file, expected] of Object.entries(snapshot)) {
  test(`SheetJS sees the backend's cells in ${file}`, () => {
    const wb = XLSX.read(readFileSync(new URL(file, dir)), { cellDates: true, cellFormula: true, cellNF: true, sheetStubs: true, dense: true });
    const seen = new Map();
    wb.SheetNames.forEach((name, si) => {
      const ws = wb.Sheets[name], rows = ws?.['!data'];
      if (!rows) return;
      const index = mergeIndex(ws['!merges'] || []);
      rows.forEach((row, r) => row?.forEach((cell, c) => {
        if (!cell || index.isCovered(r, c)) return;
        const text = displayCell(cell).text.replace(/\s+/g, ' ').trim();
        if (!text || cell.t === 'z') return;
        const m = index.anchoredAt(r, c);
        seen.set(`${name}|${si}|${m ? encodeRange(m) : encodeRange({ s: { r, c }, e: { r, c } })}`, text);
      }));
    });
    const keys = expected.map(([name, si, range]) => `${name}|${si}|${range}`);
    assert.deepEqual([...seen.keys()].sort(), [...keys].sort());
    for (const [name, si, range, unit] of expected)
      assert.ok(unit.endsWith(seen.get(`${name}|${si}|${range}`)), `${name}!${range}: "${unit}" vs "${seen.get(`${name}|${si}|${range}`)}"`);
  });
}
