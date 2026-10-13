"""Is an email domain a temporary / disposable inbox?

Temp-mail sites hand out brand-new domains every few days, so a list of
domains alone always falls behind. Two layers, both checked before any code
is emailed:

1. The domain list (APP/auth/lists/disposable_domains.txt, refreshed weekly
   from public lists by scripts/refresh_disposable_lists.py). A subdomain
   matches its parent.
2. The mail servers: the domain's MX records (or its address, the RFC 5321
   fallback) are resolved, and a domain whose mail goes to a server that
   belongs to a temp-mail service (APP/auth/lists/disposable_mx.txt, built
   from evidence by scripts/disposable_mx_survey.py) is refused even when the
   domain is on no list. A new domain still has to point at a working inbox,
   and these services run few of them.

Real people are never locked out by this:
- APP/auth/lists/disposable_allowlist.txt (mainstream providers) beats any
  list entry except a more specific one, and skips the mail-server check;
- shared providers that real organisations use (SHARED_MAIL_PROVIDERS) are
  never treated as disposable infrastructure, whatever the data file says;
- DNS answers are cached in-process, every lookup is time-bounded, and
  resolver trouble counts as "fine" (logged), never as a refusal.
"""

from __future__ import annotations

import ipaddress
import logging
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import dns.exception
import dns.resolver

logger = logging.getLogger("rag_api.access")

_DATA = Path(__file__).resolve().parent / "auth" / "lists"

# Mail hosts real organisations use (directly, or to forward mail). Many
# disposable domains point at them too, but a refusal there would hit real
# companies, so only the domain list can catch those.
SHARED_MAIL_PROVIDERS = frozenset({
    # Google Workspace / Gmail, Microsoft 365 / Outlook
    "google.com", "googlemail.com", "gmail.com", "outlook.com", "hotmail.com", "microsoft.com", "office365.us",
    # Mailbox providers
    "zoho.com", "zoho.eu", "zoho.in", "zohomail.com", "yandex.net", "yandex.ru", "protonmail.ch", "proton.me",
    "messagingengine.com", "fastmail.com", "icloud.com", "me.com", "apple.com", "mail.ru", "gmx.net", "web.de",
    "yahoodns.net", "yahoo.com", "aol.com", "mailbox.org", "posteo.de", "tutanota.de", "tuta.io", "hey.com",
    "purelymail.com", "migadu.com", "infomaniak.ch", "titan.email", "larksuite.com", "qq.com", "163.com",
    # Registrars and hosting (mailboxes and forwarding)
    "privateemail.com", "registrar-servers.com", "web-hosting.com", "jellyfish.systems", "secureserver.net",
    "hostinger.com", "hostinger.in", "ionos.com", "ionos.de", "ionos.co.uk", "kundenserver.de", "perfora.net",
    "1and1.com", "ovh.net", "gandi.net", "emailsrvr.com", "rzone.de", "strato.de", "timeweb.ru", "beget.com",
    "spaceship.net", "regery.net", "porkbun.com", "name.com", "dynadot.com", "hover.com", "namebright.com",
    "mxrouting.net", "dreamhost.com", "bluehost.com", "hostgator.com", "websitewelcome.com", "siteground.net",
    "a2hosting.com", "inmotionhosting.com", "kasserver.com", "one.com", "above.com", "sedoparking.com",
    "domaincontrol.com", "netsol.com", "register.com", "hostpapa.com", "mailspamprotection.com",
    # Forwarding, routing and inbound services
    "improvmx.com", "forwardemail.net", "cloudflare.net", "mailgun.org", "amazonaws.com", "sendgrid.net",
    "mailchannels.net", "mimecast.com", "pphosted.com", "barracudanetworks.com", "messagelabs.com",
    "mailcontrol.com", "trendmicro.com", "sophos.com", "fireeye.com", "iphmx.com", "spamexperts.com",
})

_TTL = 3600.0              # a DNS answer is reused for an hour
_ERROR_TTL = 60.0          # resolver trouble is retried after a minute
_QUERY_TIMEOUT = 2.0       # one DNS query
_BUDGET = 4.0              # the whole lookup of a domain (MX + addresses)
_MAX_HOSTS = 6
_CACHE_MAX = 20_000


# --------------------------------------------------------------------------- #
# Lists
# --------------------------------------------------------------------------- #

def _names(filename: str) -> frozenset[str]:
    # A missing list would silently let everything through, so fail loudly.
    lines = (_DATA / filename).read_text(encoding="utf-8").splitlines()
    return frozenset(n for n in (line.split("#", 1)[0].strip().lower() for line in lines) if n)


@lru_cache(maxsize=1)
def _listed() -> frozenset[str]:
    return _names("disposable_domains.txt")


@lru_cache(maxsize=1)
def _allowed() -> frozenset[str]:
    return _names("disposable_allowlist.txt")


def _shared(host: str) -> bool:
    return _longest_suffix(host, SHARED_MAIL_PROVIDERS) is not None


@lru_cache(maxsize=1)
def _infrastructure() -> tuple[frozenset[str], tuple]:
    """(mail host names, address networks) of temp-mail services."""
    names, networks = set(), []
    for entry in _names("disposable_mx.txt"):
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
            continue
        except ValueError:
            pass
        if _shared(entry):   # a slip in the data file must never block Gmail or Outlook users
            logger.warning("disposable_mx_entry_ignored", extra={"entry": entry, "reason": "shared provider"})
            continue
        names.add(entry)
    return frozenset(names), tuple(networks)


