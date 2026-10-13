import { abortableDelay } from './upload-poll.mjs';

/** Starts an upload so that a sleeping or briefly unreachable server never
 *  turns into a failed upload: it waits for the server to answer before
 *  sending, and resends after a transient failure (no response, timeout,
 *  502/503/504). Resending is safe because every attempt carries the same
 *  client upload id, which the server uses to return the job it already has
 *  instead of ingesting the file twice.
 *
 *  send(signal) → job · awake({signal}) resolves once the server answers ·
 *  onWait(text) reports what the upload is waiting for ('' when sending).
 *
 * @template T
 * @param {(signal?: AbortSignal) => Promise<T>} send
 * @param {{ awake: (o: { signal?: AbortSignal }) => Promise<unknown>, isTransient: (e: unknown) => boolean,
 *   signal?: AbortSignal, onWait?: (text: string) => void, attempts?: number,
 *   delay?: (ms: number, signal?: AbortSignal) => Promise<unknown>, firstDelayMs?: number }} options
 * @returns {Promise<T>} */
export async function startUpload(send, { awake, isTransient, signal, onWait = () => {}, attempts = 4, delay = abortableDelay, firstDelayMs = 2000 }) {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    let waiting = false;
    const slow = setTimeout(() => { waiting = true; onWait('Waiting for the server to wake up…'); }, 400);
    try { await awake({ signal }); } finally { clearTimeout(slow); }
    if (waiting || attempt > 1) onWait('');
    try {
      return await send(signal);
    } catch (error) {
      if (signal?.aborted || !isTransient(error) || attempt >= attempts) throw error;
      onWait('Connection interrupted. Retrying the upload…');
      await delay(Math.min(firstDelayMs * 2 ** (attempt - 1), 15000), signal);
    }
  }
}
