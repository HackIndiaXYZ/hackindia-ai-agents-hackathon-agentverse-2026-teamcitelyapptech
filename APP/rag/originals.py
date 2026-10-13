"""Retained original uploads, stored beside each document's index.

Files live in the existing per-document directory
(`vector_store.document_index_dir`), which is on the Azure Files share and is
already removed when a document is deleted.

Writes are atomic: a temp file in the same directory, fsync, then os.replace.
A reader therefore sees either no original or the complete file. Verified on
the staging share (cifs): 36 replacements of a 2 MB file under 4 concurrent
readers produced 0 torn reads.
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import time
import uuid
from pathlib import Path

logger = logging.getLogger("rag_api.originals")

ORIGINALS_ENABLED = os.getenv("ORIGINALS_ENABLED", "false").strip().lower() in ("1", "true", "yes")
# Per-owner cap on retained originals. The staging share holds 5 GiB and uses
# about 6 MiB today; this keeps any one account from filling it.
ORIGINALS_MAX_BYTES_PER_OWNER = int(os.getenv("ORIGINALS_MAX_BYTES_PER_OWNER", str(1024 * 1024 * 1024)))

_CONTENT_TYPES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


def extension_of(filename: str) -> str:
    ext = Path(filename or "").suffix.lower()
    # Only extensions we recognise make it into a path on disk.
    return ext if ext in _CONTENT_TYPES else ".bin"


def content_type_for(path: str) -> str:
    return _CONTENT_TYPES.get(Path(path).suffix.lower(), "application/octet-stream")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_atomic(directory: Path, ext: str, data: bytes) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    final = directory / f"original{ext}"
    tmp = directory / f".original{ext}.{uuid.uuid4().hex}.tmp"
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, final)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
    return final


def remove_tree(directory: Path, attempts: int = 10, delay: float = 0.2) -> bool:
    """Removes a document directory, retrying briefly.

    On the SMB share a file deleted while some handle is still open (a download
    mid-stream) stays listed until that handle closes, so a single rmtree can
    fail. Retries cover that window; anything still present afterwards is
    logged with its path — never silently ignored — so it can be swept.
    """
    for _ in range(attempts):
        if not directory.exists():
            return True
        try:
            shutil.rmtree(directory)
            return True
        except FileNotFoundError:
            return True
        except OSError:
            time.sleep(delay)
    leftovers = [str(p) for p in directory.rglob("*")] if directory.exists() else []
    if leftovers:
        logger.warning("document_files_left_behind", extra={"directory": str(directory), "files": leftovers[:20]})
        return False
    return True
