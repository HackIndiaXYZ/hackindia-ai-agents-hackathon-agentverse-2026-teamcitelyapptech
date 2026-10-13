"""Durable evidence, jobs and a conservative micro-USD spending ledger.

Source locations and extraction outputs never mutate. Publication revision is
independent of the page extraction version used by existing citations.
"""
from __future__ import annotations
import hashlib
import json
import time
from datetime import datetime, timezone
from uuid import uuid4, uuid5, NAMESPACE_URL
from APP import db

SCHEMA = """
CREATE TABLE IF NOT EXISTS evidence_files (
 document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL, file_version TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 total_pages INTEGER NOT NULL, created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence_regions (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES evidence_files(document_id) ON DELETE CASCADE,
 location TEXT NOT NULL, asset_hash TEXT, asset_path TEXT, state TEXT NOT NULL,
 error TEXT, mode TEXT NOT NULL DEFAULT 'read', created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence_records (
 id TEXT PRIMARY KEY, region_id TEXT NOT NULL REFERENCES evidence_regions(id) ON DELETE CASCADE,
 provenance TEXT NOT NULL, content_type TEXT NOT NULL, extractor TEXT NOT NULL,
 settings TEXT NOT NULL, text TEXT NOT NULL, confidence TEXT, created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence_jobs (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES evidence_files(document_id) ON DELETE CASCADE,
 region_id TEXT NOT NULL UNIQUE REFERENCES evidence_regions(id) ON DELETE CASCADE,
 state TEXT NOT NULL, updated REAL NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS extraction_charges (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, document_id TEXT NOT NULL,
 cache_key TEXT NOT NULL, day TEXT NOT NULL, reserved INTEGER NOT NULL CHECK(reserved>0),
 actual INTEGER, state TEXT NOT NULL CHECK(state IN ('reserved','released','pending','reconciled')),
 created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS extraction_charge_cache ON extraction_charges(owner_id,cache_key,state);
CREATE TABLE IF NOT EXISTS extraction_cache (
 owner_id TEXT NOT NULL, cache_key TEXT NOT NULL, result TEXT NOT NULL, created REAL NOT NULL,
 PRIMARY KEY(owner_id,cache_key)
);
"""

def initialize():
    with db._connect() as conn:
        conn.executescript(SCHEMA)


def identity(*parts):
    return str(uuid5(NAMESPACE_URL, json.dumps(parts, sort_keys=True, ensure_ascii=False)))


def register(owner, document, raw, total_pages):
    version = hashlib.sha256(raw).hexdigest()
    with db._immediate() as conn:
        conn.execute('INSERT OR IGNORE INTO evidence_files VALUES (?,?,?,0,?,?)',
                     (document, owner, version, total_pages, time.time()))
    return version


def register_existing(owner, document, page_payload, original_sha256=None):
    """Brings a document uploaded before evidence records existed into them,
    without changing anything it already has. The document becomes file
    version 1 (identified by its original's hash when it has one); each page
    becomes a native source region with one immutable extraction record that
    holds the page text exactly as the viewer shows it, under the very
    extraction_version its existing citations and saved highlights carry.
    Idempotent: ids are derived from content, so running it again adds
    nothing. The revision stays 0, so search and caches are untouched."""
    pages = page_payload.get('pages') or {}
    extraction_version = page_payload.get('extraction_version') or ''
    version = original_sha256 or identity('legacy-file', document)
    with db._immediate() as conn:
        conn.execute('INSERT OR IGNORE INTO evidence_files VALUES (?,?,?,0,?,?)',
                     (document, owner, version, len(pages), time.time()))
    for number, text in sorted(pages.items(), key=lambda item: int(item[0])):
        region = add_region(document, version, {'page': int(number), 'kind': 'page_text'}, state='done')
        add_record(region, text, provenance='native', content_type='text', extractor='native:page-text',
                   settings={'extraction_version': extraction_version})
    return version


