"""Survey the mail servers behind disposable domains (not part of the test suite).

How APP/auth/lists/disposable_mx.txt was built, and how to rebuild it: resolve
the MX records (A as the RFC 5321 fallback) of many known disposable domains,
resolve those mail servers to addresses, and count how many disposable domains
each mail host, mail-host parent domain, address and /24 serves. A host that
serves dozens of throwaway domains is a temp-mail service's own
infrastructure, so a brand-new domain pointed at it is refused too.

The counts are evidence, not the list: a person still reviews the top of the
report and leaves out shared providers that real organisations use (the
app's own guard, APP/disposable.py SHARED_MAIL_PROVIDERS, refuses them anyway).

    python scripts/disposable_mx_survey.py DOMAIN_FILE [DOMAIN_FILE ...] \
        [--sample 20000] [--workers 128] [--timeout 3] [--out survey.jsonl] [--top 80]

DOMAIN_FILE: one domain per line ("#" comments allowed), a JSON array, or
7c/fakefilter's txt (whose "## provider" headings are kept as the group).
"""

from __future__ import annotations

import argparse
import collections
import ipaddress
import json
import random
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import dns.exception
import dns.resolver
import dns.reversename


def read_domains(path: Path) -> dict[str, str]:
    """domain -> group (the provider heading in fakefilter's file, else the file name)."""
    text = path.read_text(encoding="utf-8", errors="ignore")
    if text.lstrip().startswith("["):
        return {d.strip().lower(): path.stem for d in json.loads(text) if d.strip()}
    out, group = {}, path.stem
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("## "):
            group = line[3:].strip()
        elif line and not line.startswith("#"):
            out[line.lower()] = group
    return out


def make_resolver(timeout: float) -> dns.resolver.Resolver:
    resolver = dns.resolver.Resolver()
    resolver.lifetime = timeout
    resolver.timeout = timeout
    return resolver


def mail_hosts(resolver, domain: str) -> tuple[str, list[str]]:
    """("mx", hosts) | ("a", [domain]) | ("nxdomain"|"none"|"nullmx"|"error", [])."""
    try:
        answers = resolver.resolve(domain, "MX")
        hosts = sorted({str(a.exchange).rstrip(".").lower() for a in answers} - {""})
        return ("mx", hosts) if hosts else ("nullmx", [])
    except dns.resolver.NXDOMAIN:
        return "nxdomain", []
    except (dns.resolver.NoAnswer, dns.resolver.NoNameservers):
        pass
    except dns.exception.DNSException:
        return "error", []
    try:
        resolver.resolve(domain, "A")
        return "a", [domain]
    except dns.resolver.NXDOMAIN:
        return "nxdomain", []
    except dns.exception.DNSException:
        return "none", []


def addresses(resolver, host: str) -> list[str]:
    try:
        return sorted(str(a) for a in resolver.resolve(host, "A"))
    except dns.exception.DNSException:
        return []


def ptr(resolver, ip: str) -> str:
    try:
        return str(resolver.resolve(dns.reversename.from_address(ip), "PTR")[0]).rstrip(".").lower()
    except dns.exception.DNSException:
        return ""


_TWO_LEVEL = {"co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go"}


def parent(host: str) -> str:
    """Rough registrable domain of a host name (mx1.mail.ru -> mail.ru, a.b.co.uk -> b.co.uk)."""
    labels = host.split(".")
    keep = 3 if len(labels) >= 3 and labels[-2] in _TWO_LEVEL and len(labels[-1]) == 2 else 2
    return ".".join(labels[-keep:])


def survey(domains: dict[str, str], workers: int, timeout: float) -> list[dict]:
    resolver = make_resolver(timeout)
    names = list(domains)
    with ThreadPoolExecutor(workers) as pool:
        found = dict(zip(names, pool.map(lambda d: mail_hosts(resolver, d), names)))
        hosts = sorted({h for _, hs in found.values() for h in hs})
        ips = dict(zip(hosts, pool.map(lambda h: addresses(resolver, h), hosts)))
    return [{"domain": d, "group": domains[d], "status": s, "mx": hs, "ips": sorted({ip for h in hs for ip in ips.get(h, [])})}
            for d, (s, hs) in found.items()]


def report(rows: list[dict], top: int, timeout: float) -> None:
    by = {k: collections.defaultdict(set) for k in ("host", "parent", "ip", "net")}
    for row in rows:
        for h in row["mx"]:
            by["host"][h].add(row["domain"])
            by["parent"][parent(h)].add(row["domain"])
        for ip in row["ips"]:
            by["ip"][ip].add(row["domain"])
            by["net"][str(ipaddress.ip_network(ip + "/24", strict=False))].add(row["domain"])
    statuses = collections.Counter(r["status"] for r in rows)
    print(f"# {len(rows)} domains surveyed: {dict(statuses)}")
    resolver = make_resolver(timeout)
    for kind, table in by.items():
        print(f"\n## Top mail {kind}s by disposable domains served")
        for key, served in sorted(table.items(), key=lambda kv: -len(kv[1]))[:top]:
            extra = f"  ptr={ptr(resolver, key)}" if kind == "ip" else ""
            print(f"{len(served):6d}  {key}{extra}  e.g. {', '.join(sorted(served)[:3])}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--sample", type=int, default=0, help="survey a random sample of this many domains (0 = all)")
    ap.add_argument("--workers", type=int, default=128)
    ap.add_argument("--timeout", type=float, default=3.0)
    ap.add_argument("--out", type=Path, help="write one JSON line per domain here")
    ap.add_argument("--top", type=int, default=80)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    domains: dict[str, str] = {}
    for f in args.files:
        domains.update({d: g for d, g in read_domains(f).items() if d not in domains})
    if args.sample and args.sample < len(domains):
        random.seed(args.seed)
        domains = {d: domains[d] for d in random.sample(sorted(domains), args.sample)}
    print(f"Surveying {len(domains)} domains with {args.workers} workers…", file=sys.stderr)
    rows = survey(domains, args.workers, args.timeout)
    if args.out:
        args.out.write_text("".join(json.dumps(r) + "\n" for r in rows))
    report(rows, args.top, args.timeout)


if __name__ == "__main__":
    main()
