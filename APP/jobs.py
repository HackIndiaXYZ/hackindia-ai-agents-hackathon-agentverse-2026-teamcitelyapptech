"""In-process job store for long-running ingests.

Why this exists: a 44-page PDF ingests in ~93s and a 180-page one takes
several minutes, while Azure Container Apps' ingress cuts requests at ~240s by
default. Phase 3's parser router adds per-file OCR round-trips on top, so the
synchronous path only gets slower. Returning a job id immediately decouples
ingest duration from any HTTP timeout.

Deliberately in-memory, not SQLite: jobs are ephemeral progress state, worth
nothing after a restart, and the app already runs at maxReplicas 1 so there's
no second process to share them with. If replicas ever go above 1, this must
move into the database — a job created on one replica is invisible to another.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

# Terminal states are the ones a client can stop polling on.
QUEUED = "queued"
RUNNING = "running"
SUCCEEDED = "succeeded"
FAILED = "failed"
TERMINAL = {SUCCEEDED, FAILED}

# Keep finished jobs around long enough for a client to read the result, then
# drop them so a long-lived process doesn't accumulate them forever.
RETENTION_SECONDS = 3600
MAX_JOBS = 500


@dataclass
class Job:
    id: str
    owner_id: str
    filename: str
    # The client's own id for this upload, so a retried request (the first one
    # timed out, but may have arrived) finds this job instead of ingesting twice.
    client_key: str | None = None
    status: str = QUEUED
    result: dict[str, Any] | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.id,
            "status": self.status,
            "filename": self.filename,
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._by_key: dict[tuple[str, str], str] = {}
        self._lock = threading.Lock()

    def create(self, owner_id: str, filename: str) -> Job:
        return self.create_once(owner_id, filename, None)[0]

    def create_once(self, owner_id: str, filename: str, client_key: str | None) -> tuple[Job, bool]:
        """Returns (job, created). With a client_key already seen for this owner,
        returns that job instead — unless it failed, in which case a retry is a
        genuine new attempt."""
        with self._lock:
            if client_key:
                existing = self._jobs.get(self._by_key.get((owner_id, client_key), ""))
                if existing is not None and existing.status != FAILED:
                    return existing, False
            job = Job(id=str(uuid4()), owner_id=owner_id, filename=filename, client_key=client_key)
            self._jobs[job.id] = job
            if client_key:
                self._by_key[(owner_id, client_key)] = job.id
            self._evict_locked()
        return job, True

    def get(self, job_id: str, owner_id: str) -> Job | None:
        """Owner-scoped on purpose: a job id must not be a capability that
        leaks another user's filenames or ingest results.
        """
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.owner_id != owner_id:
                return None
            return job

    def mark(self, job_id: str, status: str, *, result: dict | None = None, error: str | None = None) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.status = status
            job.updated_at = time.time()
            if result is not None:
                job.result = result
            if error is not None:
                job.error = error

    def _evict_locked(self) -> None:
        now = time.time()
        stale = [
            jid for jid, j in self._jobs.items()
            if j.status in TERMINAL and (now - j.updated_at) > RETENTION_SECONDS
        ]
        for jid in stale:
            self._forget_locked(jid)

        # Hard cap as a backstop if retention alone isn't keeping up: drop the
        # oldest terminal jobs first, never anything still in flight.
        if len(self._jobs) > MAX_JOBS:
            finished = sorted(
                (j for j in self._jobs.values() if j.status in TERMINAL),
                key=lambda j: j.updated_at,
            )
            for job in finished[: len(self._jobs) - MAX_JOBS]:
                self._forget_locked(job.id)

    def _forget_locked(self, job_id: str) -> None:
        job = self._jobs.pop(job_id, None)
        if job is not None and job.client_key and self._by_key.get((job.owner_id, job.client_key)) == job_id:
            del self._by_key[(job.owner_id, job.client_key)]


job_store = JobStore()
