"""Auth: GitHub/Google OAuth exchange, password hashing, OTP, JWT issuance
and verification. `get_current_user` replaces the old shared-secret check
everywhere — mandatory login supersedes it, so there's no dual mode.

Env vars expected at runtime (plain names, not the _PROD/_DEV suffixed
variants used in local notes for convenience — each deployment's Container
App secrets supply whichever pair is right for that environment):
  GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
  JWT_SECRET_KEY  (generate with: python -c "import secrets; print(secrets.token_urlsafe(32))")
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import httpx
import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from APP import db

JWT_ALGORITHM = "HS256"
JWT_EXPIRY_DAYS = 7

GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL = "https://api.github.com/user"
GITHUB_EMAILS_URL = "https://api.github.com/user/emails"

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"


class OAuthError(Exception):
    """Raised when a provider's token/userinfo exchange fails or returns no verified email."""


def _jwt_secret() -> str:
    secret = os.getenv("JWT_SECRET_KEY")
    if not secret:
        raise RuntimeError("JWT_SECRET_KEY is not set")
    return secret


# --------------------------------------------------------------------------- #
# GitHub / Google OAuth exchange
# --------------------------------------------------------------------------- #

def exchange_github_code(code: str) -> dict:
    """Exchanges an OAuth code for the GitHub user's id + verified primary email.

    The client secret never leaves this function — it's read from the
    environment and sent directly to GitHub, not passed through from the caller.
    """
    client_id = os.getenv("GITHUB_CLIENT_ID")
    client_secret = os.getenv("GITHUB_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise RuntimeError("GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET are not set")

    with httpx.Client(timeout=10.0) as client:
        token_resp = client.post(
            GITHUB_TOKEN_URL,
            headers={"Accept": "application/json"},
            data={"client_id": client_id, "client_secret": client_secret, "code": code},
        )
        token_resp.raise_for_status()
        access_token = token_resp.json().get("access_token")
        if not access_token:
            raise OAuthError("GitHub did not return an access token")

        auth_headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/vnd.github+json"}
        user_resp = client.get(GITHUB_USER_URL, headers=auth_headers)
        user_resp.raise_for_status()
        user = user_resp.json()

        # GitHub's /user.email is null unless the user made it public — fall
        # back to /user/emails (requires the user:email scope) for the
        # verified primary address.
        email = user.get("email")
        if not email:
            emails_resp = client.get(GITHUB_EMAILS_URL, headers=auth_headers)
            emails_resp.raise_for_status()
            for entry in emails_resp.json():
                if entry.get("primary") and entry.get("verified"):
                    email = entry.get("email")
                    break

    if not email:
        raise OAuthError("GitHub account has no verified email available")

    return {"provider_user_id": str(user["id"]), "email": email}


def exchange_google_code(code: str, redirect_uri: str) -> dict:
    """Exchanges an OAuth code for the Google user's id + verified email."""
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise RuntimeError("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set")

    with httpx.Client(timeout=10.0) as client:
        token_resp = client.post(
            GOOGLE_TOKEN_URL,
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
        token_resp.raise_for_status()
        access_token = token_resp.json().get("access_token")
        if not access_token:
            raise OAuthError("Google did not return an access token")

        userinfo_resp = client.get(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
        userinfo_resp.raise_for_status()
        userinfo = userinfo_resp.json()

    if not userinfo.get("email") or not userinfo.get("email_verified"):
        raise OAuthError("Google account has no verified email")

    return {"provider_user_id": userinfo["sub"], "email": userinfo["email"]}


# --------------------------------------------------------------------------- #
# Password hashing
# --------------------------------------------------------------------------- #

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))


# --------------------------------------------------------------------------- #
# OTP — 6-digit codes, hashed at rest, never stored or logged in plaintext
# --------------------------------------------------------------------------- #

def generate_otp_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def hash_otp_code(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def verify_otp_code(code: str, code_hash: str) -> bool:
    return hmac.compare_digest(hash_otp_code(code), code_hash)


def is_otp_expired(expires_at_iso: str) -> bool:
    expires_at = datetime.fromisoformat(expires_at_iso)
    return datetime.now(timezone.utc) > expires_at


# --------------------------------------------------------------------------- #
# Password reset tokens — a link-click credential, not a typed code, so a
# separate generator from the OTP one above: longer, URL-safe, and delivered
# only inside an emailed link.
# --------------------------------------------------------------------------- #

def generate_reset_token() -> str:
    return secrets.token_urlsafe(32)


def hash_reset_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# JWT
# --------------------------------------------------------------------------- #

def create_access_token(user_id: str, token_version: int = 0) -> str:
    """`tv` records the account's token_version at issuance. A password reset
    increments the stored value, so every token issued before that reset
    stops matching and get_current_user rejects it — real session
    invalidation despite JWTs being otherwise stateless.
    """
    now = datetime.now(timezone.utc)
    payload = {"sub": user_id, "tv": token_version, "iat": now, "exp": now + timedelta(days=JWT_EXPIRY_DAYS)}
    return jwt.encode(payload, _jwt_secret(), algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    """Returns the full decoded payload (not just the user id), so callers can
    also check the `tv` claim. Raises jwt exceptions on failure.
    """
    return jwt.decode(token, _jwt_secret(), algorithms=[JWT_ALGORITHM])


# auto_error=False so a missing/!Bearer header falls through to the explicit
# 401 below rather than FastAPI's generic 403 — keeps the response identical
# to the hand-rolled Header() version this replaced, while still declaring a
# real securityScheme so /docs renders a single "Authorize" button instead of
# a raw header field on every endpoint.
_bearer_scheme = HTTPBearer(auto_error=False)


# Paths a signed-in account may reach before it is approved (or after it is
# declined): enough to see its own status, nothing that touches documents.
# Not /me/presence: only an approved account can be in the workspace, so a
# pending, declined or suspended one never reports presence.
ACCOUNT_OPEN_PATHS = frozenset({"/me", "/me/usage", "/me/heartbeat", "/me/sign-out-everywhere", "/auth/accept-privacy-policy"})

SUSPENDED_DETAIL = "This account is suspended. If you think this is a mistake, contact hello@citely.example."
STATUS_DETAILS = {
    "pending": "Your account is under review. We'll email you when it's approved.",
    "declined": "Your account wasn't approved this time.",
}


def account_block(user, path: str | None = None) -> HTTPException | None:
    """Why this account may not proceed, or None. A suspended account is
    stopped everywhere; a pending or declined one only outside its own
    account endpoints."""
    state = user["status"] if "status" in user.keys() else "approved"
    if state == "suspended":
        return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=SUSPENDED_DETAIL,
                             headers={"X-Citely-Account": "suspended"})
    if state in STATUS_DETAILS and path not in ACCOUNT_OPEN_PATHS:
        return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=STATUS_DETAILS[state],
                             headers={"X-Citely-Account": state})
    return None


def refuse_suspended(user) -> None:
    """Sign-in step: a suspended account is given no token."""
    if (user["status"] if "status" in user.keys() else "approved") == "suspended":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=SUSPENDED_DETAIL,
                            headers={"X-Citely-Account": "suspended"})


def get_current_user(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme)):
    """FastAPI dependency replacing the old require_api_key check everywhere.

    Every route that used to depend on require_api_key now depends on this
    instead — mandatory login supersedes the shared-secret deterrent.

    Plain `def`, not `async def`: it reads the user row from SQLite on the SMB
    mount. As a coroutine that read ran on the event loop, so every
    authenticated request briefly froze every other request in the process.
    FastAPI runs sync dependencies in its threadpool instead.
    """
    if credentials is None or (credentials.scheme or "").lower() != "bearer":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing or malformed Authorization header")

    token = (credentials.credentials or "").strip()
    try:
        payload = decode_access_token(token)
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    user = db.get_user_by_id(payload["sub"])
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    # A token with no `tv` claim (issued before token_version existed) is
    # treated as version 0, matching that column's default — so this only
    # ever rejects a token issued *before* an account's most recent password
    # reset, never every pre-existing session on an unrelated deploy.
    if payload.get("tv", 0) != user["token_version"]:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session no longer valid — please sign in again")

    blocked = account_block(user, request.url.path)
    if blocked is not None:
        raise blocked
    # No "last seen" here: presence comes only from the workspace's own
    # signals (POST /me/presence), not from any authenticated request.
    return user
