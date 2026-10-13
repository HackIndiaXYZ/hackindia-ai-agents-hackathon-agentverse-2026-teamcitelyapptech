import * as api from '@/services/api';
import { TIMEOUTS } from '@/config';
import { createWaker, WakeCancelledError, WakeTimeoutError } from './wake-core.mjs';

export { WakeCancelledError, WakeTimeoutError };
export type WakeState = 'waking' | 'ready';

// "Awake" means the server answers at all. Signing in and opening the
// workspace need nothing more; waiting for every dependency (the AI service
// included) blocked sign-in for the whole budget whenever a dependency check
// was slow after a cold start.
async function probe(timeoutMs: number): Promise<{ ready: boolean }> {
  try {
    await api.getLive(timeoutMs);
    return { ready: true };
  } catch {
    return { ready: false };
  }
}

const waker = createWaker({ probe, warmup: () => { void api.warmup(); } });

/** Resolves once the backend reports ready; rejects with WakeTimeoutError
 *  after the configured budget, or WakeCancelledError if `signal` aborts. */
export function ensureAwake(
  opts: { signal?: AbortSignal; onState?: (s: WakeState) => void } = {},
): Promise<void> {
  return waker.ensureAwake({ ...opts, budgetMs: TIMEOUTS.wake });
}

export const markServerReady = waker.markReady;
export const markServerUnknown = waker.markUnknown;

// A wake measured ~30 s (October 2026: image pull ~16 s, then start-up).
export const WAKING_MESSAGE = 'Waking up the server — this usually takes under a minute.';

/** The waking message with how long the wait has run, so a long cold start
 *  visibly progresses instead of looking frozen. */
export function wakingMessage(elapsedMs: number): string {
  const s = Math.max(0, Math.floor(elapsedMs / 1000));
  if (s < 5) return WAKING_MESSAGE;
  return `${WAKING_MESSAGE} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} so far.`;
}