def record_for_page(owner, document, page, extraction_version):
    """The extraction record an existing citation or saved highlight points
    at: the native page text under that extraction_version. Later OCR or
    description records never match, so they can't change what an old
    citation resolves to. None when that version was never recorded."""
    with db._connect() as conn:
        for row in conn.execute("""SELECT e.id,e.text,e.settings,r.id AS region_id FROM evidence_records e
                JOIN evidence_regions r ON r.id=e.region_id JOIN evidence_files f ON f.document_id=r.document_id
                WHERE f.owner_id=? AND f.document_id=? AND e.provenance='native' AND e.extractor='native:page-text'""", (owner, document)):
            if json.loads(row['settings']).get('extraction_version') == extraction_version and json.loads(
                    conn.execute('SELECT location FROM evidence_regions WHERE id=?', (row['region_id'],)).fetchone()['location']).get('page') == int(page):
                return dict(row)
    return None


def add_region(document, version, location, *, asset_hash=None, asset_path=None, state='queued', error=None, mode='read'):
    rid = identity(document, version, location)
    with db._immediate() as conn:
        conn.execute('INSERT OR IGNORE INTO evidence_regions VALUES (?,?,?,?,?,?,?,?,?)',
                     (rid, document, json.dumps(location, sort_keys=True), asset_hash, asset_path, state, error, mode, time.time()))
        if state == 'queued':
            conn.execute('INSERT OR IGNORE INTO evidence_jobs VALUES (?,?,?,?,?,NULL)',
                         (str(uuid4()), document, rid, 'queued', time.time()))
    return rid


def add_record(region, text, *, provenance='ocr', content_type='text', extractor='azure-read:2024-11-30', settings=None, confidence=None):
    config = json.dumps(settings or {}, sort_keys=True)
    rid = identity(region, provenance, extractor, config, text)
    with db._immediate() as conn:
        conn.execute('INSERT OR IGNORE INTO evidence_records VALUES (?,?,?,?,?,?,?,?,?)',
                     (rid, region, provenance, content_type, extractor, config, text, json.dumps(confidence), time.time()))
    return rid


def revision(owner, document):
    try:
        with db._connect() as conn:
            row = conn.execute('SELECT revision FROM evidence_files WHERE document_id=? AND owner_id=?', (document, owner)).fetchone()
        return row['revision'] if row else 0
    except Exception as exc:
        # Older fixtures have no enrichment tables. Other DB errors must fail.
        import sqlite3
        if isinstance(exc, sqlite3.OperationalError) and 'no such table' in str(exc):
            return 0
        raise


def publish(owner, document, expected):
    with db._immediate() as conn:
        updated = conn.execute('UPDATE evidence_files SET revision=revision+1 WHERE document_id=? AND owner_id=? AND revision=?',
                               (document, owner, expected)).rowcount
        if updated != 1:
            raise RuntimeError('Evidence changed during publication; retry indexing.')
        conn.execute("UPDATE evidence_jobs SET state='done',updated=? WHERE document_id=? AND state='indexed_pending'", (time.time(),document))


PUBLISH_MAX_WAIT_SECONDS = 90


def documents_ready_to_publish(now=None, max_wait=PUBLISH_MAX_WAIT_SECONDS):
    """Documents with picture text waiting to be published: (owner, document).
    A document with pictures still being read waits for the batch to finish, so
    thirty pictures make one publish, not thirty (each publish rewrites the
    keyword index and clears the caches). It never waits longer than max_wait
    seconds past its oldest finished picture, so searches see the first results
    of a long batch."""
    now = now or time.time()
    with db._connect() as conn:
        rows = conn.execute("""SELECT f.owner_id, j.document_id,
                 SUM(j.state IN ('queued','running')) AS busy,
                 MIN(CASE WHEN j.state='indexed_pending' THEN j.updated END) AS oldest
               FROM evidence_jobs j JOIN evidence_files f ON f.document_id=j.document_id
               GROUP BY j.document_id HAVING SUM(j.state='indexed_pending') > 0""").fetchall()
    return [(r['owner_id'], r['document_id']) for r in rows if not r['busy'] or now - r['oldest'] >= max_wait]


