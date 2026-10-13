import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot, saveSnapshot, clearSnapshots } from '../lib/snapshot.mjs';

function memoryStorage(limit = Infinity) {
  const m = new Map();
  return {
    get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (v.length > limit) throw Error('QuotaExceededError'); m.set(k, String(v)); },
    removeItem: k => m.delete(k), _map: m,
  };
}
const snap = (id, extra = {}) => ({ user: { id, name: 'N', email: 'e' }, catalog: { orgs: [] }, documents: [], desk: null, ...extra });

test('saves and loads per user; another user never sees it', () => {
  const s = memoryStorage();
  assert.equal(saveSnapshot(snap('u1', { desk: { id: 'd1' } }), s), true);
  assert.equal(loadSnapshot('u1', s).desk.id, 'd1');
  assert.equal(loadSnapshot('u2', s), null);
});

test('a snapshot stored under the wrong user or in an old format is ignored', () => {
  const s = memoryStorage();
  s.setItem('citely.snapshot.v1.u1', JSON.stringify({ v: 1, user: { id: 'u2' }, catalog: {} }));
  assert.equal(loadSnapshot('u1', s), null);
  s.setItem('citely.snapshot.v1.u3', '{not json');
  assert.equal(loadSnapshot('u3', s), null);
});

test('too big: the conversation is dropped first; a full quota just means no snapshot', () => {
  const s = memoryStorage();
  assert.equal(saveSnapshot(snap('u1', { desk: { work: { notes: 'x'.repeat(2_000_000) } } }), s), true);
  assert.equal(loadSnapshot('u1', s).desk, null);
  assert.equal(saveSnapshot(snap('u2'), memoryStorage(10)), false);
});

test('sign-out clears every snapshot and nothing else', () => {
  const s = memoryStorage();
  saveSnapshot(snap('u1'), s); saveSnapshot(snap('u2'), s); s.setItem('rag.theme', 'dark');
  clearSnapshots(s);
  assert.deepEqual([...s._map.keys()], ['rag.theme']);
});
