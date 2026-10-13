"""Account protection: who may sign up, with which email and password, and who
is the admin.

Modelled on how large providers keep sign-up honest without phone numbers:
- an email must be well formed, its domain must actually receive mail, and it
  must not be a disposable/temporary inbox: neither on the domain list nor
  served by a temp-mail service's mail servers (APP/disposable.py);
- addresses that reach the same inbox (Gmail dots, "+tag" aliases) count as
  one person, so one mailbox cannot open many accounts;
- passwords must be long, mixed and not on the list of the most common ones;
- a Cloudflare Turnstile check stops scripted sign-ups (when configured);
- anonymous rate limits key on the visitor's own address, not the proxy's.

Settings (environment, never code):
  CITELY_ADMIN_EMAILS   comma-separated admin emails: no usage limits,
                        always approved, may approve others.
  TURNSTILE_SECRET_KEY  enables the bot check on sign-up when set.
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import httpx
import jwt

from APP import disposable

logger = logging.getLogger("rag_api.access")

_DATA = Path(__file__).resolve().parent / "auth" / "lists"   # not "data": that name is git- and docker-ignored


# --------------------------------------------------------------------------- #
# Visitor address
# --------------------------------------------------------------------------- #

def client_ip(request) -> str:
    """The visitor's address. Behind Azure Container Apps every connection
    comes from the ingress proxy, which appends the real client address as the
    last X-Forwarded-For entry (earlier entries are whatever the client sent,
    so they are not trusted)."""
    forwarded = request.headers.get("x-forwarded-for", "")
    hops = [h.strip() for h in forwarded.split(",") if h.strip()]
    if hops:
        return hops[-1]
    return request.client.host if request.client else "unknown"


# --------------------------------------------------------------------------- #
# Email
# --------------------------------------------------------------------------- #

_LOCAL = r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
_EMAIL = re.compile(rf"^(?P<local>{_LOCAL})@(?P<domain>(?:{_LABEL}\.)+[A-Za-z]{{2,63}})$")


class EmailRejected(ValueError):
    """str(exc) is the sentence shown to the person; .reason ("invalid",
    "no_mail" or "disposable") is what the activity log records."""

    def __init__(self, message: str, reason: str = "invalid"):
        super().__init__(message)
        self.reason = reason


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def canonical_email(email: str) -> str:
    """The inbox an address really delivers to, for "one account per inbox".
    Drops "+tag" aliases everywhere, and dots for Gmail (which ignores them)."""
    email = normalize_email(email)
    local, _, domain = email.rpartition("@")
    if not local:
        return email
    local = local.split("+", 1)[0]
    if domain in ("gmail.com", "googlemail.com"):
        domain = "gmail.com"
        local = local.replace(".", "")
    return f"{local}@{domain}"


def is_disposable(domain: str) -> bool:
    """On the disposable domain list (the domain or a parent), and not a
    mainstream provider. No DNS: the mail-server check is in
    check_signup_email and disposable.disposable_reason."""
    return disposable.listed(domain)


def _domain_receives_mail(domain: str) -> bool:
    """Whether the domain publishes a mail server (MX, or an address record as
    the RFC 5321 fallback). Resolver trouble counts as yes: a flaky resolver
    must not lock out real people; the verification code still has to arrive.
    The answer is cached and shared with the mail-server check below."""
    return disposable.receives_mail(domain)


DISPOSABLE_MESSAGE = ("Temporary or disposable email addresses can't be used with Citely. "
                      "Please use your work email, or continue with Google or GitHub.")


def check_signup_email(email: str) -> str:
    """Returns the normalized email, or raises EmailRejected with a message
    that can be shown to the person."""
    email = normalize_email(email)
    match = _EMAIL.fullmatch(email) if len(email) <= 254 else None
    if not match or len(match.group("local")) > 64:
        raise EmailRejected("Enter a valid email address.")
    domain = match.group("domain")
    if is_disposable(domain):
        raise EmailRejected(DISPOSABLE_MESSAGE, reason="disposable")
    if not _domain_receives_mail(domain):
        raise EmailRejected("That email domain doesn't receive mail. Check the address and try again.", reason="no_mail")
    # A brand-new temp-mail domain is on no list yet, but its mail still goes
    # to the service's own servers.
    server = disposable.infrastructure_match(domain)
    if server:
        logger.info("email_domain_disposable_infrastructure", extra={"domain": domain, "server": server})
        raise EmailRejected(DISPOSABLE_MESSAGE, reason="disposable")
    return email


# --------------------------------------------------------------------------- #
# Passwords
# --------------------------------------------------------------------------- #

MIN_PASSWORD_LENGTH = 12
_UNLEET = str.maketrans({"@": "a", "4": "a", "0": "o", "1": "i", "!": "i", "3": "e", "$": "s", "5": "s", "7": "t"})
_SEQUENCES = ("abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertyuiop", "asdfghjkl", "zxcvbnm")


@lru_cache(maxsize=1)
def _common_passwords() -> frozenset[str]:
    lines = (_DATA / "common_passwords.txt").read_text(errors="ignore").splitlines()
    return frozenset(line.strip().lower() for line in lines if line.strip())


def _has_run(text: str, length: int = 4) -> bool:
    """Four or more repeated characters, or a run along the alphabet, digits
    or a keyboard row (either direction): "aaaa", "1234", "dcba", "qwer"."""
    if re.search(r"(.)\1{%d,}" % (length - 1), text):
        return True
    for seq in _SEQUENCES:
        for s in (seq, seq[::-1]):
            if any(s[i:i + length] in text for i in range(len(s) - length + 1)):
                return True
    return False


def password_problem(password: str, email: str = "") -> str | None:
    """None if the password is strong enough, otherwise one plain sentence
    saying what to fix. Mirrored in the sign-up form, enforced here."""
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Use at least {MIN_PASSWORD_LENGTH} characters."
    if len(password) > 128:
        return "Use at most 128 characters."
    classes = sum(bool(re.search(p, password)) for p in (r"[a-z]", r"[A-Z]", r"[0-9]", r"[^A-Za-z0-9]"))
    if classes < 3:
        return "Mix at least three of: lowercase letters, uppercase letters, numbers and symbols."
    lowered = password.lower()
    unleet = lowered.translate(_UNLEET)              # "P@ssw0rd" → "password"
    core = re.sub(r"[^a-z]", "", unleet)             # "p@ssword2024!" → "password"
    letters = re.sub(r"[^a-z0-9]", "", lowered)
    common = _common_passwords()
    base = re.sub(r"[\d\W_]+$", "", lowered)          # "p@ssword12345" → "p@ssword"
    if lowered in common or letters in common or unleet in common or (len(core) >= 4 and core in common) \
            or base in common or base.translate(_UNLEET) in common:
        return "That password is too common. Choose something less predictable."
    local = normalize_email(email).split("@", 1)[0]
    if len(local) >= 4 and local in lowered:
        return "Don't include your email address in your password."
    if _has_run(lowered):
        return "Avoid repeated characters and sequences like 'aaaa', '1234' or 'qwer'."
    return None


# --------------------------------------------------------------------------- #
# Bot check (Cloudflare Turnstile)
# --------------------------------------------------------------------------- #

TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


def turnstile_enabled() -> bool:
    return bool(os.getenv("TURNSTILE_SECRET_KEY", "").strip())


def turnstile_passed(token: str | None, ip: str | None) -> bool:
    """True when Turnstile is off, or Cloudflare confirms the token. Fails
    closed: if Cloudflare can't be reached the sign-up is refused (it can be
    retried), rather than letting scripts through."""
    secret = os.getenv("TURNSTILE_SECRET_KEY", "").strip()
    if not secret:
        return True
    if not token:
        return False
    try:
        response = httpx.post(TURNSTILE_VERIFY_URL, timeout=6.0,
                              data={"secret": secret, "response": token, **({"remoteip": ip} if ip else {})})
        return bool(response.json().get("success"))
    except Exception:  # noqa: BLE001 — any failure means "not verified"
        logger.warning("turnstile_verify_failed")
        return False


# --------------------------------------------------------------------------- #
# Admin and approval links
# --------------------------------------------------------------------------- #

def admin_emails() -> frozenset[str]:
    return frozenset(canonical_email(e) for e in os.getenv("CITELY_ADMIN_EMAILS", "").split(",") if e.strip())


def is_admin_email(email: str | None) -> bool:
    return bool(email) and canonical_email(email) in admin_emails()


APPROVAL_LINK_DAYS = 14
_APPROVAL_PURPOSE = "citely-access-approval"


def _secret() -> str:
    from APP.auth.service import _jwt_secret
    return _jwt_secret()


def approval_token(email: str) -> str:
    now = datetime.now(timezone.utc)
    claims = {"purpose": _APPROVAL_PURPOSE, "email": normalize_email(email),
              "iat": now, "exp": now + timedelta(days=APPROVAL_LINK_DAYS)}
    return jwt.encode(claims, _secret(), algorithm="HS256")


def email_from_approval_token(token: str) -> str | None:
    """The email an approval link was issued for, or None if the link is
    forged, expired or not an approval link."""
    try:
        claims = jwt.decode(token, _secret(), algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if claims.get("purpose") != _APPROVAL_PURPOSE or not claims.get("email"):
        return None
    return str(claims["email"])
