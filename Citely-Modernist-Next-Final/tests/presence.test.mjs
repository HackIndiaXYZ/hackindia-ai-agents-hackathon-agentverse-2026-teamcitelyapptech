import test from 'node:test';
import assert from 'node:assert/strict';
import { whilePresent, workspacePresence, PRESENCE } from '../lib/presence.mjs';

/** A fake page: a clock, timers, a document with visibility, and input events. */
function fakePage() {
  let t = 0, nextId = 1;
  const timers = new Map(), listeners = {};
  const target = () => ({ addEventListener: (k, f) => (listeners[k] ||= []).push(f), removeEventListener: (k, f) => { listeners[k] = (listeners[k] || []).filter(x => x !== f); } });
  const doc = { visibilityState: 'visible', ...target() }, win = target();
  return {
    doc, win, now: () => t,
    setTimer: (f, ms) => { const id = nextId++; timers.set(id, { f, at: t + ms }); return id; },
    clearTimer: id => timers.delete(id),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = due[1].at; due[1].f();
      }
      t = end;
    },
    input(type = 'pointerdown') { for (const f of listeners[type] || []) f({ type }); },
    hide() { doc.visibilityState = 'hidden'; for (const f of listeners.visibilitychange || []) f(); },
    show() { doc.visibilityState = 'visible'; for (const f of listeners.visibilitychange || []) f(); },
    pagehide() { for (const f of listeners.pagehide || []) f(); },
  };
}
const MIN = 60_000;

test('runs every 3 minutes while someone is active, and stops 10 minutes after the last input', () => {
  const p = fakePage(); let runs = 0;
  whilePresent({ run: () => runs++, ...p });
  assert.equal(runs, 1);                                   // immediately
  p.advance(6 * MIN);
  assert.equal(runs, 3);                                   // 0, 3, 6
  p.advance(30 * MIN);                                     // no input since t=0
  assert.equal(runs, 4);                                   // ...9 — then stops (10-min idle)
});

test('input keeps it going; returning after a pause runs at once', () => {
  const p = fakePage(); let runs = 0;
  whilePresent({ run: () => runs++, ...p });
  for (let i = 0; i < 6; i++) { p.advance(10 * MIN); p.input(); }
  assert.equal(runs, 21);                                  // never paused in an hour of activity
  p.advance(60 * MIN);                                     // walked away
  const before = runs;
  p.input('keydown');                                      // back
  assert.equal(runs, before + 1);
});

test('a hidden tab never runs; showing it again runs at once', () => {
  const p = fakePage(); let runs = 0;
  whilePresent({ run: () => runs++, ...p });
  p.hide();
  p.advance(60 * MIN);
  assert.equal(runs, 1);
  p.show();
  assert.equal(runs, 2);
});

test('waitForInput: nothing runs until a person does something (bots never wake the server)', () => {
  const p = fakePage(); let runs = 0;
  whilePresent({ run: () => runs++, waitForInput: true, ...p });
  p.advance(60 * MIN);
  assert.equal(runs, 0);
  p.input('scroll');
  assert.equal(runs, 1);
});

test('pointer movement counts as presence, throttled; stop() ends everything', () => {
  const p = fakePage(); let runs = 0;
  const h = whilePresent({ run: () => runs++, waitForInput: true, ...p });
  for (let i = 0; i < 50; i++) p.input('pointermove');
  assert.equal(runs, 1);
  h.stop();
  p.advance(60 * MIN); p.input();
  assert.equal(runs, 1);
});

/** A workspace tab's presence with a recording server; `flush` lets sent
 *  signals resolve (they are promises). */
function tab({ awake = true } = {}) {
  const p = fakePage(), sent = [], warms = [];
  let isReady = awake;
  const h = workspacePresence({ ...p, ready: () => isReady, warm: () => warms.push(p.now()),
    send: (signal, leaving) => { sent.push({ ...signal, leaving, at: p.now() }); return leaving ? undefined : Promise.resolve(); } });
  const states = () => sent.map(s => s.state);
  return { p, h, sent, warms, states, wake: () => { isReady = true; }, flush: () => new Promise(r => setImmediate(r)) };
}

test('presence: active once a minute while visible and used; the first one marks the visit', async () => {
  const t = tab();
  assert.deepEqual(t.sent.map(s => [s.state, s.seq, !!s.first]), [['active', 1, true]]);
  await t.flush();
  t.p.advance(3 * MIN);
  assert.deepEqual(t.states(), ['active', 'active', 'active', 'active']);
  assert.ok(t.sent.slice(1).every(s => !s.first));
  assert.ok(t.sent.every((s, i) => s.seq === i + 1));        // the server ignores anything older than it has
});

test('presence: no input for 5 minutes is idle, input is active again at once, 10 minutes stops it', async () => {
  const t = tab();
  await t.flush();
  t.p.advance(7 * MIN);
  assert.deepEqual(t.states(), ['active', 'active', 'active', 'active', 'active', 'idle', 'idle', 'idle']);
  t.p.input('keydown');
  assert.equal(t.states().at(-1), 'active');                  // not a minute later
  const n = t.sent.length;
  t.p.advance(60 * MIN);                                       // walked away
  assert.ok(t.sent.length - n <= 10);                          // the keep-warm window, then nothing
  const settled = t.sent.length;
  t.p.advance(60 * MIN);
  assert.equal(t.sent.length, settled);
});

test('presence: hiding sends hidden, showing again sends active at once', async () => {
  const t = tab();
  await t.flush();
  t.p.advance(30_000);
  t.p.hide();
  assert.deepEqual(t.sent.at(-1), { state: 'hidden', seq: 2, leaving: true, at: 30_000 });
  t.p.advance(30 * MIN);
  assert.equal(t.sent.length, 2);                              // a hidden tab sends nothing
  t.p.show();
  assert.equal(t.states().at(-1), 'active');
});

test('presence: closing the page sends closed', async () => {
  const t = tab();
  await t.flush();
  t.p.hide();
  t.p.pagehide();
  assert.deepEqual(t.states(), ['active', 'hidden', 'closed']);
});

test('presence: leaving after the server may have gone to sleep sends nothing (it must not be woken)', async () => {
  const t = tab();
  await t.flush();
  t.p.hide();                                                  // hidden: sent
  t.p.advance(PRESENCE.awakeMs + 1);
  t.p.pagehide();                                              // closed much later: not sent
  assert.deepEqual(t.states(), ['active', 'hidden']);
});

test('presence: before the server is awake it only warms it; leaving then says nothing', async () => {
  const t = tab({ awake: false });
  assert.equal(t.sent.length, 0);
  assert.equal(t.warms.length, 1);
  t.p.hide(); t.p.pagehide();
  assert.equal(t.sent.length, 0);                              // never reached the server: nothing to undo
  t.p.show();
  t.wake();
  t.h.beat();
  assert.deepEqual(t.sent.map(s => [s.state, !!s.first]), [['active', true]]);
});

test('presence: beat() does nothing while the tab is hidden', () => {
  const t = tab({ awake: false });
  t.p.hide();
  t.wake();
  t.h.beat();
  assert.equal(t.sent.length, 0);
});

test('presence: stop() (signed out) silences the tab for good', async () => {
  const t = tab();
  await t.flush();
  t.h.stop();
  t.p.advance(10 * MIN); t.p.input(); t.p.hide(); t.p.pagehide(); t.p.show();
  assert.equal(t.sent.length, 1);
});
