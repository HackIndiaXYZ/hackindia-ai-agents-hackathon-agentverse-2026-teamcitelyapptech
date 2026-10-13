"""Downloads the reranker weights and tokenizer files baked into the API image.

Runs in its own build stage, and this file is the ONLY input to that stage's
cache key, so dependency bumps and code edits leave the layer untouched.
Without it, FlashRank would fetch its ranker into a container directory that
does not survive scale-to-zero, on the first question after every wake.

The same goes for tiktoken's encoding files: tiktoken.get_encoding() runs at
import (APP/rag/service.py, quality_gate.py) and otherwise downloads them
from openaipublic.blob.core.windows.net on every cold start. CI's offline
image check caught it.

Embeddings no longer need weights here: bge-m3 runs on Cloudflare Workers AI
(APP/providers/embedding.py).

Also the DB-IP Lite country database (CC BY 4.0, "IP Geolocation by DB-IP"),
which the admin activity log uses to turn a visitor's address into a country
without storing the address. If it can't be downloaded the build fails with
the reason, rather than shipping an image whose country lookup silently
doesn't work.
"""

from __future__ import annotations

import os
import sys

TARGET = os.environ.get("MODEL_DIR", "/opt/models")


def main() -> int:
    flashrank_dir = os.path.join(TARGET, "flashrank")
    os.makedirs(flashrank_dir, exist_ok=True)
    from flashrank import Ranker

    print(f"↓ flashrank default ranker -> {flashrank_dir}", flush=True)
    Ranker(cache_dir=flashrank_dir)

    # TIKTOKEN_CACHE_DIR must be set before tiktoken is imported.
    tiktoken_dir = os.path.join(TARGET, "tiktoken")
    os.makedirs(tiktoken_dir, exist_ok=True)
    os.environ["TIKTOKEN_CACHE_DIR"] = tiktoken_dir
    import tiktoken

    for name in ("cl100k_base", "o200k_base"):
        print(f"↓ tiktoken {name} -> {tiktoken_dir}", flush=True)
        tiktoken.get_encoding(name)

    fetch_country_database(os.path.join(TARGET, "geo"))
    return 0


def fetch_country_database(target_dir: str) -> None:
    import gzip
    import urllib.request
    from datetime import date

    os.makedirs(target_dir, exist_ok=True)
    today = date.today()
    months = [today.replace(day=1)]
    months.append((months[0].replace(year=months[0].year - 1, month=12) if months[0].month == 1
                   else months[0].replace(month=months[0].month - 1)))
    errors = []
    for month in months:
        # This month's file appears a day or two into the month, hence the
        # fallback to last month's.
        url = f"https://download.db-ip.com/free/dbip-country-lite-{month:%Y-%m}.mmdb.gz"
        # DB-IP answers Python's default User-Agent with 403 Forbidden.
        request = urllib.request.Request(url, headers={"User-Agent": "citely-image-build/1.0 (+https://citely.example)"})
        try:
            print(f"↓ {url} -> {target_dir}", flush=True)
            with urllib.request.urlopen(request, timeout=60) as response:
                data = gzip.decompress(response.read())
            with open(os.path.join(target_dir, "dbip-country-lite.mmdb"), "wb") as out:
                out.write(data)
            return
        except Exception as exc:  # noqa: BLE001 — collected and reported below
            errors.append(f"{url}: {type(exc).__name__}: {exc}")
    raise SystemExit("Could not download the DB-IP country database:\n  " + "\n  ".join(errors))


if __name__ == "__main__":
    sys.exit(main())
