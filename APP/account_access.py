"""Who gets in, and how sign-in is confirmed.

ACCESS_MODE
  review (default; dev and prod): anyone may create an account, but a new one
         starts "pending" until the admin approves it, unless that address was
         approved already (an approved demo request, CITELY_APPROVED_EMAILS) or
         is the admin's.
  open   (the hackathon environment): every new account is approved at once.

LOGIN_EMAIL_CODE
  on (dev and prod): an approved account confirms each sign-in with a 6-digit
     code emailed to its verified address, unless the browser was trusted in
     the last TRUSTED_BROWSER_DAYS (30). Pending and declined accounts sign in
     without one: they can only see their own status.
  off (default; the hackathon environment and tests).
"""

from __future__ import annotations

import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone

import jwt

from APP import access_control as ac
from APP import db

LOGIN_CODE_MINUTES = 10
MAX_LOGIN_CODE_ATTEMPTS = 5
_TICKET_PURPOSE = "citely-login-code"


def access_mode() -> str:
    mode = os.getenv("ACCESS_MODE", "review").strip().lower()
    return mode if mode in ("review", "open") else "review"


def login_code_required() -> bool:
    return os.getenv("LOGIN_EMAIL_CODE", "off").strip().lower() in ("1", "on", "true", "yes")


def trusted_browser_days() -> int:
    try:
        return max(1, int(os.getenv("TRUSTED_BROWSER_DAYS", "30")))
    except ValueError:
        return 30


def pre_approved(email: str) -> bool:
    approved = {ac.canonical_email(e) for e in os.getenv("CITELY_APPROVED_EMAILS", "").split(",") if e.strip()}
    return ac.is_admin_email(email) or db.is_access_approved(email) or ac.canonical_email(email) in approved


def initial_status(email: str) -> str:
    """The status a brand-new account starts with."""
    return "approved" if access_mode() == "open" or pre_approved(email) else "pending"


def mask_email(email: str) -> str:
    """v••••@gmail.com: enough to recognise, not to read."""
    local, _, domain = email.partition("@")
    return (local[:1] + "••••" if local else "") + "@" + domain


# --------------------------------------------------------------------------- #
# Sign-in tickets: what the browser holds between "password right" and "code
# right". A ticket alone signs nobody in.
# --------------------------------------------------------------------------- #

def _secret() -> str:
    from APP.auth.service import _jwt_secret
    return _jwt_secret()


def make_ticket(user_id: str, code_id: str) -> str:
    now = datetime.now(timezone.utc)
    claims = {"purpose": _TICKET_PURPOSE, "sub": user_id, "cid": code_id, "iat": now,
              "exp": now + timedelta(minutes=LOGIN_CODE_MINUTES)}
    return jwt.encode(claims, _secret(), algorithm="HS256")


def read_ticket(ticket: str) -> tuple[str, str] | None:
    try:
        claims = jwt.decode(ticket, _secret(), algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if claims.get("purpose") != _TICKET_PURPOSE:
        return None
    return claims.get("sub"), claims.get("cid")


# --------------------------------------------------------------------------- #
# Trusted browsers
# --------------------------------------------------------------------------- #

def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def trust_browser(user_id: str, label: str | None) -> str:
    token = secrets.token_urlsafe(32)
    db.add_trusted_browser(user_id, _hash(token), (label or "").strip()[:120] or None, trusted_browser_days())
    return token


def browser_is_trusted(user_id: str, tokens: list[str]) -> bool:
    tokens = [t for t in tokens if isinstance(t, str) and 20 <= len(t) <= 200][:10]
    return db.use_trusted_browser(user_id, [_hash(t) for t in tokens])
