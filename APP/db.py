"""SQLite metadata store: users, linked auth identities, OTP codes, documents,
and chat history. Lives on the same Azure Files volume as the rest of data/,
so no new Azure resource. Single-writer is fine given maxReplicas: 1.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

DB_PATH = Path("data/rag.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    created_at TEXT NOT NULL,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    privacy_policy_version TEXT,
    privacy_policy_accepted_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_identities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS otp_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    filename TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    pages INTEGER,
    chunks INTEGER,
    indexed_chunks INTEGER
);

-- Summaries already written, so asking again is instant. The key covers the
-- owner, the documents and their current index, the question and the prompt
-- version, so a re-uploaded file or a changed prompt never gets an old answer.
CREATE TABLE IF NOT EXISTS answer_cache (
    cache_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    document_ids TEXT NOT NULL,
    answer TEXT NOT NULL,
    sources_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answer_cache_owner ON answer_cache(owner_id);

CREATE TABLE IF NOT EXISTS chat_turns (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id),
    owner_id TEXT NOT NULL REFERENCES users(id),
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    sources_json TEXT,
    created_at TEXT NOT NULL
);

-- Saved evidence: a kept citation or a hand-made highlight. Both are the same
-- shape because they anchor the same way — a quote plus its character range in
-- the page's extracted text — and the reader treats them identically.
-- `extraction_version` records which extraction the offsets were measured
-- against, so a reprocessed document can relocate them by quote instead of
-- silently highlighting the wrong text.
CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    workspace_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    document_id TEXT NOT NULL REFERENCES documents(id),
    kind TEXT NOT NULL,
    citation_id TEXT,
    page_number INTEGER NOT NULL,
    quote TEXT NOT NULL,
    page_char_start INTEGER,
    page_char_end INTEGER,
    bounding_boxes TEXT,
    note TEXT,
    extraction_version TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- One note per conversation, stored as an append-only revision history rather
-- than a single overwritable value, so a second writer cannot silently discard
-- someone else's edit and an earlier version can be restored.
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    workspace_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    current_revision INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (owner_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS note_revisions (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id),
    revision INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (note_id, revision)
);

-- Owner-scoped workspace state, addressed by an opaque key the client chooses
-- ('catalog', 'chat:<space>:<desk>', 'annotation:<doc>'). `revision` gives the
-- optimistic-concurrency contract the workspace UI is built against: a write
-- carrying a stale revision is rejected rather than silently clobbering a
-- newer one saved from another tab or device.
CREATE TABLE IF NOT EXISTS user_state (
    owner_id TEXT NOT NULL REFERENCES users(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, key)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
CREATE INDEX IF NOT EXISTS idx_chat_turns_document ON chat_turns(document_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_annotations_conversation ON annotations(owner_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_annotations_document ON annotations(document_id);
CREATE INDEX IF NOT EXISTS idx_note_revisions_note ON note_revisions(note_id, revision);

-- Bytes of original files each owner has stored (committed) or is in the
-- middle of storing (reserved). Reservations are taken before any byte is
-- written, under BEGIN IMMEDIATE, so concurrent uploads cannot overshoot a cap.
CREATE TABLE IF NOT EXISTS storage_ledger (
    owner_id TEXT PRIMARY KEY,
    committed INTEGER NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS storage_reservations (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

-- People the admin approved from an access-request email. Keyed by the
-- canonical address (see APP/access_control.canonical_email), so an approval
-- covers that inbox however its address is spelled.
CREATE TABLE IF NOT EXISTS access_approvals (
    email_canonical TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    approved_at TEXT NOT NULL
);

-- Usage counted against the demo limits: per account in total, and across
-- everyone per day. Taken under BEGIN IMMEDIATE before any cost is incurred,
-- and given back if the work then fails.
CREATE TABLE IF NOT EXISTS usage_totals (
    owner_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, kind)
);

CREATE TABLE IF NOT EXISTS usage_daily (
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, kind)
);

-- Per account per day, for when the account limit resets daily (set in the
-- admin console). usage_totals keeps counting every use either way.
CREATE TABLE IF NOT EXISTS usage_account_daily (
    owner_id TEXT NOT NULL,
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, day, kind)
);

-- Settings changed from the admin console (e.g. the usage limits), as JSON.
-- Environment variables are the defaults until a setting is saved here.
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- A sign-up waiting for its email code. No account exists until the code is
-- entered; a row older than its expiry is discarded and never becomes one.
CREATE TABLE IF NOT EXISTS pending_signups (
    email_canonical TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- What happened, for the admin console: sign-ups, sign-ins, uploads,
-- questions, sessions, admin actions, server starts. Never an IP address,
-- a document name, a question or an answer; only the country the visitor's
-- address maps to and the timezone their browser reports.
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    user_id TEXT,
    email TEXT,
    country TEXT,
    timezone TEXT,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
CREATE INDEX IF NOT EXISTS idx_events_type_at ON events(type, at);
CREATE INDEX IF NOT EXISTS idx_events_user_at ON events(user_id, at);

-- Demo access requests, kept as well as emailed, so the admin console can
-- list and approve them.
CREATE TABLE IF NOT EXISTS demo_requests (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    email_canonical TEXT NOT NULL,
    phone TEXT,
    comment TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_demo_requests_email ON demo_requests(email_canonical);

-- API traffic per day, grouped by area. Counted in memory and added here
-- about once a minute, so requests never wait on this write.
CREATE TABLE IF NOT EXISTS api_requests_daily (
    day TEXT NOT NULL,
    bucket TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, bucket)
);

-- Browsers an account chose to trust for 30 days: signing in from one skips
-- the emailed sign-in code. Only a hash of the browser's token is kept.
CREATE TABLE IF NOT EXISTS trusted_browsers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_trusted_browsers_user ON trusted_browsers(user_id);

-- Sample documents the admin offers in Upload ("Use a sample").
CREATE TABLE IF NOT EXISTS sample_documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    filename TEXT NOT NULL,
    kind TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return str(uuid.uuid4())


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # Not WAL: data/ is an Azure Files (SMB) mount, and WAL needs shared-memory
    # mmap plus byte-range locks that SMB doesn't provide — every connection
    # dies with "database is locked". Single-writer holds given maxReplicas: 1.
    conn.execute("PRAGMA journal_mode = DELETE")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# Columns added after the table already existed in deployed databases —
# CREATE TABLE IF NOT EXISTS above never retrofits an existing table, so each
# one needs its own ALTER TABLE here. Failing with "duplicate column" is the
# expected outcome once a database has already picked a migration up.
_MIGRATIONS = (
    "ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN locked_until TEXT",
    "ALTER TABLE users ADD COLUMN privacy_policy_version TEXT",
    "ALTER TABLE users ADD COLUMN privacy_policy_accepted_at TEXT",
    # Bumped on every password reset; embedded in freshly-issued JWTs as the
    # `tv` claim so get_current_user can reject tokens issued before a reset.
    # A JWT with no `tv` claim at all (issued before this column existed) is
    # treated as version 0 by the caller — matching this DEFAULT exactly, so
    # every pre-existing session keeps working until its owner resets.
    "ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0",
    # Lifecycle of a document row. Every pre-existing row was fully indexed, so
    # the default marks them ready. New ingests move ingesting -> ready, and a
    # failed ingest removes its row entirely rather than leaving an orphan.
    "ALTER TABLE documents ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'",
    # The retained original upload, if any. NULL for every document ingested
    # before originals were kept — those keep the extracted-text view.
    "ALTER TABLE documents ADD COLUMN original_path TEXT",
    "ALTER TABLE documents ADD COLUMN original_bytes INTEGER",
    "ALTER TABLE documents ADD COLUMN original_sha256 TEXT",
    # extraction_version of the original as stored. Equal to the document's
    # pages.json version means existing offsets and annotations still describe
    # this exact file; different means it was attached on explicit confirmation
    # and old anchors must never be remapped onto it.
    "ALTER TABLE documents ADD COLUMN original_extraction_version TEXT",
    # JSON anchor of a highlight made in a format-native viewer (spreadsheet
    # cells). NULL for every existing annotation, which keeps page offsets.
    "ALTER TABLE annotations ADD COLUMN anchor TEXT",
    # The inbox an address delivers to (Gmail dots and "+tag" removed), so one
    # mailbox cannot hold several accounts. Filled in for existing rows below.
    "ALTER TABLE users ADD COLUMN email_canonical TEXT",
    "CREATE INDEX IF NOT EXISTS idx_users_email_canonical ON users(email_canonical)",
    # Account lifecycle. Every account that existed before review was added
    # had been approved to sign up, so the default keeps them all approved.
    "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'",
    "ALTER TABLE users ADD COLUMN status_reason TEXT",
    "ALTER TABLE users ADD COLUMN status_changed_at TEXT",
    # The last moment the account was working in the workspace (presence
    # signals only, see APP/presence.py).
    "ALTER TABLE users ADD COLUMN last_seen_at TEXT",
    # Wrong guesses at a code (sign-in codes allow five).
    "ALTER TABLE otp_codes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
)


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(SCHEMA)
        from APP.extraction.store import SCHEMA as EVIDENCE_SCHEMA
        conn.executescript(EVIDENCE_SCHEMA)
        for migration in _MIGRATIONS:
            try:
                conn.execute(migration)
            except sqlite3.OperationalError:
                pass  # column already exists
        from APP.access_control import canonical_email
        for row in conn.execute("SELECT id, email FROM users WHERE email_canonical IS NULL").fetchall():
            conn.execute("UPDATE users SET email_canonical = ? WHERE id = ?", (canonical_email(row["email"]), row["id"]))
        # An address that never entered its code never had an account in any
        # useful sense (it could not sign in), and no longer may hold a row.
        _delete_unverified_users(conn)
        conn.execute("DELETE FROM pending_signups WHERE expires_at < ?", (_now(),))


# --------------------------------------------------------------------------- #
# Users / auth identities
# --------------------------------------------------------------------------- #

def get_user_by_email(email: str) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()


def get_user_by_id(user_id: str) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def get_user_by_identity(provider: str, provider_user_id: str) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute(
            """
            SELECT users.* FROM users
            JOIN auth_identities ON auth_identities.user_id = users.id
            WHERE auth_identities.provider = ? AND auth_identities.provider_user_id = ?
            """,
            (provider, provider_user_id),
        ).fetchone()


def create_user(email: str, *, password_hash: str | None = None, email_verified: bool = False, status: str = "approved") -> str:
    from APP.access_control import canonical_email
    user_id = _new_id()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO users (id, email, email_verified, password_hash, created_at, email_canonical, status, status_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, email, int(email_verified), password_hash, _now(), canonical_email(email), status, _now()),
        )
    return user_id


def get_user_by_canonical_email(canonical: str) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute(
            "SELECT * FROM users WHERE email_canonical = ? ORDER BY email_verified DESC, created_at LIMIT 1", (canonical,)
        ).fetchone()


def set_password_hash(user_id: str, password_hash: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))


# --------------------------------------------------------------------------- #
# Access approvals
# --------------------------------------------------------------------------- #

def approve_access(email: str) -> bool:
    """Records an approval; False if that inbox was already approved."""
    from APP.access_control import canonical_email, normalize_email
    with _connect() as conn:
        cursor = conn.execute(
            "INSERT OR IGNORE INTO access_approvals (email_canonical, email, approved_at) VALUES (?, ?, ?)",
            (canonical_email(email), normalize_email(email), _now()),
        )
        conn.execute("UPDATE demo_requests SET status = 'approved', decided_at = ? WHERE email_canonical = ? AND status = 'pending'",
                     (_now(), canonical_email(email)))
        return cursor.rowcount == 1


def is_access_approved(email: str) -> bool:
    from APP.access_control import canonical_email
    with _connect() as conn:
        return conn.execute(
            "SELECT 1 FROM access_approvals WHERE email_canonical = ?", (canonical_email(email),)
        ).fetchone() is not None


# --------------------------------------------------------------------------- #
# Usage limits
# --------------------------------------------------------------------------- #

class UsageLimitReached(Exception):
    """scope is "account" (this person's total) or "daily" (everyone, today)."""

    def __init__(self, kind: str, scope: str):
        super().__init__(f"{kind} limit reached ({scope})")
        self.kind, self.scope = kind, scope


def reserve_usage(owner_id: str, kind: str, *, per_account: int, daily: int, day: str, account_resets_daily: bool = False) -> None:
    """Counts one use, or raises UsageLimitReached without counting. The
    check and the increment happen in one write transaction, so simultaneous
    requests can never exceed either limit. The account limit is a total, or
    per day when account_resets_daily."""
    with _immediate() as conn:
        if account_resets_daily:
            mine = conn.execute("SELECT used FROM usage_account_daily WHERE owner_id = ? AND day = ? AND kind = ?",
                                (owner_id, day, kind)).fetchone()
        else:
            mine = conn.execute("SELECT used FROM usage_totals WHERE owner_id = ? AND kind = ?", (owner_id, kind)).fetchone()
        today = conn.execute("SELECT used FROM usage_daily WHERE day = ? AND kind = ?", (day, kind)).fetchone()
        if (mine["used"] if mine else 0) >= per_account:
            raise UsageLimitReached(kind, "account")
        if (today["used"] if today else 0) >= daily:
            raise UsageLimitReached(kind, "daily")
        conn.execute("INSERT INTO usage_totals (owner_id, kind, used) VALUES (?, ?, 1) "
                     "ON CONFLICT(owner_id, kind) DO UPDATE SET used = used + 1", (owner_id, kind))
        conn.execute("INSERT INTO usage_account_daily (owner_id, day, kind, used) VALUES (?, ?, ?, 1) "
                     "ON CONFLICT(owner_id, day, kind) DO UPDATE SET used = used + 1", (owner_id, day, kind))
        conn.execute("INSERT INTO usage_daily (day, kind, used) VALUES (?, ?, 1) "
                     "ON CONFLICT(day, kind) DO UPDATE SET used = used + 1", (day, kind))


def add_daily_amount(day: str, kind: str, amount: int, *, cap: int) -> bool:
    """Adds amount to the day's running total for kind, unless that would go
    over cap; returns whether it was added. A negative amount (a correction)
    is always applied, never below zero. One write transaction, so
    simultaneous callers can't overshoot together."""
    with _immediate() as conn:
        row = conn.execute("SELECT used FROM usage_daily WHERE day = ? AND kind = ?", (day, kind)).fetchone()
        if amount > 0 and (row["used"] if row else 0) + amount > cap:
            return False
        conn.execute("INSERT INTO usage_daily (day, kind, used) VALUES (?, ?, MAX(?, 0)) "
                     "ON CONFLICT(day, kind) DO UPDATE SET used = MAX(used + ?, 0)", (day, kind, amount, amount))
        return True


def release_usage(owner_id: str, kind: str, *, day: str) -> None:
    """Gives back one use counted by reserve_usage (the work failed)."""
    with _immediate() as conn:
        conn.execute("UPDATE usage_totals SET used = MAX(used - 1, 0) WHERE owner_id = ? AND kind = ?", (owner_id, kind))
        conn.execute("UPDATE usage_account_daily SET used = MAX(used - 1, 0) WHERE owner_id = ? AND day = ? AND kind = ?", (owner_id, day, kind))
        conn.execute("UPDATE usage_daily SET used = MAX(used - 1, 0) WHERE day = ? AND kind = ?", (day, kind))


def usage_counts(owner_id: str, day: str) -> dict:
    with _connect() as conn:
        mine = {r["kind"]: r["used"] for r in conn.execute("SELECT kind, used FROM usage_totals WHERE owner_id = ?", (owner_id,))}
        today = {r["kind"]: r["used"] for r in conn.execute("SELECT kind, used FROM usage_daily WHERE day = ?", (day,))}
        mine_today = {r["kind"]: r["used"] for r in conn.execute(
            "SELECT kind, used FROM usage_account_daily WHERE owner_id = ? AND day = ?", (owner_id, day))}
    return {"account": mine, "account_today": mine_today, "daily": today}


def get_setting(key: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else None


def set_setting(key: str, value: dict) -> None:
    with _connect() as conn:
        conn.execute("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) "
                     "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                     (key, json.dumps(value), _now()))


def set_email_verified(user_id: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE users SET email_verified = 1 WHERE id = ?", (user_id,))


# --------------------------------------------------------------------------- #
# Login lockout — protects the password path even with a rate limit in front
# of it, since a limit alone still allows slow, distributed guessing.
# --------------------------------------------------------------------------- #

LOCKOUT_THRESHOLD = 5
LOCKOUT_MINUTES = 15


def is_locked(user: sqlite3.Row) -> bool:
    locked_until = user["locked_until"]
    if not locked_until:
        return False
    return datetime.now(timezone.utc) < datetime.fromisoformat(locked_until)


def record_failed_login(user_id: str) -> None:
    with _connect() as conn:
        row = conn.execute("SELECT failed_login_attempts FROM users WHERE id = ?", (user_id,)).fetchone()
        attempts = (row["failed_login_attempts"] if row else 0) + 1
        locked_until = None
        if attempts >= LOCKOUT_THRESHOLD:
            locked_until = (datetime.now(timezone.utc) + timedelta(minutes=LOCKOUT_MINUTES)).isoformat()
        conn.execute(
            "UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?",
            (attempts, locked_until, user_id),
        )


def reset_failed_logins(user_id: str) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?", (user_id,)
        )


# --------------------------------------------------------------------------- #
# Privacy policy consent
# --------------------------------------------------------------------------- #

def has_accepted_privacy_policy(user: sqlite3.Row, current_version: str) -> bool:
    """Versioned, not a one-time flag: bumping `current_version` re-prompts
    everyone who agreed to an older version rather than grandfathering them in.
    """
    return user["privacy_policy_version"] == current_version


def record_privacy_policy_acceptance(user_id: str, version: str) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE users SET privacy_policy_version = ?, privacy_policy_accepted_at = ? WHERE id = ?",
            (version, _now(), user_id),
        )


def link_identity(user_id: str, provider: str, provider_user_id: str) -> None:
    """Idempotent: re-linking the same (provider, provider_user_id) is a no-op."""
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO auth_identities (id, user_id, provider, provider_user_id, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (provider, provider_user_id) DO NOTHING
            """,
            (_new_id(), user_id, provider, provider_user_id, _now()),
        )


def get_or_create_user_for_oauth(email: str, provider: str, provider_user_id: str, *, status: str = "approved") -> str:
    """Verified-email linking policy: an OAuth login matching an existing
    account's email links to that account instead of creating a duplicate.
    """
    existing_by_identity = get_user_by_identity(provider, provider_user_id)
    if existing_by_identity is not None:
        return existing_by_identity["id"]

    existing_by_email = get_user_by_email(email)
    if existing_by_email is not None:
        link_identity(existing_by_email["id"], provider, provider_user_id)
        return existing_by_email["id"]

    user_id = create_user(email, email_verified=True, status=status)
    link_identity(user_id, provider, provider_user_id)
    return user_id


# --------------------------------------------------------------------------- #
# OTP codes
# --------------------------------------------------------------------------- #

def create_otp(user_id: str, code_hash: str, *, purpose: str = "signup", ttl_minutes: int = 10) -> None:
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=ttl_minutes)).isoformat()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO otp_codes (id, user_id, code_hash, purpose, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, NULL)",
            (_new_id(), user_id, code_hash, purpose, expires_at),
        )


def get_latest_otp(user_id: str, purpose: str = "signup") -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute(
            """
            SELECT * FROM otp_codes
            WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL
            ORDER BY expires_at DESC LIMIT 1
            """,
            (user_id, purpose),
        ).fetchone()


def consume_otp(otp_id: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE otp_codes SET consumed_at = ? WHERE id = ?", (_now(), otp_id))


# --------------------------------------------------------------------------- #
# Password reset tokens
# --------------------------------------------------------------------------- #

def create_password_reset_token(user_id: str, token_hash: str, *, ttl_minutes: int = 10) -> None:
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=ttl_minutes)).isoformat()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, consumed_at) VALUES (?, ?, ?, ?, NULL)",
            (_new_id(), user_id, token_hash, expires_at),
        )


def reset_password_with_token(user_id: str, token_hash: str, new_password_hash: str) -> bool:
    """Verifies + consumes a password-reset token and updates the account's
    password and token_version, all in one transaction.

    The hash match, single-use check, and expiry check are folded into ONE
    conditional UPDATE rather than a separate SELECT-then-validate step, so
    there is no window between "checked valid" and "consumed" for a second
    concurrent request (with the same or a different token for this account)
    to race through. If that UPDATE affects zero rows, nothing else in this
    function has written anything yet, so returning False here is safe.

    Every statement below runs inside the same `_connect()` block, which
    commits once on normal return and rolls back everything on any exception
    — so a failure partway through (e.g. the final UPDATE raising) leaves the
    token unconsumed and the password unchanged, rather than burning the
    token without completing the reset.
    """
    now = _now()
    with _connect() as conn:
        cur = conn.execute(
            """
            UPDATE password_reset_tokens SET consumed_at = ?
            WHERE user_id = ? AND token_hash = ? AND consumed_at IS NULL AND expires_at > ?
            """,
            (now, user_id, token_hash, now),
        )
        if cur.rowcount == 0:
            return False

        # Invalidate every other outstanding token for this account — an old,
        # unclicked reset email must not still work after this one already did.
        conn.execute(
            "UPDATE password_reset_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL",
            (now, user_id),
        )
        # A new password also forgets every browser trusted to skip the
        # sign-in code: whoever had the old password may have trusted one.
        conn.execute("DELETE FROM trusted_browsers WHERE user_id = ?", (user_id,))
        conn.execute(
            "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?",
            (new_password_hash, user_id),
        )
    return True


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #

def create_document(owner_id: str, filename: str, *, pages: int | None = None, status: str = "ready") -> str:
    document_id = _new_id()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO documents (id, owner_id, filename, ingested_at, pages, chunks, indexed_chunks, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (document_id, owner_id, filename, _now(), pages, None, None, status),
        )
    return document_id


def update_document_counts(document_id: str, *, chunks: int, indexed_chunks: int) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE documents SET chunks = ?, indexed_chunks = ? WHERE id = ?",
            (chunks, indexed_chunks, document_id),
        )


def list_documents(owner_id: str) -> list[sqlite3.Row]:
    # Only finished documents: a row mid-ingest has no index yet.
    with _connect() as conn:
        return conn.execute(
            "SELECT * FROM documents WHERE owner_id = ? AND status = 'ready' ORDER BY ingested_at DESC", (owner_id,)
        ).fetchall()


def get_document(document_id: str, owner_id: str) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute(
            "SELECT * FROM documents WHERE id = ? AND owner_id = ?", (document_id, owner_id)
        ).fetchone()


def delete_document(document_id: str, owner_id: str) -> bool:
    # Children first: both tables carry a foreign key to documents(id) and
    # foreign keys are enforced, so removing the parent while rows still point
    # at it fails the whole transaction.
    with _connect() as conn:
        row = conn.execute(
            "SELECT original_bytes FROM documents WHERE id = ? AND owner_id = ?", (document_id, owner_id)
        ).fetchone()
        # A stored original stops counting against the owner's storage in the
        # same transaction that removes its row.
        if row is not None and row["original_bytes"]:
            conn.execute(
                "UPDATE storage_ledger SET committed = MAX(0, committed - ?) WHERE owner_id = ?",
                (row["original_bytes"], owner_id),
            )
        conn.execute("DELETE FROM chat_turns WHERE document_id = ? AND owner_id = ?", (document_id, owner_id))
        conn.execute("DELETE FROM answer_cache WHERE owner_id = ? AND (',' || document_ids || ',') LIKE ?",
                     (owner_id, f"%,{document_id},%"))
        # Highlights anchor into this document's text; keeping them would leave
        # saved evidence pointing at a document that no longer exists.
        conn.execute("DELETE FROM annotations WHERE document_id = ? AND owner_id = ?", (document_id, owner_id))
        cur = conn.execute(
            "DELETE FROM documents WHERE id = ? AND owner_id = ?", (document_id, owner_id)
        )
        return cur.rowcount > 0


# --------------------------------------------------------------------------- #
# Remembered summaries
# --------------------------------------------------------------------------- #

ANSWER_CACHE_DAYS = 30


def cached_answer(cache_key: str, owner_id: str):
    with _connect() as conn:
        return conn.execute("SELECT answer, sources_json FROM answer_cache WHERE cache_key = ? AND owner_id = ? AND created_at >= ?",
                            (cache_key, owner_id, (datetime.now(timezone.utc) - timedelta(days=ANSWER_CACHE_DAYS)).isoformat())).fetchone()


def remember_answer(cache_key: str, owner_id: str, document_ids: list[str], answer: str, sources_json: str) -> None:
    now = datetime.now(timezone.utc)
    with _connect() as conn:
        conn.execute("INSERT INTO answer_cache (cache_key, owner_id, document_ids, answer, sources_json, created_at) VALUES (?, ?, ?, ?, ?, ?) "
                     "ON CONFLICT(cache_key) DO UPDATE SET answer = excluded.answer, sources_json = excluded.sources_json, created_at = excluded.created_at",
                     (cache_key, owner_id, ",".join(document_ids), answer, sources_json, now.isoformat()))
        conn.execute("DELETE FROM answer_cache WHERE created_at < ?", ((now - timedelta(days=ANSWER_CACHE_DAYS)).isoformat(),))


# --------------------------------------------------------------------------- #
# Chat turns
# --------------------------------------------------------------------------- #

def create_chat_turn(document_id: str, owner_id: str, question: str, answer: str, sources_json: str) -> str:
    turn_id = _new_id()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO chat_turns (id, document_id, owner_id, question, answer, sources_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (turn_id, document_id, owner_id, question, answer, sources_json, _now()),
        )
    return turn_id


def list_chat_turns(document_id: str, owner_id: str) -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(
            "SELECT * FROM chat_turns WHERE document_id = ? AND owner_id = ? ORDER BY created_at ASC",
            (document_id, owner_id),
        ).fetchall()


# --------------------------------------------------------------------------- #
# Annotations — kept citations and manual highlights
# --------------------------------------------------------------------------- #

def create_annotation(
    owner_id: str,
    *,
    workspace_id: str,
    conversation_id: str,
    document_id: str,
    kind: str,
    page_number: int,
    quote: str,
    citation_id: str | None = None,
    page_char_start: int | None = None,
    page_char_end: int | None = None,
    bounding_boxes: str | None = None,
    note: str | None = None,
    extraction_version: str = "",
    anchor: str | None = None,
) -> sqlite3.Row:
    annotation_id = _new_id()
    now = _now()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO annotations (id, owner_id, workspace_id, conversation_id, document_id, kind,"
            " citation_id, page_number, quote, page_char_start, page_char_end, bounding_boxes, note,"
            " extraction_version, anchor, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (annotation_id, owner_id, workspace_id, conversation_id, document_id, kind,
             citation_id, page_number, quote, page_char_start, page_char_end, bounding_boxes,
             note, extraction_version, anchor, now, now),
        )
        return conn.execute("SELECT * FROM annotations WHERE id = ?", (annotation_id,)).fetchone()


def list_annotations(owner_id: str, conversation_id: str) -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(
            "SELECT * FROM annotations WHERE owner_id = ? AND conversation_id = ?"
            " ORDER BY document_id, page_number, page_char_start",
            (owner_id, conversation_id),
        ).fetchall()


def update_annotation(annotation_id: str, owner_id: str, *, note: str | None, quote: str | None) -> sqlite3.Row | None:
    with _connect() as conn:
        current = conn.execute(
            "SELECT * FROM annotations WHERE id = ? AND owner_id = ?", (annotation_id, owner_id)
        ).fetchone()
        if current is None:
            return None
        conn.execute(
            "UPDATE annotations SET note = ?, quote = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
            (note if note is not None else current["note"],
             quote if quote is not None else current["quote"],
             _now(), annotation_id, owner_id),
        )
        return conn.execute("SELECT * FROM annotations WHERE id = ?", (annotation_id,)).fetchone()


def delete_annotation(annotation_id: str, owner_id: str) -> bool:
    with _connect() as conn:
        return conn.execute(
            "DELETE FROM annotations WHERE id = ? AND owner_id = ?", (annotation_id, owner_id)
        ).rowcount > 0


# --------------------------------------------------------------------------- #
# Notes — revision-tracked, one per conversation
# --------------------------------------------------------------------------- #

def get_note(owner_id: str, conversation_id: str) -> dict | None:
    with _connect() as conn:
        note = conn.execute(
            "SELECT * FROM notes WHERE owner_id = ? AND conversation_id = ?",
            (owner_id, conversation_id),
        ).fetchone()
        if note is None:
            return None
        revision = conn.execute(
            "SELECT content, created_at FROM note_revisions WHERE note_id = ? AND revision = ?",
            (note["id"], note["current_revision"]),
        ).fetchone()
    return {
        "conversation_id": conversation_id,
        "workspace_id": note["workspace_id"],
        "revision": note["current_revision"],
        "content": revision["content"] if revision else "",
        "updated_at": note["updated_at"],
        "updated_by": note["updated_by"],
    }


def save_note(
    owner_id: str, conversation_id: str, workspace_id: str, content: str, expected_revision: int
) -> dict | None:
    """Append a new revision, but only if the caller saw the current one.

    Returns None when `expected_revision` is stale — the caller turns that into
    a 409 rather than overwriting an edit it never saw. Creating the note, the
    revision row and the pointer bump are one transaction, so a failure part
    way through cannot leave a note pointing at a revision that doesn't exist.
    """
    now = _now()
    with _connect() as conn:
        note = conn.execute(
            "SELECT * FROM notes WHERE owner_id = ? AND conversation_id = ?",
            (owner_id, conversation_id),
        ).fetchone()

        if note is None:
            if expected_revision != 0:
                return None
            note_id = _new_id()
            conn.execute(
                "INSERT INTO notes (id, owner_id, workspace_id, conversation_id, current_revision,"
                " updated_by, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
                (note_id, owner_id, workspace_id, conversation_id, owner_id, now),
            )
            current_revision = 0
        else:
            note_id = note["id"]
            current_revision = note["current_revision"]
            if current_revision != expected_revision:
                return None

        new_revision = current_revision + 1
        conn.execute(
            "INSERT INTO note_revisions (id, note_id, revision, content, created_by, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (_new_id(), note_id, new_revision, content, owner_id, now),
        )
        # The revision check is in the WHERE clause as well, so two concurrent
        # writers that both passed the read above cannot both succeed.
        updated = conn.execute(
            "UPDATE notes SET current_revision = ?, updated_by = ?, updated_at = ?"
            " WHERE id = ? AND current_revision = ?",
            (new_revision, owner_id, now, note_id, current_revision),
        )
        if not updated.rowcount:
            raise sqlite3.IntegrityError("note revision advanced concurrently")

    return {
        "conversation_id": conversation_id,
        "workspace_id": workspace_id,
        "revision": new_revision,
        "content": content,
        "updated_at": now,
        "updated_by": owner_id,
    }


def list_note_revisions(owner_id: str, conversation_id: str) -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(
            "SELECT r.revision, r.content, r.created_by, r.created_at FROM note_revisions r"
            " JOIN notes n ON n.id = r.note_id"
            " WHERE n.owner_id = ? AND n.conversation_id = ? ORDER BY r.revision DESC",
            (owner_id, conversation_id),
        ).fetchall()


def get_note_revision(owner_id: str, conversation_id: str, revision: int) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute(
            "SELECT r.revision, r.content FROM note_revisions r JOIN notes n ON n.id = r.note_id"
            " WHERE n.owner_id = ? AND n.conversation_id = ? AND r.revision = ?",
            (owner_id, conversation_id, revision),
        ).fetchone()


def delete_annotations_for_document(document_id: str, owner_id: str) -> int:
    with _connect() as conn:
        return conn.execute(
            "DELETE FROM annotations WHERE document_id = ? AND owner_id = ?",
            (document_id, owner_id),
        ).rowcount


def delete_annotations_for_conversation(conversation_id: str, owner_id: str) -> int:
    """Removes only this conversation's own annotations. A document referenced
    by several conversations keeps the annotations those other conversations
    made against it — annotations belong to the conversation that created
    them, not to the document as a whole."""
    with _connect() as conn:
        return conn.execute(
            "DELETE FROM annotations WHERE conversation_id = ? AND owner_id = ?",
            (conversation_id, owner_id),
        ).rowcount


def delete_note(owner_id: str, conversation_id: str) -> bool:
    """Deletes a conversation's note and its full revision history together,
    in one transaction — a note row without its revisions (or vice versa)
    would be a half-deleted state no code path expects to read back."""
    with _connect() as conn:
        note = conn.execute(
            "SELECT id FROM notes WHERE owner_id = ? AND conversation_id = ?",
            (owner_id, conversation_id),
        ).fetchone()
        if note is None:
            return False
        conn.execute("DELETE FROM note_revisions WHERE note_id = ?", (note["id"],))
        conn.execute("DELETE FROM notes WHERE id = ?", (note["id"],))
        return True


def delete_chat_turns_for_document(document_id: str, owner_id: str) -> int:
    """Clears a document's stored Q&A history without touching the document,
    its index, or its files — used when a conversation is deleted, so a
    single-document desk doesn't reseed the just-deleted messages from this
    table the next time it's opened."""
    with _connect() as conn:
        return conn.execute(
            "DELETE FROM chat_turns WHERE document_id = ? AND owner_id = ?",
            (document_id, owner_id),
        ).rowcount


# --------------------------------------------------------------------------- #
# Workspace state (organizations, workspaces, folders, chats, annotations)
# --------------------------------------------------------------------------- #

def read_state(owner_id: str, key: str) -> tuple[str | None, int]:
    """Return (value, revision). A key that was never written reads as (None, 0),
    which is what a first-run client expects — absence is not an error."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT value, revision FROM user_state WHERE owner_id = ? AND key = ?",
            (owner_id, key),
        ).fetchone()
    return (row["value"], row["revision"]) if row else (None, 0)


def write_state(owner_id: str, key: str, value: str, expected_revision: int) -> int | None:
    """Store `value` only if the row is still at `expected_revision`.

    Returns the new revision, or None when the caller's revision is stale — the
    whole point of the contract, so a second tab can't overwrite newer work.
    Insert and update are one transaction, and the UPDATE carries the revision
    check in its own WHERE clause so the check and the write cannot be split.
    """
    now = _now()
    with _connect() as conn:
        if expected_revision == 0:
            # A brand new key. INSERT fails if another writer got there first,
            # which is itself the conflict signal — no separate existence check.
            try:
                conn.execute(
                    "INSERT INTO user_state (owner_id, key, value, revision, updated_at) VALUES (?, ?, ?, 1, ?)",
                    (owner_id, key, value, now),
                )
                return 1
            except sqlite3.IntegrityError:
                return None
        cursor = conn.execute(
            "UPDATE user_state SET value = ?, revision = revision + 1, updated_at = ? "
            "WHERE owner_id = ? AND key = ? AND revision = ?",
            (value, now, owner_id, key, expected_revision),
        )
        return expected_revision + 1 if cursor.rowcount else None


def list_state_keys(owner_id: str, prefix: str) -> list[str]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT key FROM user_state WHERE owner_id = ? AND key LIKE ? ORDER BY key",
            (owner_id, prefix.replace("%", "") + "%"),
        ).fetchall()
    return [r["key"] for r in rows]


def delete_state(owner_id: str, key: str) -> bool:
    with _connect() as conn:
        return conn.execute(
            "DELETE FROM user_state WHERE owner_id = ? AND key = ?", (owner_id, key)
        ).rowcount > 0


# --------------------------------------------------------------------------- #
# Original files — storage ledger and lifecycle
# --------------------------------------------------------------------------- #

class StorageQuotaExceeded(Exception):
    pass


# Test seam: called between reading the ledger and writing the reservation,
# so a test can widen that window and prove concurrent callers cannot both
# pass the check. Always None in production.
_reserve_window_hook = None


@contextmanager
def _immediate() -> Iterator[sqlite3.Connection]:
    """A write transaction that takes the database write lock up front.

    Python's default (deferred) transaction reads before locking, so two
    threads could both see room under a cap and both reserve. BEGIN IMMEDIATE
    serialises the check with the write. Verified on the staging Azure Files
    mount: 20 concurrent reservations against a cap of 10 granted exactly 10,
    across threads and across processes.
    """
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = DELETE")
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()


def storage_usage(owner_id: str) -> tuple[int, int]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT committed, reserved FROM storage_ledger WHERE owner_id = ?", (owner_id,)
        ).fetchone()
    return (row["committed"], row["reserved"]) if row else (0, 0)


def reserve_storage(owner_id: str, document_id: str, nbytes: int, cap: int) -> str:
    """Reserve `nbytes` before writing anything. Raises StorageQuotaExceeded."""
    reservation_id = _new_id()
    with _immediate() as conn:
        conn.execute("INSERT OR IGNORE INTO storage_ledger (owner_id) VALUES (?)", (owner_id,))
        row = conn.execute(
            "SELECT committed, reserved FROM storage_ledger WHERE owner_id = ?", (owner_id,)
        ).fetchone()
        if _reserve_window_hook is not None:
            _reserve_window_hook()
        if row["committed"] + row["reserved"] + nbytes > cap:
            raise StorageQuotaExceeded(
                f"Storing this file would exceed your {cap // (1024 * 1024)} MB storage limit."
            )
        conn.execute("UPDATE storage_ledger SET reserved = reserved + ? WHERE owner_id = ?", (nbytes, owner_id))
        conn.execute(
            "INSERT INTO storage_reservations (id, owner_id, document_id, bytes, created_at) VALUES (?, ?, ?, ?, ?)",
            (reservation_id, owner_id, document_id, nbytes, _now()),
        )
    return reservation_id


def release_reservation(reservation_id: str) -> None:
    with _immediate() as conn:
        row = conn.execute(
            "SELECT owner_id, bytes FROM storage_reservations WHERE id = ?", (reservation_id,)
        ).fetchone()
        if row is None:
            return
        conn.execute(
            "UPDATE storage_ledger SET reserved = MAX(0, reserved - ?) WHERE owner_id = ?",
            (row["bytes"], row["owner_id"]),
        )
        conn.execute("DELETE FROM storage_reservations WHERE id = ?", (reservation_id,))


def finish_ingest(
    document_id: str,
    owner_id: str,
    *,
    reservation_id: str | None,
    original_path: str | None,
    original_bytes: int | None,
    original_sha256: str | None,
    original_extraction_version: str | None,
) -> bool:
    """Atomically marks an ingesting document ready, records its original and
    turns the reservation into committed usage. Returns False — changing
    nothing — if the row is no longer ingesting (it was deleted meanwhile)."""
    with _immediate() as conn:
        cur = conn.execute(
            "UPDATE documents SET status = 'ready', original_path = ?, original_bytes = ?, original_sha256 = ?, "
            "original_extraction_version = ? WHERE id = ? AND owner_id = ? AND status = 'ingesting'",
            (original_path, original_bytes, original_sha256, original_extraction_version, document_id, owner_id),
        )
        if cur.rowcount == 0:
            return False
        if reservation_id is not None:
            _commit_reservation(conn, reservation_id)
    return True


def attach_original(
    document_id: str,
    owner_id: str,
    *,
    reservation_id: str,
    original_path: str,
    original_bytes: int,
    original_sha256: str,
    original_extraction_version: str,
) -> bool:
    """Records an original attached to an existing ready document. Returns
    False if the document is gone, not ready, or already has an original."""
    with _immediate() as conn:
        cur = conn.execute(
            "UPDATE documents SET original_path = ?, original_bytes = ?, original_sha256 = ?, "
            "original_extraction_version = ? WHERE id = ? AND owner_id = ? AND status = 'ready' "
            "AND original_path IS NULL",
            (original_path, original_bytes, original_sha256, original_extraction_version, document_id, owner_id),
        )
        if cur.rowcount == 0:
            return False
        _commit_reservation(conn, reservation_id)
    return True


def _commit_reservation(conn: sqlite3.Connection, reservation_id: str) -> None:
    row = conn.execute(
        "SELECT owner_id, bytes FROM storage_reservations WHERE id = ?", (reservation_id,)
    ).fetchone()
    if row is None:
        return
    conn.execute(
        "UPDATE storage_ledger SET reserved = MAX(0, reserved - ?), committed = committed + ? WHERE owner_id = ?",
        (row["bytes"], row["bytes"], row["owner_id"]),
    )
    conn.execute("DELETE FROM storage_reservations WHERE id = ?", (reservation_id,))


def discard_ingesting_document(document_id: str, owner_id: str) -> None:
    """Removes the row of an ingest that failed before becoming ready. Nothing
    can reference it yet (it was never listed), so no children exist."""
    with _connect() as conn:
        conn.execute(
            "DELETE FROM documents WHERE id = ? AND owner_id = ? AND status = 'ingesting'",
            (document_id, owner_id),
        )


# --------------------------------------------------------------------------- #
# Account status, last seen, held sign-ups
# --------------------------------------------------------------------------- #

ACCOUNT_STATUSES = ("pending", "approved", "declined", "suspended")

# Tables holding one owner's data, child tables before their parents so a
# delete never trips a foreign key.
_OWNER_TABLES = ("annotations", "chat_turns", "answer_cache", "user_state", "usage_totals", "storage_reservations",
                 "storage_ledger", "documents")
_USER_TABLES = ("otp_codes", "password_reset_tokens", "auth_identities", "trusted_browsers")


def _delete_unverified_users(conn: sqlite3.Connection) -> int:
    ids = [r["id"] for r in conn.execute(
        "SELECT id FROM users WHERE email_verified = 0 AND id NOT IN (SELECT owner_id FROM documents)").fetchall()]
    for user_id in ids:
        for table in _USER_TABLES:
            conn.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    return len(ids)


def set_user_status(user_id: str, status: str, reason: str | None = None) -> bool:
    if status not in ACCOUNT_STATUSES:
        raise ValueError(f"Unknown account status: {status}")
    with _connect() as conn:
        cursor = conn.execute(
            "UPDATE users SET status = ?, status_reason = ?, status_changed_at = ? WHERE id = ?",
            (status, reason, _now(), user_id))
        return cursor.rowcount == 1


def touch_last_seen(user_id: str, at: str | None = None) -> None:
    with _connect() as conn:
        conn.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", (at or _now(), user_id))


def save_pending_signup(email: str, password_hash: str, code_hash: str, *, ttl_minutes: int = 10) -> None:
    """Holds a sign-up until its code is entered. A repeat replaces the
    password and code and restarts the clock; failed attempts start over."""
    from APP.access_control import canonical_email
    now = datetime.now(timezone.utc)
    with _connect() as conn:
        conn.execute(
            """INSERT INTO pending_signups (email_canonical, email, password_hash, code_hash, attempts, created_at, expires_at)
               VALUES (?, ?, ?, ?, 0, ?, ?)
               ON CONFLICT(email_canonical) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash,
                 code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at""",
            (canonical_email(email), email, password_hash, code_hash, now.isoformat(),
             (now + timedelta(minutes=ttl_minutes)).isoformat()))


def update_pending_password(email: str, password_hash: str) -> None:
    from APP.access_control import canonical_email
    with _connect() as conn:
        conn.execute("UPDATE pending_signups SET password_hash = ? WHERE email_canonical = ?", (password_hash, canonical_email(email)))


def refresh_pending_code(email: str, code_hash: str, *, ttl_minutes: int = 10) -> bool:
    from APP.access_control import canonical_email
    with _connect() as conn:
        cursor = conn.execute(
            "UPDATE pending_signups SET code_hash = ?, attempts = 0, expires_at = ? WHERE email_canonical = ? AND expires_at >= ?",
            (code_hash, (datetime.now(timezone.utc) + timedelta(minutes=ttl_minutes)).isoformat(), canonical_email(email), _now()))
        return cursor.rowcount == 1


def get_pending_signup(email: str) -> sqlite3.Row | None:
    """The live sign-up for an inbox, or None. An expired one is removed."""
    from APP.access_control import canonical_email
    with _connect() as conn:
        conn.execute("DELETE FROM pending_signups WHERE expires_at < ?", (_now(),))
        return conn.execute("SELECT * FROM pending_signups WHERE email_canonical = ?", (canonical_email(email),)).fetchone()


def record_pending_attempt(email: str) -> int:
    from APP.access_control import canonical_email
    with _connect() as conn:
        conn.execute("UPDATE pending_signups SET attempts = attempts + 1 WHERE email_canonical = ?", (canonical_email(email),))
        row = conn.execute("SELECT attempts FROM pending_signups WHERE email_canonical = ?", (canonical_email(email),)).fetchone()
        return row["attempts"] if row else 0


def delete_pending_signup(email: str) -> None:
    from APP.access_control import canonical_email
    with _connect() as conn:
        conn.execute("DELETE FROM pending_signups WHERE email_canonical = ?", (canonical_email(email),))


def delete_unverified_user(user_id: str) -> None:
    """Removes a legacy unverified row (one created before sign-ups were held)."""
    with _connect() as conn:
        row = conn.execute("SELECT email_verified FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None or row["email_verified"]:
            return
        for table in _USER_TABLES:
            conn.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ? AND id NOT IN (SELECT owner_id FROM documents)", (user_id,))


# --------------------------------------------------------------------------- #
# Events (activity log)
# --------------------------------------------------------------------------- #

def record_event(type: str, *, user_id: str | None = None, email: str | None = None, country: str | None = None,
                 timezone_name: str | None = None, detail: dict | None = None) -> None:
    import json
    with _connect() as conn:
        conn.execute(
            "INSERT INTO events (at, type, user_id, email, country, timezone, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (_now(), type, user_id, email, country, timezone_name, json.dumps(detail) if detail else None))


def list_events(*, types: list[str] | None = None, user_id: str | None = None, since: str | None = None,
                before_id: int | None = None, limit: int = 100) -> list[sqlite3.Row]:
    where, args = [], []
    if types:
        where.append("(" + " OR ".join("type = ? OR type LIKE ?" for _ in types) + ")")
        for t in types:
            args += [t, t.rstrip(".") + ".%"]
    if user_id:
        where.append("user_id = ?"); args.append(user_id)
    if since:
        where.append("at >= ?"); args.append(since)
    if before_id:
        where.append("id < ?"); args.append(before_id)
    sql = "SELECT * FROM events" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY id DESC LIMIT ?"
    with _connect() as conn:
        return conn.execute(sql, (*args, max(1, min(limit, 500)))).fetchall()


def admin_notice_summary(since: str) -> tuple[int, sqlite3.Row | None, sqlite3.Row | None]:
    """Admin notifications since `since`: how many failed (all of them, not a
    page), the latest failed one and the latest sent one."""
    outcome = "json_extract(detail, '$.outcome')"
    with _connect() as conn:
        failed = conn.execute(f"SELECT COUNT(*) FROM events WHERE type = 'admin.notified' AND at >= ? AND {outcome} = 'failed'", (since,)).fetchone()[0]
        last = lambda o: conn.execute(f"SELECT * FROM events WHERE type = 'admin.notified' AND at >= ? AND {outcome} = ? ORDER BY id DESC LIMIT 1",
                                      (since, o)).fetchone()
        return failed, last("failed"), last("sent")


def count_user_events(user_id: str, types: list[str], since: str) -> int:
    marks = ",".join("?" for _ in types)
    with _connect() as conn:
        return conn.execute(f"SELECT COUNT(*) FROM events WHERE user_id = ? AND at >= ? AND type IN ({marks})",
                            (user_id, since, *types)).fetchone()[0]


def reset_user_usage(owner_id: str, day: str) -> dict:
    """Gives an account its allowance back: everything it has used (in total
    and per day) goes to zero, and what it used today is also given back to
    the site-wide daily count it was part of. One transaction. Returns what
    was cleared."""
    with _immediate() as conn:
        totals = {r["kind"]: r["used"] for r in conn.execute("SELECT kind, used FROM usage_totals WHERE owner_id = ?", (owner_id,))}
        today = {r["kind"]: r["used"] for r in conn.execute(
            "SELECT kind, used FROM usage_account_daily WHERE owner_id = ? AND day = ?", (owner_id, day))}
        for kind, used in today.items():
            conn.execute("UPDATE usage_daily SET used = MAX(used - ?, 0) WHERE day = ? AND kind = ?", (used, day, kind))
        conn.execute("DELETE FROM usage_totals WHERE owner_id = ?", (owner_id,))
        conn.execute("DELETE FROM usage_account_daily WHERE owner_id = ?", (owner_id,))
    return {"total": totals, "today": today}


def reset_daily_usage(day: str) -> dict:
    """Sets the site-wide count for one day back to zero; returns what it was.
    Accounts' own counts are untouched."""
    with _immediate() as conn:
        before = {r["kind"]: r["used"] for r in conn.execute("SELECT kind, used FROM usage_daily WHERE day = ?", (day,))}
        conn.execute("DELETE FROM usage_daily WHERE day = ?", (day,))
    return before


def count_events(type: str, since: str) -> int:
    with _connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM events WHERE type = ? AND at >= ?", (type, since)).fetchone()[0]


# --------------------------------------------------------------------------- #
# Demo requests
# --------------------------------------------------------------------------- #

def create_demo_request(name: str, email: str, phone: str | None, comment: str | None) -> str:
    from APP.access_control import canonical_email, normalize_email
    request_id = _new_id()
    approved = is_access_approved(email)
    with _connect() as conn:
        conn.execute(
            "INSERT INTO demo_requests (id, at, name, email, email_canonical, phone, comment, status, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (request_id, _now(), name, normalize_email(email), canonical_email(email), phone, comment,
             "approved" if approved else "pending", _now() if approved else None))
    return request_id


def list_demo_requests(status: str | None = None, limit: int = 200) -> list[sqlite3.Row]:
    with _connect() as conn:
        if status:
            return conn.execute("SELECT * FROM demo_requests WHERE status = ? ORDER BY at DESC LIMIT ?", (status, limit)).fetchall()
        return conn.execute("SELECT * FROM demo_requests ORDER BY at DESC LIMIT ?", (limit,)).fetchall()


def get_demo_request(request_id: str) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute("SELECT * FROM demo_requests WHERE id = ?", (request_id,)).fetchone()


def mark_demo_requests(email: str, status: str) -> None:
    from APP.access_control import canonical_email
    with _connect() as conn:
        conn.execute("UPDATE demo_requests SET status = ?, decided_at = ? WHERE email_canonical = ? AND status = 'pending'",
                     (status, _now(), canonical_email(email)))


# --------------------------------------------------------------------------- #
# API request counts
# --------------------------------------------------------------------------- #

def add_api_requests(rows: dict[tuple[str, str], tuple[int, int]]) -> None:
    if not rows:
        return
    with _connect() as conn:
        conn.executemany(
            """INSERT INTO api_requests_daily (day, bucket, requests, errors) VALUES (?, ?, ?, ?)
               ON CONFLICT(day, bucket) DO UPDATE SET requests = requests + excluded.requests, errors = errors + excluded.errors""",
            [(day, bucket, n, e) for (day, bucket), (n, e) in rows.items()])


def api_requests_since(day: str) -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute("SELECT * FROM api_requests_daily WHERE day >= ? ORDER BY day", (day,)).fetchall()


# --------------------------------------------------------------------------- #
# Admin views
# --------------------------------------------------------------------------- #

def admin_user_list(query: str = "", status: str | None = None, limit: int = 50, offset: int = 0) -> tuple[list[sqlite3.Row], int]:
    where, args = [], []
    if query:
        where.append("u.email LIKE ?"); args.append(f"%{query.strip().lower()}%")
    if status == "members":
        where.append("u.status IN ('approved', 'suspended')")
    elif status:
        where.append("u.status = ?"); args.append(status)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    with _connect() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM users u{clause}", args).fetchone()[0]
        rows = conn.execute(f"""
            SELECT u.id, u.email, u.status, u.status_reason, u.created_at, u.last_seen_at, u.email_verified,
                   (SELECT COUNT(*) FROM documents d WHERE d.owner_id = u.id) AS documents,
                   (SELECT COUNT(*) FROM chat_turns c WHERE c.owner_id = u.id) AS questions,
                   (SELECT GROUP_CONCAT(provider) FROM auth_identities a WHERE a.user_id = u.id) AS providers,
                   u.password_hash IS NOT NULL AS has_password
            FROM users u{clause}
            ORDER BY COALESCE(u.last_seen_at, u.created_at) DESC
            LIMIT ? OFFSET ?""", (*args, max(1, min(limit, 200)), max(0, offset))).fetchall()
    return rows, total


def admin_user_counts(online_ids: set[str], day_ago: str, week_ago: str) -> dict:
    """`online_ids`: accounts with a workspace tab active right now (from
    APP/presence.py); only approved ones count."""
    with _connect() as conn:
        one = lambda sql, *a: conn.execute(sql, a).fetchone()[0]
        by_status = {r["status"]: r["n"] for r in conn.execute("SELECT status, COUNT(*) AS n FROM users GROUP BY status")}
        return {
            "total": one("SELECT COUNT(*) FROM users"),
            "by_status": {s: by_status.get(s, 0) for s in ACCOUNT_STATUSES},
            "new_24h": one("SELECT COUNT(*) FROM users WHERE created_at >= ?", day_ago),
            "new_7d": one("SELECT COUNT(*) FROM users WHERE created_at >= ?", week_ago),
            "members": one("SELECT COUNT(*) FROM users WHERE status IN ('approved', 'suspended')"),
            "online_now": (one(f"SELECT COUNT(*) FROM users WHERE status = 'approved' AND id IN ({','.join('?' * len(online_ids))})", *online_ids)
                           if online_ids else 0),
            "active_24h": one("SELECT COUNT(*) FROM users WHERE last_seen_at >= ?", day_ago),
            "documents": one("SELECT COUNT(*) FROM documents"),
            "questions": one("SELECT COUNT(*) FROM chat_turns"),
            "demo_requests_pending": one("SELECT COUNT(*) FROM demo_requests WHERE status = 'pending'"),
            "demo_requests_total": one("SELECT COUNT(*) FROM demo_requests"),
        }


def per_day_counts(since: str) -> dict[str, dict[str, int]]:
    """Uploads (documents added) and questions (answered turns) per UTC day.
    Both come from the stored rows themselves, so history predates the
    activity log."""
    with _connect() as conn:
        uploads = conn.execute("SELECT substr(ingested_at, 1, 10) AS d, COUNT(*) AS n FROM documents WHERE ingested_at >= ? GROUP BY d", (since,)).fetchall()
        questions = conn.execute("SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n FROM chat_turns WHERE created_at >= ? GROUP BY d", (since,)).fetchall()
        signups = conn.execute("SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY d", (since,)).fetchall()
    out: dict[str, dict[str, int]] = {}
    for name, rows in (("uploads", uploads), ("questions", questions), ("signups", signups)):
        for r in rows:
            out.setdefault(r["d"], {"uploads": 0, "questions": 0, "signups": 0})[name] = r["n"]
    return out


def admin_user_detail(user_id: str) -> dict | None:
    with _connect() as conn:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if user is None:
            return None
        docs = conn.execute("SELECT id, filename, ingested_at, pages, status, original_bytes FROM documents WHERE owner_id = ? ORDER BY ingested_at DESC", (user_id,)).fetchall()
        one = lambda sql: conn.execute(sql, (user_id,)).fetchone()[0]
        usage_rows = conn.execute("SELECT kind, used FROM usage_totals WHERE owner_id = ?", (user_id,)).fetchall()
        storage = conn.execute("SELECT committed, reserved FROM storage_ledger WHERE owner_id = ?", (user_id,)).fetchone()
        providers = [r["provider"] for r in conn.execute("SELECT provider FROM auth_identities WHERE user_id = ?", (user_id,))]
        return {
            "user": dict(user), "providers": providers, "documents": [dict(d) for d in docs],
            "questions": one("SELECT COUNT(*) FROM chat_turns WHERE owner_id = ?"),
            "highlights": one("SELECT COUNT(*) FROM annotations WHERE owner_id = ?"),
            "notes": one("SELECT COUNT(*) FROM notes WHERE owner_id = ?"),
            "usage": {r["kind"]: r["used"] for r in usage_rows},
            "storage_bytes": storage["committed"] if storage else 0,
        }


def delete_user_rows(user_id: str) -> None:
    """Every row belonging to an account, then the account. Files and vectors
    are removed by the caller first (they live outside this database)."""
    from APP.access_control import canonical_email
    with _connect() as conn:
        user = conn.execute("SELECT email FROM users WHERE id = ?", (user_id,)).fetchone()
        if user is None:
            return
        note_ids = [r["id"] for r in conn.execute("SELECT id FROM notes WHERE owner_id = ?", (user_id,))]
        for note_id in note_ids:
            conn.execute("DELETE FROM note_revisions WHERE note_id = ?", (note_id,))
        conn.execute("DELETE FROM notes WHERE owner_id = ?", (user_id,))
        for table in _OWNER_TABLES:
            conn.execute(f"DELETE FROM {table} WHERE owner_id = ?", (user_id,))
        for table in _USER_TABLES:
            conn.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
        canonical = canonical_email(user["email"])
        conn.execute("DELETE FROM access_approvals WHERE email_canonical = ?", (canonical,))
        conn.execute("DELETE FROM pending_signups WHERE email_canonical = ?", (canonical,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))


def table_counts() -> dict[str, int]:
    with _connect() as conn:
        names = [r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        return {name: conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0] for name in names}


# --------------------------------------------------------------------------- #
# Sample documents
# --------------------------------------------------------------------------- #

def create_sample(name: str, filename: str, kind: str, nbytes: int, sha256: str, path: str, sample_id: str | None = None) -> str:
    sample_id = sample_id or _new_id()
    with _connect() as conn:
        conn.execute("INSERT INTO sample_documents (id, name, filename, kind, bytes, sha256, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                     (sample_id, name, filename, kind, nbytes, sha256, path, _now()))
    return sample_id


def list_samples() -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute("SELECT * FROM sample_documents ORDER BY kind, name").fetchall()


def get_sample(sample_id: str) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute("SELECT * FROM sample_documents WHERE id = ?", (sample_id,)).fetchone()


def rename_sample(sample_id: str, name: str) -> bool:
    with _connect() as conn:
        return conn.execute("UPDATE sample_documents SET name = ? WHERE id = ?", (name, sample_id)).rowcount == 1


def delete_sample(sample_id: str) -> sqlite3.Row | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM sample_documents WHERE id = ?", (sample_id,)).fetchone()
        if row is not None:
            conn.execute("DELETE FROM sample_documents WHERE id = ?", (sample_id,))
        return row


# --------------------------------------------------------------------------- #
# Sign-in codes and trusted browsers
# --------------------------------------------------------------------------- #

def create_login_code(user_id: str, code_hash: str, *, ttl_minutes: int = 10) -> str:
    """A fresh sign-in code; any earlier unused one stops working."""
    otp_id = _new_id()
    with _connect() as conn:
        conn.execute("UPDATE otp_codes SET consumed_at = ? WHERE user_id = ? AND purpose = 'login' AND consumed_at IS NULL",
                     (_now(), user_id))
        conn.execute(
            "INSERT INTO otp_codes (id, user_id, code_hash, purpose, expires_at, consumed_at, attempts) VALUES (?, ?, ?, 'login', ?, NULL, 0)",
            (otp_id, user_id, code_hash, (datetime.now(timezone.utc) + timedelta(minutes=ttl_minutes)).isoformat()))
    return otp_id


def get_live_login_code(otp_id: str, user_id: str) -> sqlite3.Row | None:
    with _connect() as conn:
        return conn.execute(
            "SELECT * FROM otp_codes WHERE id = ? AND user_id = ? AND purpose = 'login' AND consumed_at IS NULL AND expires_at > ?",
            (otp_id, user_id, _now())).fetchone()


def record_code_attempt(otp_id: str) -> int:
    with _connect() as conn:
        conn.execute("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?", (otp_id,))
        return conn.execute("SELECT attempts FROM otp_codes WHERE id = ?", (otp_id,)).fetchone()["attempts"]


def add_trusted_browser(user_id: str, token_hash: str, label: str | None, days: int) -> str:
    browser_id = _new_id()
    now = datetime.now(timezone.utc)
    with _connect() as conn:
        conn.execute("INSERT INTO trusted_browsers (id, user_id, token_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
                     (browser_id, user_id, token_hash, label, now.isoformat(), (now + timedelta(days=days)).isoformat()))
    return browser_id


def use_trusted_browser(user_id: str, token_hashes: list[str]) -> bool:
    """True (and marks it used) if one of these tokens is an unexpired trusted
    browser of this account."""
    if not token_hashes:
        return False
    with _connect() as conn:
        conn.execute("DELETE FROM trusted_browsers WHERE expires_at <= ?", (_now(),))
        marks = ",".join("?" * len(token_hashes))
        row = conn.execute(f"SELECT id FROM trusted_browsers WHERE user_id = ? AND token_hash IN ({marks})",
                           (user_id, *token_hashes)).fetchone()
        if row is None:
            return False
        conn.execute("UPDATE trusted_browsers SET last_used_at = ? WHERE id = ?", (_now(), row["id"]))
        return True


def list_trusted_browsers(user_id: str) -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(
            "SELECT id, label, created_at, expires_at, last_used_at FROM trusted_browsers WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC",
            (user_id, _now())).fetchall()


def remove_trusted_browser(user_id: str, browser_id: str) -> bool:
    with _connect() as conn:
        return conn.execute("DELETE FROM trusted_browsers WHERE id = ? AND user_id = ?", (browser_id, user_id)).rowcount == 1


def forget_trusted_browsers(user_id: str) -> int:
    with _connect() as conn:
        return conn.execute("DELETE FROM trusted_browsers WHERE user_id = ?", (user_id,)).rowcount


def end_all_sessions(user_id: str) -> None:
    """Signs the account out everywhere: every issued token stops working
    (token_version) and every trusted browser is forgotten."""
    with _connect() as conn:
        conn.execute("UPDATE users SET token_version = token_version + 1 WHERE id = ?", (user_id,))
        conn.execute("DELETE FROM trusted_browsers WHERE user_id = ?", (user_id,))
