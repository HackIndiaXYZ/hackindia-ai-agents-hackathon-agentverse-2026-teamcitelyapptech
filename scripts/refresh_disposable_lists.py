"""Refresh APP/auth/lists/disposable_domains.txt from the maintained public lists.

Run weekly by .github/workflows/refresh-disposable-lists.yml (which opens a
pull request with the result), or by hand:

    python scripts/refresh_disposable_lists.py            # rewrite the snapshot
    python scripts/refresh_disposable_lists.py --check    # only report, exit 1 if it would change

Two kinds of source. disposable-email-domains and 7c/fakefilter are curated
(every entry checked by hand or by watching the temp-mail sites) and are
taken whole. The previous snapshot, burner-email-providers, mailchecker and
ivolo are large but looser: they also carry real sites (example.com,
craigslist.org, nus.edu.sg, asics.com were found in them), so their entries
are kept only when the domain is not among the million most popular sites
(the Tranco list); the popular temp-mail sites are in the curated lists anyway.
Our allowlist (APP/auth/lists/disposable_allowlist.txt) then removes the
mainstream providers outright. Anything the refresh would remove is printed
so the pull request shows it.

If any source can't be fetched or looks truncated, nothing is written and the
script fails, so a broken download can never shrink or corrupt the list.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import zipfile
from datetime import date
from pathlib import Path

import httpx

LISTS = Path(__file__).resolve().parent.parent / "APP" / "auth" / "lists"
SNAPSHOT = LISTS / "disposable_domains.txt"
ALLOWLIST = LISTS / "disposable_allowlist.txt"

# name, URL, licence, format, the fewest entries a healthy download has, curated?
SOURCES = [
    ("disposable-email-domains", "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf", "CC0-1.0", "lines", 3000, True),
    ("7c/fakefilter", "https://raw.githubusercontent.com/7c/fakefilter/main/txt/data.txt", "BSD-3-Clause", "lines", 3000, True),
    ("wesbos/burner-email-providers", "https://raw.githubusercontent.com/wesbos/burner-email-providers/master/emails.txt", "MIT", "lines", 10000, False),
    ("FGRibreau/mailchecker", "https://raw.githubusercontent.com/FGRibreau/mailchecker/master/list.txt", "MIT", "lines", 20000, False),
    ("ivolo/disposable-email-domains", "https://raw.githubusercontent.com/ivolo/disposable-email-domains/master/index.json", "MIT", "json", 50000, False),
    ("ivolo/disposable-email-domains (wildcard)", "https://raw.githubusercontent.com/ivolo/disposable-email-domains/master/wildcard.json", "MIT", "json", 100, False),
]

# The million most popular sites (https://tranco-list.eu, free to use); only
# used as a filter, never redistributed.
TRANCO = "https://tranco-list.eu/top-1m.csv.zip"

_DOMAIN = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$")


def parse(text: str, fmt: str) -> set[str]:
    items = json.loads(text) if fmt == "json" else [l.split("#", 1)[0] for l in text.splitlines()]
    out = set()
    for item in items:
        d = item.strip().lower().rstrip(".")
        try:
            d = d.encode("idna").decode("ascii") if not d.isascii() else d
        except UnicodeError:
            continue
        if _DOMAIN.fullmatch(d):
            out.add(d)
    return out


def read_names(path: Path) -> set[str]:
    return {l.strip().lower() for l in path.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")}


def popular_sites(client: httpx.Client) -> set[str]:
    response = client.get(TRANCO)
    response.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        rows = archive.read(archive.namelist()[0]).decode("utf-8").splitlines()
    sites = {row.split(",", 1)[1].strip().lower() for row in rows if "," in row}
    if len(sites) < 900_000:
        raise SystemExit(f"Tranco list: only {len(sites)} sites; not writing anything")
    return sites


def build(client: httpx.Client) -> tuple[list[str], list[str]]:
    curated, loose = set(), read_names(SNAPSHOT)
    notes = []
    for name, url, licence, fmt, minimum, is_curated in SOURCES:
        response = client.get(url)
        response.raise_for_status()
        found = parse(response.text, fmt)
        if len(found) < minimum:
            raise SystemExit(f"{name}: only {len(found)} domains (expected at least {minimum}); not writing anything")
        notes.append(f"{name} ({licence}{', curated' if is_curated else ''}): {len(found)}")
        (curated if is_curated else loose).update(found)
    popular = popular_sites(client)
    domains = curated | {d for d in loose if d not in popular}
    return sorted(domains - read_names(ALLOWLIST)), notes


def render(domains: list[str], notes: list[str]) -> str:
    header = [
        f"# Disposable email domains, refreshed {date.today().isoformat()} by scripts/refresh_disposable_lists.py.",
        "# The curated lists whole, plus the previous snapshot and the looser lists minus the",
        "# million most popular sites (Tranco), minus disposable_allowlist.txt. Licences in",
        "# THIRD_PARTY_NOTICES.txt; entry counts per source:",
        *[f"#   {n}" for n in notes],
        "# A subdomain matches its parent.",
    ]
    return "\n".join(header + domains) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="report only; exit 1 if the snapshot would change")
    args = ap.parse_args()
    with httpx.Client(timeout=60, follow_redirects=True) as client:
        domains, notes = build(client)
    before = read_names(SNAPSHOT)
    added, removed = set(domains) - before, before - set(domains)
    print(f"{len(domains)} domains ({len(added)} added, {len(removed)} removed)")
    for d in sorted(removed)[:50]:
        print(f"  removed: {d}")
    if args.check:
        sys.exit(1 if added or removed else 0)
    if added or removed:   # unchanged lists leave the file (and its date) alone: no empty weekly PR
        SNAPSHOT.write_text(render(domains, notes), encoding="utf-8")


if __name__ == "__main__":
    main()