def settle_jobs(document):
    """Finishes the jobs whose evidence turned out to be already searchable."""
    with db._immediate() as conn:
        conn.execute("UPDATE evidence_jobs SET state='done',updated=? WHERE document_id=? AND state='indexed_pending'", (time.time(), document))


def records(owner, document):
    with db._connect() as conn:
        return [dict(r) for r in conn.execute('''SELECT e.*, r.location,r.asset_path,r.asset_hash,r.document_id
          FROM evidence_records e JOIN evidence_regions r ON r.id=e.region_id
          JOIN evidence_files f ON f.document_id=r.document_id WHERE f.owner_id=? AND f.document_id=? ORDER BY e.created,e.id''',(owner,document))]


def has_inventory(owner, document):
    """Whether this document's pictures were already inventoried. Backfilled
    page text alone does not count: the inventory is a separate step."""
    with db._connect() as conn:
        return conn.execute("SELECT 1 FROM evidence_regions r JOIN evidence_files f ON f.document_id=r.document_id "
                            "WHERE f.owner_id=? AND r.document_id=? AND r.asset_hash IS NOT NULL LIMIT 1", (owner, document)).fetchone() is not None


def status(owner, document):
    with db._connect() as conn:
        f = conn.execute('SELECT * FROM evidence_files WHERE owner_id=? AND document_id=?',(owner,document)).fetchone()
        if not f: return {'revision':0,'state':'not_started','regions':[]}
        rows = [dict(r) for r in conn.execute('SELECT id,state,error,location,mode FROM evidence_regions WHERE document_id=? AND asset_hash IS NOT NULL',(document,))]
        jobs = conn.execute("SELECT COUNT(*) FROM evidence_jobs WHERE document_id=? AND state IN ('queued','running','indexed_pending')",(document,)).fetchone()[0]
    for r in rows: r['location']=json.loads(r['location'])
    failed=sum(r['state'] not in ('done','queued','running') for r in rows)
    return {'revision':f['revision'],'state':'processing' if jobs else ('partial' if failed else 'complete'),
            'total':len(rows),'failed':failed,'completed':sum(r['state']=='done' for r in rows),'regions':rows}


class BudgetExceeded(ValueError): pass
class RequestUncertain(ValueError): pass

def reserve(owner, document, cache_key, amount, upload_cap, daily_cap):
    if amount<=0 or upload_cap<=0 or daily_cap<=0:
        raise BudgetExceeded('Extraction prices and spending caps must be configured before paid processing.')
    day=datetime.now(timezone.utc).date().isoformat()
    with db._immediate() as conn:
        if conn.execute("SELECT 1 FROM extraction_charges WHERE owner_id=? AND cache_key=? AND state IN ('reserved','pending')",(owner,cache_key)).fetchone():
            raise RequestUncertain('An earlier request is in flight or its billing is uncertain; it will not be submitted twice.')
        # Pending/reserved charges remain counted across days until reconciled.
        daily=conn.execute("SELECT COALESCE(SUM(CASE WHEN state='reconciled' THEN actual ELSE reserved END),0) FROM extraction_charges WHERE state!='released' AND (day=? OR state IN ('pending','reserved'))",(day,)).fetchone()[0]
        upload=conn.execute("SELECT COALESCE(SUM(CASE WHEN state='reconciled' THEN actual ELSE reserved END),0) FROM extraction_charges WHERE document_id=? AND state!='released'",(document,)).fetchone()[0]
        if daily+amount>daily_cap or upload+amount>upload_cap:
            raise BudgetExceeded('Image processing paused: extraction spending cap reached.')
        cid=str(uuid4())
        conn.execute('INSERT INTO extraction_charges VALUES (?,?,?,?,?,?,NULL,?,?)',(cid,owner,document,cache_key,day,amount,'reserved',time.time()))
    return cid