def _longest_suffix(domain: str, names: frozenset[str]) -> str | None:
    """The most specific entry of `names` that is the domain or a parent of it."""
    labels = domain.lower().rstrip(".").split(".")
    for i in range(len(labels)):
        candidate = ".".join(labels[i:])
        if candidate in names:
            return candidate
    return None


def allowlisted(domain: str) -> bool:
    """A mainstream provider (or a subdomain of one), unless a more specific
    entry of the disposable list says otherwise."""
    allow = _longest_suffix(domain, _allowed())
    block = _longest_suffix(domain, _listed())
    return allow is not None and (block is None or len(allow) >= len(block))


def listed(domain: str) -> bool:
    """On the disposable list (the domain or a parent), and not allowlisted."""
    return _longest_suffix(domain, _listed()) is not None and not allowlisted(domain)


# --------------------------------------------------------------------------- #
# DNS (cached, time-bounded)
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class MailServers:
    """status: "ok" (has mail servers), "nomail" (none, or a null MX),
    "nxdomain" (no such domain), "error" (resolver trouble: unknown)."""
    status: str
    hosts: tuple[tuple[str, tuple[str, ...]], ...] = ()   # (host, its IPv4 addresses)


_cache: dict[str, tuple[float, MailServers]] = {}
_cache_lock = threading.Lock()
_resolver: dns.resolver.Resolver | None = None


def _resolve(name: str, record: str, timeout: float):
    """One DNS query (the seam tests replace)."""
    global _resolver
    if _resolver is None:
        _resolver = dns.resolver.Resolver()
    return _resolver.resolve(name, record, lifetime=timeout)


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _lookup(domain: str) -> MailServers:
    deadline = time.monotonic() + _BUDGET

    def query(name: str, record: str):
        left = deadline - time.monotonic()
        if left <= 0:
            raise dns.exception.Timeout()
        return _resolve(name, record, min(_QUERY_TIMEOUT, left))

    try:
        answers = query(domain, "MX")
        ranked = sorted(answers, key=lambda a: a.preference)
        hosts = list(dict.fromkeys(str(a.exchange).rstrip(".").lower() for a in ranked))
        # A "null MX" (RFC 7505: a single "." exchange) is the domain saying
        # outright that it accepts no mail.
        hosts = [h for h in hosts if h][:_MAX_HOSTS]
        if not hosts:
            return MailServers("nomail")
        found = []
        for host in hosts:
            try:
                found.append((host, tuple(sorted(str(a) for a in query(host, "A")))))
            except dns.exception.DNSException:
                found.append((host, ()))   # an unresolvable server name is still checked by name
        return MailServers("ok", tuple(found))
    except dns.resolver.NXDOMAIN:
        return MailServers("nxdomain")
    except (dns.resolver.NoAnswer, dns.resolver.NoNameservers):
        pass
    except dns.exception.DNSException as exc:
        logger.warning("email_domain_lookup_failed", extra={"domain": domain, "record": "MX", "error": type(exc).__name__})
        return MailServers("error")
    # No MX: mail goes to the domain's own address (RFC 5321 fallback).
    for record in ("A", "AAAA"):
        try:
            answers = query(domain, record)
            return MailServers("ok", ((domain, tuple(sorted(str(a) for a in answers)) if record == "A" else ()),))
        except dns.resolver.NXDOMAIN:
            return MailServers("nxdomain")
        except (dns.resolver.NoAnswer, dns.resolver.NoNameservers):
            continue
        except dns.exception.DNSException as exc:
            logger.warning("email_domain_lookup_failed", extra={"domain": domain, "record": record, "error": type(exc).__name__})
            return MailServers("error")
    return MailServers("nomail")


def mail_servers(domain: str) -> MailServers:
    """The domain's mail servers, from the cache when fresh. Never raises for
    DNS trouble (that is status "error")."""
    domain = domain.lower().rstrip(".")
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(domain)
    if hit and hit[0] > now:
        return hit[1]
    result = _lookup(domain)
    with _cache_lock:
        if len(_cache) >= _CACHE_MAX:
            for key in [k for k, (expires, _) in _cache.items() if expires <= now] or list(_cache)[:_CACHE_MAX // 10]:
                _cache.pop(key, None)
        _cache[domain] = (now + (_ERROR_TTL if result.status == "error" else _TTL), result)
    return result


def receives_mail(domain: str) -> bool:
    """Whether the domain publishes a mail server. Resolver trouble counts as
    yes: a flaky resolver must not lock out real people (the verification
    code still has to arrive)."""
    return mail_servers(domain).status in ("ok", "error")


# --------------------------------------------------------------------------- #
# Verdict
# --------------------------------------------------------------------------- #

def infrastructure_match(domain: str) -> str | None:
    """The temp-mail mail server (host name or address) the domain's mail goes
    to, or None. Allowlisted domains, shared providers and unknown DNS answers
    never match."""
    if allowlisted(domain):
        return None
    names, networks = _infrastructure()
    for host, addresses in mail_servers(domain).hosts:
        if _shared(host):
            continue
        if _longest_suffix(host, names):
            return host
        for address in addresses:
            ip = ipaddress.ip_address(address)
            if any(ip in network for network in networks):
                return address
    return None


def disposable_reason(domain: str) -> str | None:
    """"list" or "mail-servers" when the domain is a temporary inbox, else None."""
    if listed(domain):
        return "list"
    match = infrastructure_match(domain)
    if match:
        logger.info("email_domain_disposable_infrastructure", extra={"domain": domain, "server": match})
        return "mail-servers"
    return None
