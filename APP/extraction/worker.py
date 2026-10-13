"""Single durable enrichment worker; no paid call without a ledger reservation.

Automatic SDK retries are disabled: ambiguous failures remain pending rather
than silently purchasing a second extraction. Deployment currently uses one
application process; do not start recovery concurrently in multiple replicas.
"""
from __future__ import annotations
import hashlib
import json
import os
import threading
import time
from pathlib import Path
from APP import db
from APP.extraction import store


def enabled(): return os.getenv('EVIDENCE_ENRICHMENT','false').lower() in ('true','1','yes')
def paid_enabled(): return os.getenv('EXTRACTION_PAID_ENABLED','false').lower() in ('true','1','yes')

class AzureExtractor:
    version='azure-di:2024-11-30:v1'
    def settings(self, mode):
        return {'version':self.version,'mode':mode,'model': 'prebuilt-read' if mode=='read' else 'prebuilt-layout'}
    def ready(self):
        return bool(os.getenv('AZURE_DOC_INTEL_ENDPOINT') and os.getenv('AZURE_DOC_INTEL_KEY'))
    def estimate(self, mode):
        return int(os.getenv('EXTRACTION_'+mode.upper()+'_MICROUSD_PER_PAGE','0'))
    def extract(self, data, mode):
        from azure.ai.documentintelligence import DocumentIntelligenceClient
        from azure.core.credentials import AzureKeyCredential
        client=DocumentIntelligenceClient(os.environ['AZURE_DOC_INTEL_ENDPOINT'],AzureKeyCredential(os.environ['AZURE_DOC_INTEL_KEY']),
            api_version='2024-11-30',retry_total=0,connection_timeout=15,read_timeout=90)
        try:
            args={'features':['formulas']} if mode=='formulas' else {}
            poller=client.begin_analyze_document('prebuilt-read' if mode=='read' else 'prebuilt-layout',
                body=data,content_type='application/octet-stream',**args)
            result=poller.result(timeout=180)
            text=result.content or ''
            formulas=[]
            for page in result.pages or []:
                for f in getattr(page,'formulas',None) or []:
                    formulas.append(f.value)
            for value in formulas: text=text.replace(':formula:',value,1)
            return {'text':text,'provenance':'ocr','content_type':'formula' if formulas else 'text',
                'extractor':self.version,'confidence':None if formulas else [w.confidence for p in result.pages or [] for w in p.words or []],
                'pages':len(result.pages or []) or 1,'formulas':formulas}
        finally: client.close()


def process(job, provider=None):
    provider=provider or AzureExtractor()
    owner,document=job['owner_id'],job['document_id']
    settings=provider.settings(job['mode'])
    key=hashlib.sha256(json.dumps([job['asset_hash'],settings],sort_keys=True).encode()).hexdigest()
    result=store.cached(owner,key)
    if result is None:
        if not provider.ready():
            store.finish(job,'blocked','Azure OCR credentials are not configured.'); return
        try:
            data=Path(job['asset_path']).read_bytes() # preflight before reserving/sending
            amount=provider.estimate(job['mode'])
            charge=store.reserve(owner,document,key,amount,int(os.getenv('EXTRACTION_UPLOAD_CAP_MICROUSD','0')),
                                 int(os.getenv('EXTRACTION_DAILY_CAP_MICROUSD','0')))
        except (ValueError,OSError) as exc:
            store.finish(job,'blocked',str(exc)); return
        # Pending is written BEFORE dispatch. A process crash can never release
        # a request that may already have been billed.
        store.charge_state(charge,'pending')
        try:
            result=provider.extract(data,job['mode'])
            store.cache(owner,key,result)
            # Document Intelligence reports pages, not a final monetary bill.
            # Compute from configured regional rates, retaining usage in cache.
            store.charge_state(charge,'reconciled',amount*result.get('pages',1))
        except Exception:
            store.finish(job,'pending','Azure request did not complete. Its charge is uncertain; automatic retry is disabled.'); return
    text=result.get('text','').strip()
    if text:
        store.add_record(job['region_id'],text,provenance=result.get('provenance','ocr'),
            content_type=result.get('content_type','text'),extractor=result.get('extractor',provider.version),
            settings=settings,confidence=result.get('confidence'))
    store.finish(job,'indexed_pending')


class Worker:
    def __init__(self,service):
        self.service=service; self.stop_event=threading.Event(); self.thread=None; self.retry_after={}
    def start(self):
        store.recover()
        # Documents uploaded before evidence records existed join them, once,
        # in the background (nothing about their search or citations changes).
        threading.Thread(target=self.service.backfill_all_evidence, name='evidence-backfill', daemon=True).start()
        self.thread=threading.Thread(target=self.run,name='evidence-worker',daemon=True); self.thread.start()
    def stop(self):
        self.stop_event.set()
        if self.thread: self.thread.join(timeout=2)
    def run(self):
        import logging
        while not self.stop_event.wait(2):
            try:
                if not paid_enabled(): continue
                store.settle_unresolved()
                job=store.claim()
                if job: process(job)
                for owner,document in store.documents_ready_to_publish():
                    if time.monotonic() < self.retry_after.get(document,0): continue
                    try:
                        self.service.publish_evidence(owner,document)
                        self.retry_after.pop(document,None)
                    except Exception:
                        # Stays indexed_pending and is retried, but not every
                        # 2 seconds: each attempt talks to Qdrant and the embedder.
                        self.retry_after[document]=time.monotonic()+60
                        logging.getLogger(__name__).exception('Publishing picture text failed; will retry in 60 s')
            except Exception:
                logging.getLogger(__name__).exception('Evidence worker deferred an update')