def charge_state(cid, state, actual=None):
    if state not in ('pending','released','reconciled') or (state=='reconciled' and (actual is None or actual<0)):
        raise ValueError('Invalid charge state')
    with db._immediate() as conn:
        row=conn.execute('SELECT state FROM extraction_charges WHERE id=?',(cid,)).fetchone()
        if not row or row['state'] not in ('reserved','pending'): raise ValueError('Charge already finalized')
        if state=='released' and row['state']=='pending': raise ValueError('An uncertain dispatched request cannot be automatically released')
        conn.execute('UPDATE extraction_charges SET state=?,actual=? WHERE id=?',(state,actual,cid))


def cached(owner,key):
    with db._connect() as conn:
        row=conn.execute('SELECT result FROM extraction_cache WHERE owner_id=? AND cache_key=?',(owner,key)).fetchone()
    return json.loads(row['result']) if row else None


def cache(owner,key,result):
    with db._immediate() as conn:
        conn.execute('INSERT OR IGNORE INTO extraction_cache VALUES (?,?,?,?)',(owner,key,json.dumps(result),time.time()))


def claim():
    with db._immediate() as conn:
        row=conn.execute("""SELECT j.*,r.location,r.asset_path,r.asset_hash,r.mode,f.owner_id
          FROM evidence_jobs j JOIN evidence_regions r ON r.id=j.region_id JOIN evidence_files f ON f.document_id=j.document_id
          JOIN documents d ON d.id=j.document_id WHERE j.state='queued' AND d.status='ready' ORDER BY j.updated LIMIT 1""").fetchone()
        if not row: return None
        conn.execute("UPDATE evidence_jobs SET state='running',updated=? WHERE id=?",(time.time(),row['id']))
        conn.execute("UPDATE evidence_regions SET state='running' WHERE id=?",(row['region_id'],))
    return dict(row)


def finish(job, state, error=None):
    with db._immediate() as conn:
        conn.execute('UPDATE evidence_jobs SET state=?,error=?,updated=? WHERE id=?',(state,error,time.time(),job['id']))
        conn.execute('UPDATE evidence_regions SET state=?,error=? WHERE id=?',('done' if state=='indexed_pending' else state,error,job['region_id']))


def recover():
    """After a restart. The worker marks a charge pending BEFORE it sends the
    request, so a charge still 'reserved' was never sent: it is released. A
    running job may have been sent: its charge is already pending (counted),
    and the job is never resent automatically."""
    with db._immediate() as conn:
        conn.execute("UPDATE evidence_regions SET state='pending',error='Processing was interrupted; billing may be pending.' WHERE id IN (SELECT region_id FROM evidence_jobs WHERE state='running')")
        conn.execute("UPDATE evidence_jobs SET state='pending' WHERE state='running'")
        conn.execute("UPDATE extraction_charges SET state='released' WHERE state='reserved'")


# How long a charge may stay uncertain before it is settled as billed.
UNRESOLVED_AFTER_SECONDS = 24 * 3600


def settle_unresolved(now: float | None = None) -> int:
    """Uncertain charges older than UNRESOLVED_AFTER_SECONDS are assumed
    billed at their reserved (maximum) amount: the conservative answer for a
    spending cap, so they stop being 'pending' without ever being counted as
    free. Document Intelligence reports pages, not a bill, so nothing better
    can be learned by waiting longer. Their jobs stay failed, never retried.
    Returns how many were settled."""
    cutoff = (now or time.time()) - UNRESOLVED_AFTER_SECONDS
    with db._immediate() as conn:
        return conn.execute("UPDATE extraction_charges SET state='reconciled', actual=reserved WHERE state='pending' AND created < ?",
                            (cutoff,)).rowcount
