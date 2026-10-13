"""Live proof of the temporary-email check against today's internet (not part
of the test suite: it needs the network and its answers change daily).

Fetches the domains several temp-mail services are handing out right now,
runs each through the same check sign-up uses (APP.access_control.
check_signup_email, real DNS), and shows which layer refused it: the domain
list, or the mail servers (APP/disposable.py). Also checks that mainstream
and real company addresses pass. Exit code 1 if any temp domain gets through
or any real one is refused.

    python scripts/check_disposable_live.py            # full check
    python scripts/check_disposable_live.py --mx-only  # also show what the mail-server layer catches on its own
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from APP import access_control as ac  # noqa: E402
from APP import disposable  # noqa: E402

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"}

# Must pass: mainstream mailboxes, Google Workspace (airbnb.com, uber.com),
# Microsoft 365 (microsoft.com, wipro.com), Proofpoint (accenture.com).
REAL = ["gmail.com", "outlook.com", "hotmail.com", "yahoo.co.in", "zoho.com", "icloud.com", "proton.me",
        "airbnb.com", "uber.com", "microsoft.com", "wipro.com", "accenture.com", "solarion.ai"]


def _json(client, url, pick):
    return pick(client.get(url).raise_for_status().json())


def _page(client, url, pattern):
    return re.findall(pattern, client.get(url).raise_for_status().text)


# service -> how to get the domains it offers today
SOURCES = {
    "mail.tm": lambda c: _json(c, "https://api.mail.tm/domains", lambda j: [d["domain"] for d in j["hydra:member"]]),
    "mail.gw": lambda c: _json(c, "https://api.mail.gw/domains", lambda j: [d["domain"] for d in j["hydra:member"]]),
    "temp-mail.io": lambda c: _json(c, "https://api.internal.temp-mail.io/api/v3/domains", lambda j: [d["name"] for d in j["domains"]]),
    "guerrillamail": lambda c: _page(c, "https://www.guerrillamail.com/", r'<option value="([a-z0-9.-]+\.[a-z]{2,})"'),
    "tempmail.plus": lambda c: _page(c, "https://tempmail.plus/en/", r'class="dropdown-item">([a-z0-9.-]+\.[a-z]{2,})<'),
    "yopmail": lambda c: _page(c, "https://yopmail.com/en/domain?d=list", r"<option>@([^<]+)</option>")[:15],
    "mohmal": lambda c: _page(c, "https://www.mohmal.com/en", r'<option value="([a-z0-9.-]+\.[a-z]{2,})"'),
    "moakt": lambda c: _page(c, "https://www.moakt.com/", r'value="([a-z0-9.-]+\.[a-z]{2,})"'),
    "fakemailgenerator": lambda c: _page(c, "https://www.fakemailgenerator.com/", r'value="@?([a-z0-9-]+\.[a-z]{2,})"'),
    "generator.email": lambda c: _page(c, "https://generator.email/", r'@([a-z0-9-]+\.[a-z]{2,})')[:3],
    "emailfake.com": lambda c: _page(c, "https://emailfake.com/", r'@([a-z0-9-]+\.[a-z]{2,})')[:3],
    "10minutemail.net": lambda c: _page(c, "https://10minutemail.net/", r'@([a-z0-9-]+\.[a-z]{2,})')[:3],
    "tempmail.so": lambda c: _page(c, "https://tempmail.so/", r'@([a-z0-9-]+\.[a-z]{2,})')[:3],
    # Sites that block scripted visits: their long-standing domains instead.
    "mailinator / maildrop / temp-mail.org": lambda c: ["mailinator.com", "maildrop.cc", "temp-mail.org"],
}
_NOT_DOMAINS = re.compile(r"\.(png|jpe?g|gif|svg|webp|css|js|html?|php)$")


def verdict(domain: str) -> str:
    try:
        ac.check_signup_email(f"probe@{domain}")
        return "passes"
    except ac.EmailRejected as exc:
        if exc.reason == "disposable":
            return "refused: list" if disposable.listed(domain) else "refused: mail servers"
        return f"refused: {exc.reason}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--mx-only", action="store_true", help="also report the mail-server layer on its own, list ignored")
    args = ap.parse_args()
    failures, tested, mx_caught, mx_known = [], 0, 0, 0
    with httpx.Client(headers=UA, timeout=15, follow_redirects=True) as client:
        for service, fetch in SOURCES.items():
            try:
                domains = sorted({d.lower() for d in fetch(client) if not _NOT_DOMAINS.search(d.lower())} - {"gmail.com", "outlook.com", "example.com"})
            except Exception as exc:  # noqa: BLE001 — a site being down is reported, not fatal
                print(f"\n{service}: could not fetch today's domains ({type(exc).__name__}: {exc})")
                continue
            print(f"\n{service}: {len(domains)} domains")
            for domain in domains:
                result = verdict(domain)
                tested += 1
                line = f"  {domain:32s} {result}"
                if args.mx_only:
                    servers = disposable.mail_servers(domain)
                    if servers.status == "ok":
                        mx_known += 1
                        match = disposable.infrastructure_match(domain) if not disposable.allowlisted(domain) else None
                        mx_caught += bool(match)
                        line += f"   [mail servers alone: {'refused via ' + match if match else 'not caught'}]"
                print(line)
                if result == "passes":
                    failures.append(f"temp domain got through: {domain} ({service})")
    print("\nReal addresses (must pass):")
    for domain in REAL:
        result = verdict(domain)
        print(f"  {domain:32s} {result}")
        if result != "passes":
            failures.append(f"real domain refused: {domain} ({result})")
    print(f"\n{tested} temp domains tested; {len(REAL)} real domains tested.")
    if args.mx_only:
        print(f"Mail-server layer alone refused {mx_caught} of the {mx_known} temp domains that have working mail servers.")
    for failure in failures:
        print("FAIL:", failure)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
