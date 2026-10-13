"""Website traffic for the admin console, from Cloudflare Web Analytics.

The public pages load Cloudflare's cookie-free beacon (components/WebAnalytics
in the frontend); this reads the counts back for this environment's own
address, so each environment's admin page shows its own site. Read with a
token that can only read analytics (CLOUDFLARE_ANALYTICS_TOKEN). Answers are
kept for a few minutes so the console doesn't query Cloudflare on every view.
Cloudflare's figures are estimates from a sample at low volumes.
"""

from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import structlog

logger = structlog.get_logger("rag_api.traffic")

GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql"
CACHE_SECONDS = 300
TOP = 8

_cache: dict[tuple[str, int], tuple[float, dict]] = {}
_lock = threading.Lock()


class TrafficUnavailable(Exception):
    """Cloudflare couldn't be asked or refused; the message says why."""


def site_host() -> str | None:
    """The address whose visits this environment shows: CF_ANALYTICS_HOST, or
    the host of APP_PUBLIC_URL (https://dev.citely.example/ -> dev.citely.example)."""
    explicit = os.getenv("CF_ANALYTICS_HOST", "").strip()
    if explicit:
        return explicit
    return urlparse(os.getenv("APP_PUBLIC_URL", "")).hostname or None


def configured() -> dict:
    missing = [name for name in ("CLOUDFLARE_ANALYTICS_TOKEN", "CLOUDFLARE_ACCOUNT_ID") if not os.getenv(name)]
    if not site_host():
        missing.append("APP_PUBLIC_URL")
    return {"configured": not missing, "missing": missing, "host": site_host()}


def _query(account: str, host: str, since: str) -> str:
    where = f'{{date_geq: "{since}", requestHost: "{host}", bot: 0}}'

    def group(alias: str, dimension: str, order: str, limit: int, visits: bool = True) -> str:
        sums = " sum { visits }" if visits else ""
        return (f"{alias}: rumPageloadEventsAdaptiveGroups(limit: {limit}, filter: {where}, orderBy: [{order}])"
                f" {{ count{sums} dimensions {{ {dimension} }} }}")

    parts = [
        group("daily", "date", "date_ASC", 100),
        group("pages", "requestPath", "count_DESC", TOP),
        group("countries", "countryName", "count_DESC", TOP),
        group("referrers", "refererHost", "count_DESC", TOP),
        group("devices", "deviceType", "count_DESC", TOP),
        group("browsers", "userAgentBrowser", "count_DESC", TOP),
    ]
    return f'{{ viewer {{ accounts(filter: {{accountTag: "{account}"}}) {{ {" ".join(parts)} }} }} }}'


def _ask(query: str, token: str) -> dict:
    import httpx
    try:
        response = httpx.post(GRAPHQL_URL, json={"query": query}, timeout=20,
                              headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError as exc:
        raise TrafficUnavailable(f"Couldn't reach Cloudflare: {type(exc).__name__}") from exc
    try:
        body = response.json()
    except ValueError as exc:
        raise TrafficUnavailable(f"Cloudflare answered HTTP {response.status_code} without data") from exc
    errors = body.get("errors") or []
    if response.status_code != 200 or errors:
        message = "; ".join(e.get("message", "") for e in errors if isinstance(e, dict)) or f"HTTP {response.status_code}"
        raise TrafficUnavailable(f"Cloudflare refused the analytics query: {message[:300]}")
    accounts = ((body.get("data") or {}).get("viewer") or {}).get("accounts") or []
    if not accounts:
        raise TrafficUnavailable("Cloudflare returned no account for CLOUDFLARE_ACCOUNT_ID (check the token's account access)")
    return accounts[0]


def _rows(groups: list, dimension: str, label=lambda v: v) -> list[dict]:
    total = sum(g.get("count", 0) for g in groups) or 1
    return [{"name": label(g["dimensions"].get(dimension)), "views": g.get("count", 0),
             "share": round(g.get("count", 0) / total, 4)} for g in groups]


def report(days: int = 14) -> dict:
    """Visits and page views per day, and the top pages, countries, referrers,
    devices and browsers, for this environment's site over the last `days`."""
    days = max(1, min(days, 30))
    state = configured()
    if not state["configured"]:
        return {**state, "days": days}
    host = state["host"]
    now = time.monotonic()
    with _lock:
        cached = _cache.get((host, days))
        if cached and now - cached[0] < CACHE_SECONDS:
            return cached[1]
    today = datetime.now(timezone.utc).date()
    since = today - timedelta(days=days - 1)
    data = _ask(_query(os.environ["CLOUDFLARE_ACCOUNT_ID"], host, since.isoformat()), os.environ["CLOUDFLARE_ANALYTICS_TOKEN"])
    by_day = {g["dimensions"]["date"]: g for g in data.get("daily") or []}
    series = []
    for i in range(days):
        day = (since + timedelta(days=i)).isoformat()
        g = by_day.get(day) or {}
        series.append({"day": day, "views": g.get("count", 0), "visits": (g.get("sum") or {}).get("visits", 0)})
    out = {
        **state,
        "days": days,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "totals": {"views": sum(d["views"] for d in series), "visits": sum(d["visits"] for d in series)},
        "per_day": series,
        "pages": _rows(data.get("pages") or [], "requestPath"),
        "countries": _rows(data.get("countries") or [], "countryName", lambda v: v or "Unknown"),
        "referrers": _rows(data.get("referrers") or [], "refererHost", lambda v: v or "Direct (typed, bookmark or app)"),
        "devices": _rows(data.get("devices") or [], "deviceType", lambda v: (v or "unknown").capitalize()),
        "browsers": _rows(data.get("browsers") or [], "userAgentBrowser", lambda v: v or "Unknown"),
    }
    with _lock:
        _cache[(host, days)] = (now, out)
    return out
