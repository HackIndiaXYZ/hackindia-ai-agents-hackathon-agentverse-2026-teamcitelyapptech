"""Which email addresses may sign up, and how.

- Temporary / disposable addresses are refused everywhere an account or a
  demo request starts (no code is sent, nothing is stored): by the domain
  list, and by the domain's mail servers when they belong to a temp-mail
  service (APP/disposable.py), so brand-new temp domains are caught too.
- Personal addresses (Gmail, Outlook, Yahoo, iCloud, ...) sign up with Google
  or GitHub; email + password sign-up is for work addresses. Accounts that
  already exist keep signing in as before.
- Work accounts with a password can't reset it themselves: the admin sends
  them a reset link from the admin console.

Domain lists: APP/auth/lists (disposable_domains.txt, disposable_allowlist.txt,
disposable_mx.txt, personal_domains.txt; sources noted at the top of each).
A subdomain matches its parent.
"""

from __future__ import annotations

from functools import lru_cache

from APP import access_control as ac
from APP import disposable

DISPOSABLE_MESSAGE = ac.DISPOSABLE_MESSAGE
PERSONAL_PASSWORD_MESSAGE = ("Personal email addresses (like Gmail or Outlook) sign up with Google or GitHub. "
                             "To sign up with a password, use your work email.")
WORK_RESET_MESSAGE = ("Passwords for work accounts are reset by the Citely administrator. "
                      "Ask them to send you a reset link.")


@lru_cache(maxsize=1)
def _personal_domains() -> frozenset[str]:
    # A missing list would silently let everything through, so fail loudly.
    lines = (ac._DATA / "personal_domains.txt").read_text(encoding="utf-8").splitlines()
    return frozenset(line.strip().lower() for line in lines if line.strip() and not line.startswith("#"))


def domain_of(email: str) -> str:
    return email.rsplit("@", 1)[-1].strip().lower().rstrip(".") if "@" in email else ""


def is_disposable(email: str) -> bool:
    """On the disposable domain list (no DNS; cheap enough for every request)."""
    return ac.is_disposable(domain_of(email))


def is_temporary(email: str) -> bool:
    """The full check for a new account: the list, then the domain's mail
    servers (cached, time-bounded DNS that fails open)."""
    domain = domain_of(email)
    return bool(domain) and disposable.disposable_reason(domain) is not None


def is_personal(email: str) -> bool:
    """A free personal mailbox provider (not disposable, not a work domain)."""
    parts = domain_of(email).split(".")
    names = _personal_domains()
    return any(".".join(parts[i:]) in names for i in range(len(parts) - 1)) and not is_disposable(email)


def is_work(email: str) -> bool:
    return bool(domain_of(email)) and not is_personal(email) and not is_disposable(email)
