"""Who is in the workspace right now, for the admin console.

Presence comes only from the workspace's own signals (POST /me/presence),
never from ordinary API calls: the review page polling /me, the admin
console's requests or a request finishing after sign-out say nothing about
whether someone is working.

Every open workspace tab reports for itself, under a random id made when the
page loads, so one tab closing never takes a person offline while another is
still in front of them:

  active      the tab is visible and was used in the last few minutes (sent
              about once a minute; it also keeps the server awake)
  idle        visible, but nobody has touched it for a while
  hidden      the person switched to another tab or app
  closed      the page was closed (pagehide; not always delivered)
  signed_out  signed out in that browser, everywhere, or blocked by the
              admin. Final: nothing revives it, not even a late request.

Signals carry a per-tab sequence number, so an "active" that was in flight
when the tab was hidden can't land afterwards and bring it back.

A person is online while one of their tabs said "active" within
ONLINE_SECONDS: a killed browser, a lost connection or a sleeping laptop
goes offline within that window even when no leaving signal arrives.
Away means a tab is still open but hidden or idle (in the last AWAY_MINUTES).

Kept in memory: there is one server process (maxReplicas: 1), and a restart
means a scale-to-zero wake (nobody was online) or a deploy (open tabs report
again within a minute). The last active moment is also written to
users.last_seen_at, which outlives restarts.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone

import structlog

from APP import db

logger = structlog.get_logger("rag_api.presence")

ONLINE_SECONDS = 150          # the workspace says "active" every 60 s
AWAY_MINUTES = 30
STATES = ("active", "idle", "hidden", "closed", "signed_out")
LAST_SEEN_WRITE_SECONDS = 30  # one users.last_seen_at write per account per half minute
MAX_TABS_PER_USER = 20        # oldest forgotten first
FORGET_AFTER_SECONDS = 24 * 3600


@dataclass
class _Tab:
    browser: str
    state: str
    seq: int
    at: float                 # time.time() of the last accepted signal


_lock = threading.Lock()
_tabs: dict[str, dict[str, _Tab]] = {}       # user id -> tab id -> tab
_last_active: dict[str, float] = {}          # user id -> last moment seen working
_last_written: dict[str, float] = {}         # user id -> last users.last_seen_at write


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat()


def _prune(user_tabs: dict[str, _Tab], now: float) -> None:
    for tab_id in [k for k, t in user_tabs.items() if now - t.at > FORGET_AFTER_SECONDS]:
        del user_tabs[tab_id]
    while len(user_tabs) > MAX_TABS_PER_USER:
        del user_tabs[min(user_tabs, key=lambda k: user_tabs[k].at)]


def signal(user_id: str, tab_id: str, browser: str, seq: int, state: str, *, now: float | None = None) -> bool:
    """Records one tab's signal. Returns False when it was ignored: older
    than a signal already received from that tab, or the tab has signed out."""
    if state not in STATES or state == "signed_out":
        raise ValueError(f"Unknown presence state: {state}")
    now = time.time() if now is None else now
    write = False
    with _lock:
        user_tabs = _tabs.setdefault(user_id, {})
        tab = user_tabs.get(tab_id)
        if tab is not None and (tab.state == "signed_out" or seq <= tab.seq):
            return False
        was_working = tab is not None and tab.state == "active" and now - tab.at <= ONLINE_SECONDS
        user_tabs[tab_id] = _Tab(browser=browser, state=state, seq=seq, at=now)
        # Working until now: an active signal, or leaving a tab that was
        # working a moment ago (the last seen time is when they left).
        if state == "active" or was_working:
            _last_active[user_id] = now
            if state != "active" or now - _last_written.get(user_id, -1e18) >= LAST_SEEN_WRITE_SECONDS:
                _last_written[user_id] = now
                write = True
        _prune(user_tabs, now)
    if write:
        db.touch_last_seen(user_id, _iso(now))
    return True


def sign_out(user_id: str, browser: str, tab_id: str | None = None, *, now: float | None = None) -> None:
    """Signed out in one browser: every tab of that browser stops counting,
    for good (a request still in flight can't bring one back)."""
    now = time.time() if now is None else now
    write = False
    with _lock:
        user_tabs = _tabs.setdefault(user_id, {})
        if tab_id is not None and tab_id not in user_tabs:
            user_tabs[tab_id] = _Tab(browser=browser, state="active", seq=-1, at=0.0)
        for tab in user_tabs.values():
            if tab.browser != browser or tab.state == "signed_out":
                continue
            if tab.state == "active" and now - tab.at <= ONLINE_SECONDS:
                _last_active[user_id] = now
                write = True
            tab.state, tab.at = "signed_out", now
        _prune(user_tabs, now)
    if write:
        db.touch_last_seen(user_id, _iso(now))


def end(user_id: str) -> None:
    """Signed out everywhere, a new password, suspended, declined or
    deleted: offline at once on every device."""
    now = time.time()
    with _lock:
        for tab in _tabs.get(user_id, {}).values():
            tab.state, tab.at = "signed_out", now


def forget(user_id: str) -> None:
    with _lock:
        _tabs.pop(user_id, None)
        _last_active.pop(user_id, None)
        _last_written.pop(user_id, None)


def reset() -> None:
    """Tests only."""
    with _lock:
        _tabs.clear()
        _last_active.clear()
        _last_written.clear()


def _state(user_id: str, now: float) -> str:
    tabs = list(_tabs.get(user_id, {}).values())
    if any(t.state == "active" and now - t.at <= ONLINE_SECONDS for t in tabs):
        return "online"
    if any(t.state in ("idle", "hidden") and now - t.at <= AWAY_MINUTES * 60 for t in tabs):
        return "away"
    return "offline"


def online_user_ids(now: float | None = None) -> set[str]:
    now = time.time() if now is None else now
    with _lock:
        return {u for u in _tabs if _state(u, now) == "online"}


def describe(user: dict, now: float | None = None) -> dict:
    """The admin console's view of one account: `presence` is online, away,
    offline, or None for an account that isn't a member (pending or declined
    accounts can't use the workspace, so they have no presence at all).
    Suspended accounts are blocked, so never online or away. `last_seen_at`
    is the last moment they were working, to the second while this server
    has been up."""
    now = time.time() if now is None else now
    status = user.get("status") or "approved"
    with _lock:
        state = _state(user["id"], now)
        active = _last_active.get(user["id"])
    stored = user.get("last_seen_at")
    last_seen = max(filter(None, (stored, _iso(active) if active else None)), default=None)
    if status not in ("approved", "suspended"):
        presence = None
    elif status == "suspended":
        presence = "offline"
    else:
        presence = state
    return {"presence": presence, "online": presence == "online", "last_seen_at": last_seen}
