import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLineRects } from '../lib/rects.mjs';

const r = (left, top, width, height = 18) => ({ left, top, width, height });

test('nested boxes for the same words become one box per line', () => {
  // A line box, and the two spans inside it, each reported separately.
  const merged = mergeLineRects([r(100, 50, 300), r(100, 50, 120), r(220, 51, 180, 17), r(100, 72, 200)]);
  assert.deepEqual(merged, [r(100, 50, 300), r(100, 72, 200)]);
});

test('touching pieces on a line join; a real gap keeps two boxes', () => {
  assert.deepEqual(mergeLineRects([r(0, 0, 50), r(51, 0, 50)]), [r(0, 0, 101)]);
  assert.deepEqual(mergeLineRects([r(0, 0, 50), r(80, 0, 50)]), [r(0, 0, 50), r(80, 0, 50)]);
});

test('empty boxes are dropped, and no point is covered twice', () => {
  const merged = mergeLineRects([r(0, 0, 0), r(10, 10, 40), r(20, 12, 10, 10), r(0, 0, 5, 0)]);
  assert.equal(merged.length, 1);
  for (let x = 0; x < 60; x += 1) {
    const covering = merged.filter(b => x >= b.left && x < b.left + b.width && 15 >= b.top && 15 < b.top + b.height);
    assert.ok(covering.length <= 1);
  }
});
