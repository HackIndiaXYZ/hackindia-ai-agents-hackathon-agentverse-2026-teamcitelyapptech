// Runs a task repeatedly, but only while a person is actually here: the tab
// is visible and there has been input recently. Used to keep the backend warm
// while Citely is in use, and to let it sleep (and stop costing money) when a
// tab is forgotten, hidden, or open on a page nobody is reading.
//
// The backend scales to zero ~5 minutes after its last request; a run every
// 3 minutes keeps it up, and stopping 10 minutes after the last input lets it
// go back to sleep about 15 minutes after someone walks away. (It was 20
// minutes while a wake took ~3 minutes; with the slim image it takes seconds,
// so a shorter window costs little and saves paid idle time.)

const INPUT = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'];

/** @param {{ run: (info: { sinceInput: number }) => void, intervalMs?: number, idleMs?: number,
 *   activeMs?: number, runOnShow?: boolean,
 *   waitForInput?: boolean, doc?: Document, win?: Window, now?: () => number,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} o
 *  waitForInput: don't run at all until the first input (no runs for bots).
 *  activeMs: input after this long without any also runs at once.
 *  runOnShow: switching back to the tab always runs at once.
 *  run is told how long it has been since the last input. */
export function whilePresent({ run, intervalMs = 180_000, idleMs = 600_000, activeMs = Infinity, runOnShow = false,
  waitForInput = false, doc = document, win = window, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let lastInput = waitForInput ? -Infinity : now(), lastRun = -Infinity, timer = null, stopped = false;
  const present = () => doc.visibilityState === 'visible' && now() - lastInput < idleMs;
  const fire = () => { lastRun = now(); try { run({ sinceInput: now() - lastInput }); } catch { /* the task reports its own errors */ } };
  const schedule = () => {
    clearTimer(timer);
    timer = null;
    if (stopped || !present()) return;              // paused until input or visibility returns
    timer = setTimer(() => { timer = null; if (present()) fire(); schedule(); }, intervalMs);
  };
  const resume = (force = false) => {
    if (stopped) return;
    if (present() && (force || now() - lastRun >= intervalMs)) fire();   // back after a pause: run now
    if (!timer) schedule();
  };
  let lastMove = -Infinity;
  const onInput = e => {
    // pointermove fires constantly; one note a second is plenty.
    if (e.type === 'pointermove' && now() - lastMove < 1000) return;
    lastMove = now();
    const quiet = now() - lastInput;
    lastInput = now();
    resume(quiet >= activeMs);
  };
  // Switching to the tab is someone arriving — unless we are still waiting
  // for a first input (a bot's page can be "visible" too).
  const onVisibility = () => {
    if (doc.visibilityState !== 'visible') return schedule();
    if (lastInput > -Infinity) lastInput = now();
    resume(runOnShow);
  };
  for (const type of INPUT) win.addEventListener(type, onInput, { passive: true, capture: true });
  doc.addEventListener('visibilitychange', onVisibility);
  if (!waitForInput) resume();
  return {
    /** Runs now if someone is here (and restarts the interval from now). */
    poke() { if (!stopped && present()) { fire(); schedule(); } },
    stop() {
      stopped = true;
      clearTimer(timer);
      for (const type of INPUT) win.removeEventListener(type, onInput, { capture: true });
      doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

// Presence for the admin console's "online": each workspace tab reports for
// itself, under an id made when the page loads.
//
//   active  about once a minute while the tab is visible and was used in the
//           last 5 minutes (it is also what keeps the server awake)
//   idle    visible, but no input for 5 minutes (sent instead of active,
//           until the 10-minute keep-warm window ends)
//   hidden  the tab was hidden; closed: the page was closed (pagehide)
//
// The server counts a person online for 150 s after a tab's last "active", so
// a browser that is killed (pagehide never fires, often on phones) or a
// laptop that goes to sleep is offline within 2.5 minutes anyway.
//
// Leaving signals are only sent while the server is certainly still awake
// (this tab reached it in the last 4 minutes: it sleeps ~5 minutes after its
// last request). Closing a tab that was left alone longer must never wake a
// server up; the server has already stopped counting that tab as online.
export const PRESENCE = { beatMs: 60_000, activeMs: 300_000, idleMs: 600_000, awakeMs: 240_000 };

/** @param {{ send: (signal: { state: string, seq: number, first?: boolean }, leaving: boolean) => (Promise<unknown> | void),
 *   ready: () => boolean, warm?: () => void,
 *   doc?: Document, win?: Window, now?: () => number,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} o
 *  send resolves (to anything) once the server has the signal; leaving
 *  signals are fire-and-forget. Until ready() is true (the server is
 *  confirmed awake) the loop runs warm() instead: a plain health read. */
export function workspacePresence({ send, ready, warm = () => {}, doc = document, win = window, now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let seq = 0, first = true, lastContact = -Infinity, stopped = false;
  const signal = (state, leaving) => {
    if (stopped) return;
    const body = { state, seq: ++seq, ...(state === 'active' && first ? { first: true } : {}) };
    const at = now();
    let sent;
    try { sent = send(body, leaving); } catch { return; }
    if (leaving || !sent) return;
    sent.then(() => { lastContact = Math.max(lastContact, at); if (body.first) first = false; }, () => { /* reported by send */ });
  };
  const loop = whilePresent({
    intervalMs: PRESENCE.beatMs, idleMs: PRESENCE.idleMs, activeMs: PRESENCE.activeMs, runOnShow: true,
    run: ({ sinceInput }) => { if (stopped) return; if (!ready()) return warm(); signal(sinceInput < PRESENCE.activeMs ? 'active' : 'idle', false); },
    doc, win, now, setTimer, clearTimer,
  });
  const leave = state => { if (now() - lastContact <= PRESENCE.awakeMs) signal(state, true); };
  const onVisibility = () => { if (doc.visibilityState === 'hidden') leave('hidden'); };
  const onPageHide = () => leave('closed');
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', onPageHide);
  return {
    /** Reports now (once the server is awake), if someone is here. */
    beat: () => loop.poke(),
    /** Signed out: nothing more from this tab. */
    stop() {
      stopped = true;
      loop.stop();
      doc.removeEventListener('visibilitychange', onVisibility);
      win.removeEventListener('pagehide', onPageHide);
    },
  };
}
