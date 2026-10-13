import test from 'node:test';
import assert from 'node:assert/strict';
import { createWaker, WakeTimeoutError, WakeCancelledError } from '../lib/wake-core.mjs';

// A fake clock: sleep advances time instantly, so a 180 s budget runs in ms.
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

test('a ready server resolves on the first probe and never announces waking', async () => {
  const c = clock(), states = [];
  let probes = 0;
  const w = createWaker({ probe: async () => { probes++; return { ready: true }; }, now: c.now, sleep: c.sleep });
  await w.ensureAwake({ budgetMs: 180_000, onState: (s) => states.push(s) });
  assert.equal(probes, 1);
  assert.deepEqual(states, ['ready']);
});

test('waits through a cold start longer than the old 75 s auth timeout', async () => {
  const c = clock(), states = [];
  // Becomes ready 136 s in — the measured dev cold start.
  const w = createWaker({ probe: async () => ({ ready: c.now() >= 136_000 }), now: c.now, sleep: c.sleep });
  await w.ensureAwake({ budgetMs: 180_000, onState: (s) => states.push(s) });
  assert.ok(c.now() >= 136_000);
  assert.deepEqual(states, ['waking', 'ready'], 'waking announced exactly once');
});

test('probe errors (network, 503) are treated as not-ready, not as failure', async () => {
  const c = clock();
  let n = 0;
  const w = createWaker({
    probe: async () => { n++; if (n < 4) throw new Error('503'); return { ready: true }; },
    now: c.now, sleep: c.sleep,
  });
  await w.ensureAwake({ budgetMs: 180_000 });
  assert.equal(n, 4);
});

test('the budget is a hard bound: times out instead of waiting forever', async () => {
  const c = clock();
  const w = createWaker({ probe: async () => ({ ready: false }), now: c.now, sleep: c.sleep });
  await assert.rejects(w.ensureAwake({ budgetMs: 180_000 }), WakeTimeoutError);
  assert.ok(c.now() <= 180_000 + 5_000, `overran the budget: ${c.now()}`);
});

test('backoff grows and is capped', async () => {
  const c = clock(), waits = [];
  const w = createWaker({
    probe: async () => ({ ready: false }), now: c.now,
    sleep: async (ms) => { waits.push(ms); c.advance(ms); },
  });
  await assert.rejects(w.ensureAwake({ budgetMs: 30_000 }), WakeTimeoutError);
  assert.deepEqual(waits.slice(0, 5), [500, 1000, 2000, 4000, 5000]);
  assert.ok(waits.every((ms) => ms <= 5000));
});

test('concurrent callers share one wake (single flight)', async () => {
  let probes = 0, release;
  const gate = new Promise((r) => { release = r; });
  const w = createWaker({
    probe: async () => { probes++; await gate; return { ready: true }; },
    sleep: async () => {},
  });
  const a = w.ensureAwake({ budgetMs: 10_000 });
  const b = w.ensureAwake({ budgetMs: 10_000 });
  const c2 = w.ensureAwake({ budgetMs: 10_000 });
  assert.equal(w.isWaking(), true);
  release();
  await Promise.all([a, b, c2]);
  assert.equal(probes, 1, 'three callers, one probe');
});

test('cancellation rejects only the cancelling caller; the shared wake continues', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const w = createWaker({ probe: async () => { await gate; return { ready: true }; }, sleep: async () => {} });
  const ctrl = new AbortController();
  const cancelled = w.ensureAwake({ budgetMs: 10_000, signal: ctrl.signal });
  const other = w.ensureAwake({ budgetMs: 10_000 });
  ctrl.abort();
  await assert.rejects(cancelled, WakeCancelledError);
  release();
  await other; // still resolves
});

test('an already-aborted signal rejects immediately without probing', async () => {
  let probes = 0;
  const w = createWaker({ probe: async () => { probes++; return { ready: true }; } });
  const ctrl = new AbortController(); ctrl.abort();
  await assert.rejects(w.ensureAwake({ signal: ctrl.signal }), WakeCancelledError);
  assert.equal(probes, 0);
});

test('recovers after a timeout: the next attempt starts a fresh wake', async () => {
  const c = clock();
  let up = false;
  const w = createWaker({ probe: async () => ({ ready: up }), now: c.now, sleep: c.sleep });
  await assert.rejects(w.ensureAwake({ budgetMs: 10_000 }), WakeTimeoutError);
  assert.equal(w.isWaking(), false, 'no stuck in-flight wake after failure');
  up = true;
  await w.ensureAwake({ budgetMs: 10_000 });
});

test('a recently confirmed server skips the probe; markUnknown forces a re-check', async () => {
  const c = clock();
  let probes = 0;
  const w = createWaker({ probe: async () => { probes++; return { ready: true }; }, now: c.now, sleep: c.sleep });
  await w.ensureAwake({ budgetMs: 10_000 });
  await w.ensureAwake({ budgetMs: 10_000 });
  assert.equal(probes, 1);
  w.markUnknown();
  await w.ensureAwake({ budgetMs: 10_000 });
  assert.equal(probes, 2);
  c.advance(61_000); // beyond the ready TTL
  await w.ensureAwake({ budgetMs: 10_000 });
  assert.equal(probes, 3);
});
