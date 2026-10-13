// Waiting for a scale-to-zero backend, without guessing.
//
// The backend can take minutes to start from zero. Requests sent during that
// window time out, and for some actions (an OAuth code exchange, sending an
// OTP) a timed-out attempt cannot simply be repeated. So callers wait for the
// server to report ready *before* acting.
//
// Dependency-injected so the timing logic is testable without a network or a
// real clock: `probe(timeoutMs)` resolves {ready}, `warmup()` is fire-and-forget.

export class WakeTimeoutError extends Error {
  constructor(budgetMs) {
    super(`The server did not become ready within ${Math.round(budgetMs / 1000)} seconds. Please try again.`)
    this.name = 'WakeTimeoutError'
  }
}

export class WakeCancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'WakeCancelledError'
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createWaker({
  probe,
  warmup = () => {},
  now = () => Date.now(),
  sleep = defaultSleep,
  // A server confirmed ready this recently is assumed still ready, so every
  // click doesn't pay a round trip. Short enough to stay well inside the
  // platform's scale-to-zero idle window.
  readyTtlMs = 60_000,
  maxProbeMs = 15_000,
  firstDelayMs = 500,
  maxDelayMs = 5_000,
}) {
  let inflight = null
  let readyAt = -Infinity
  let listeners = new Set()

  const emit = (state) => {
    for (const fn of listeners) {
      try { fn?.(state) } catch { /* a listener must not break the wake */ }
    }
  }

  async function run(budgetMs) {
    const deadline = now() + budgetMs
    try { warmup() } catch { /* best effort */ }
    let delay = firstDelayMs
    let announced = false
    for (;;) {
      const remaining = deadline - now()
      if (remaining <= 0) throw new WakeTimeoutError(budgetMs)
      let ready = false
      try {
        ready = (await probe(Math.min(remaining, maxProbeMs)))?.ready === true
      } catch {
        ready = false
      }
      if (ready) {
        readyAt = now()
        emit('ready')
        return
      }
      // Only announce a wake once the first probe has actually failed, so a
      // warm server never flashes a "waking up" message.
      if (!announced) { announced = true; emit('waking') }
      const wait = Math.min(delay, Math.max(0, deadline - now()))
      if (wait <= 0) throw new WakeTimeoutError(budgetMs)
      await sleep(wait)
      delay = Math.min(delay * 2, maxDelayMs)
    }
  }

  function ensureAwake({ signal, budgetMs, onState } = {}) {
    if (signal?.aborted) return Promise.reject(new WakeCancelledError())
    if (now() - readyAt < readyTtlMs) return Promise.resolve()
    if (onState) listeners.add(onState)
    if (!inflight) {
      // Single flight: concurrent callers share one wake instead of each
      // polling the server on its own.
      inflight = run(budgetMs).finally(() => {
        inflight = null
        listeners = new Set()
      })
    }
    const shared = inflight
    if (!signal) return shared
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        listeners.delete(onState)
        reject(new WakeCancelledError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      shared.then(
        () => { signal.removeEventListener('abort', onAbort); resolve() },
        (err) => { signal.removeEventListener('abort', onAbort); reject(err) },
      )
    })
  }

  return {
    ensureAwake,
    /** Any successful API response proves the server is up. */
    markReady: () => { readyAt = now() },
    /** A transient failure means our "recently ready" belief is stale. */
    markUnknown: () => { readyAt = -Infinity },
    isWaking: () => inflight !== null,
  }
}
