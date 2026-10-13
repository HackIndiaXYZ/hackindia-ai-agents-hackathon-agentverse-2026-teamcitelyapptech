// A small copy of the workspace kept on this device, so the workspace can
// open instantly while a sleeping server wakes: the catalog (workspaces,
// folders, file names), which files have originals, and the last opened
// conversation with its notes. Never document contents. One per user; all
// of them are removed on sign-out.

const PREFIX = 'citely.snapshot.v1.';
const MAX_CHARS = 1_500_000;   // well inside the ~5 MB localStorage quota

const store = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** The snapshot saved for this user, or null (none, unreadable, or not theirs). */
export function loadSnapshot(userId, storage = store()) {
  try {
    const raw = storage?.getItem(PREFIX + userId);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    return snap && snap.v === 1 && snap.user?.id === userId && snap.catalog ? snap : null;
  } catch { return null; }
}

/** Saves it; drops the conversation if the whole thing is too big. */
export function saveSnapshot(snap, storage = store()) {
  try {
    let raw = JSON.stringify({ ...snap, v: 1 });
    if (raw.length > MAX_CHARS && snap.desk) raw = JSON.stringify({ ...snap, v: 1, desk: null });
    if (raw.length > MAX_CHARS) return false;
    storage?.setItem(PREFIX + snap.user.id, raw);
    return true;
  } catch { return false; }   // quota or blocked storage: simply no snapshot
}

export function clearSnapshots(storage = store()) {
  try {
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key && key.startsWith(PREFIX)) storage.removeItem(key);
    }
  } catch { /* nothing to clear */ }
}
