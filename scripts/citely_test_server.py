"""Disposable loopback integration server. Real routes, auth, jobs, SQLite,
parser, embeddings, vector store, retrieval and page persistence. Only chat
generation is deterministic; this is not a live provider quality evaluation.
Never loads the project's .env or connects to production stores.
"""
import json
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
import time

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
os.environ['JWT_SECRET_KEY']=secrets.token_urlsafe(48)
os.environ['REDIS_URL']=''
os.environ['CORS_ALLOWED_ORIGINS']='http://127.0.0.1:4175'
os.environ['INGEST_RATE_LIMIT']='200/hour'
os.environ['QUERY_RATE_LIMIT']='200/hour'
os.environ['LOGIN_RATE_LIMIT']='200/hour'
os.environ['HF_HUB_OFFLINE']='1'

import uvicorn
from qdrant_client import QdrantClient
from APP import db, auth
from APP.main import create_app
from APP.rag.service import RAGService, BackendSettings
from APP.providers import build_default_embedding_provider

class FixtureChat:
    chat_model='deterministic-integration-fixture'
    def complete(self, prompt, **kwargs):
        return 'Explain the quality gate.'
    def complete_messages(self,messages,**kwargs):
        prompt=messages[-1]['content']
        question=prompt.split('Reference passages:')[0].lower()
        if 'lunar' in question:
            return json.dumps({'answer':'I cannot answer that from the retrieved passages.','citations':[]})
        citations=[]
        for ident,body in re.findall(r'\[(C\d+) \| Source: .*?\] (.*?)(?=\n\n\[C\d+ \||\Z)',prompt,re.S):
            for quote in ['The quality gate scores chunk length, sentence completeness, alphanumeric ratio and section membership.',
                          'Weak chunks are penalized during retrieval; they are not discarded.']:
                if quote in body:
                    citations.append({'id':ident,'quote':quote})
                    break
        citations=citations[:2]
        return json.dumps({'answer':' '.join(c['quote']+' ['+c['id']+']' for c in citations),'citations':citations})
    def is_healthy(self): return True

with tempfile.TemporaryDirectory(prefix='citely-integrated-') as directory:
    os.chdir(directory)
    db.init_db()
    owner=db.create_user('fixture@example.invalid',email_verified=True,password_hash=auth.hash_password('Fixture-password-123'))
    db.record_privacy_policy_acceptance(owner,'1.0')
    service=RAGService.__new__(RAGService)
    service.settings=BackendSettings()
    service.qdrant=QdrantClient(':memory:',force_disable_check_same_thread=True)
    service.embedding_provider=build_default_embedding_provider()
    service.chat_provider=FixtureChat();service._chat_probe_ok=True;service._chat_probe_at=None
    text=('😀 Diagnostic evidence\n4. Quality gate\nThe quality gate scores chunk length, sentence completeness, alphanumeric ratio and section membership.\n'
          +('Scoring uses the extracted text. '*38)+'\n5. Retrieval weighting\nWeak chunks are penalized during retrieval; they are not discarded.\n'+('Additional retrieval background. '*25))
    fresh=service.ingest(owner,'Disposable-synopsis.txt',text.encode(),1000,150,4)
    legacy=service.ingest(owner,'Legacy-synopsis.txt',text.encode(),1000,150,4)
    # Simulate pre-offset artifacts only inside this disposable directory.
    import pickle
    from APP.rag.vector_store import document_index_dir
    directory_path=document_index_dir(owner,legacy.document_id)
    with (directory_path/'bm25.pkl').open('rb') as handle: artifact=pickle.load(handle)
    for chunk in artifact['chunks']:
        for key in ['page_char_start','page_char_end','extraction_version']:chunk.metadata.pop(key,None)
    with (directory_path/'bm25.pkl').open('wb') as handle:pickle.dump(artifact,handle)
    (directory_path/'pages.json').unlink()
    db.create_chat_turn(legacy.document_id,owner,'Old question','Old answer with missing offsets.',json.dumps([{'document_id':legacy.document_id,'source':'Legacy-synopsis.txt','page':1,'content':'Legacy evidence','citation_id':'old-citation'}]))
    raw_ingest=service.ingest
    def delayed_ingest(*args,**kwargs):
        time.sleep(3)  # exposes intermediate job states for browser assertions
        return raw_ingest(*args,**kwargs)
    service.ingest=delayed_ingest
    app=create_app();app.state.rag_service=service
    print(json.dumps({'fixture_ids':{'fresh':fresh.document_id,'legacy':legacy.document_id}}),flush=True)
    # Lifespan normally constructs the production client. This disposable
    # process supplies its own real service and database before serving.
    uvicorn.run(app,host='127.0.0.1',port=8000,lifespan='off',log_level='warning')
