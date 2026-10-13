import test from 'node:test';
import assert from 'node:assert/strict';
import { startUpload } from '../lib/upload-start.mjs';

const transient = e => e.transient === true;
const fail = (transient = true) => Object.assign(Error(transient ? 'timeout' : 'bad request'), { transient });
const noDelay = async () => {};

test('waits for the server before sending, and sends once when all is well', async () => {
  const events = [];
  const job = await startUpload(async () => { events.push('send'); return { job_id: 'j1' }; },
    { awake: async () => { events.push('awake'); }, isTransient: transient, delay: noDelay });
  assert.deepEqual(job, { job_id: 'j1' });
  assert.deepEqual(events, ['awake', 'send']);
});

test('a transient failure is retried after waking again; the same send is reused', async () => {
  let sends = 0, wakes = 0;
  const notes = [];
  const job = await startUpload(async () => { if (++sends < 3) throw fail(); return { job_id: 'j1' }; },
    { awake: async () => { wakes++; }, isTransient: transient, delay: noDelay, onWait: n => notes.push(n) });
  assert.equal(job.job_id, 'j1');
  assert.equal(sends, 3);
  assert.equal(wakes, 3);
  assert.ok(notes.includes('Connection interrupted. Retrying the upload…'));
  assert.equal(notes.at(-1), '');                                   // cleared once sent
});

test('a real error (4xx) is not retried', async () => {
  let sends = 0;
  await assert.rejects(startUpload(async () => { sends++; throw fail(false); },
    { awake: async () => {}, isTransient: transient, delay: noDelay }), /bad request/);
  assert.equal(sends, 1);
});

test('retries are bounded', async () => {
  let sends = 0;
  await assert.rejects(startUpload(async () => { sends++; throw fail(); },
    { awake: async () => {}, isTransient: transient, delay: noDelay, attempts: 4 }), /timeout/);
  assert.equal(sends, 4);
});

test('a slow wake is reported, then cleared', async () => {
  const notes = [];
  await startUpload(async () => ({ job_id: 'j' }), {
    awake: () => new Promise(r => setTimeout(r, 600)), isTransient: transient, delay: noDelay, onWait: n => notes.push(n) });
  assert.deepEqual(notes, ['Waiting for the server to wake up…', '']);
});

test('cancelling stops it', async () => {
  const c = new AbortController();
  c.abort();
  await assert.rejects(startUpload(async () => ({}), { awake: async () => {}, isTransient: transient, signal: c.signal }));
});
