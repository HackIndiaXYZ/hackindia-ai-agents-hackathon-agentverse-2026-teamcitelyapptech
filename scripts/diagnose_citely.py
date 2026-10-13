"""Read a supplied synopsis, then trace retrieval in disposable local storage.

Uses the configured real embedding, reranking and chat providers, but an
in-memory Qdrant collection and temporary SQLite/index files. Prints IDs,
scores and presence flags; does not print source text, prompts or credentials.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dotenv import load_dotenv

parser = argparse.ArgumentParser()
parser.add_argument('document', type=Path)
parser.add_argument('--env', type=Path)
parser.add_argument('--offline', action='store_true', help='Local extraction/retrieval only; never call a chat API.')
parser.add_argument('--local-extraction', action='store_true', help='Extract DOCX locally while testing the configured chat provider; do not send the file to Azure DI.')
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--regression', action='store_true', help='Include technical facts, supported negatives, tables and unsupported-question regressions.')
parser.add_argument('--normal-quality-only', action='store_true', help='Use deployed quality weighting only.')
args = parser.parse_args()
if args.env:
    load_dotenv(args.env)
os.environ['REDIS_URL'] = ''
if args.offline:
    os.environ['HF_HUB_OFFLINE'] = '1'

from qdrant_client import QdrantClient
from APP import db
from APP.rag import vector_store as vs
from APP.rag.service import RAGService, BackendSettings, MAX_CONTEXT_TOKENS
from APP.providers import build_default_embedding_provider, build_default_chat_provider
from APP.schemas import QueryRequest

raw = args.document.read_bytes()
output = args.output.resolve()
report = {'document_sha256': hashlib.sha256(raw).hexdigest(), 'runs': []}
def contains(doc):
    return 'quality gate' in doc.page_content.lower()
def describe(results):
    return [{'chunk': d.metadata.get('chunk_id'), 'page': d.metadata.get('page'),
             'quality': d.metadata.get('strict_score'), 'passed': d.metadata.get('passed_gate'),
             'has_phrase': contains(d), 'score': round(float(s), 5),
             'anchored': d.metadata.get('page_char_start') is not None} for d, s in results]

with tempfile.TemporaryDirectory(prefix='citely-diagnostic-') as directory:
    os.chdir(directory)
    db.init_db()
    owner = db.create_user('disposable-diagnostic@example.invalid')
    service = RAGService.__new__(RAGService)
    service.settings = BackendSettings()
    service.qdrant = QdrantClient(':memory:')
    service.embedding_provider = build_default_embedding_provider()
    service.chat_provider = None if args.offline else build_default_chat_provider()
    if (args.offline or args.local_extraction) and args.document.suffix == '.docx':
        # Diagnostic-only local XML extraction. Production DOCX parsing uses
        # Azure DI; this is explicitly NOT evidence of its exact page output.
        import io
        import zipfile
        import xml.etree.ElementTree as ET
        from langchain_core.documents import Document
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            root = ET.fromstring(archive.read('word/document.xml'))
        ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
        body = '\n'.join(''.join(p.itertext()) for p in root.findall('.//w:p', ns))
        service._load_upload_to_docs = lambda *_: ([Document(page_content=body, metadata={'page': 1, 'source': args.document.name})], 'diagnostic-local-docx-xml')
        report['parser_limit'] = 'Diagnostic local DOCX XML; not production Azure DI pagination'
    ingested = service.ingest(owner, args.document.name, raw, 1000, 150, 4.0)
    report['document_id'] = ingested.document_id
    report['conversation_id'] = 'org:' + ingested.document_id
    store, bm25, chunks = service._load_document_artifacts(ingested.document_id, owner)
    pages = service.get_document_pages(ingested.document_id, owner)
    report['extraction_versions'] = sorted({p['extraction_version'] for p in pages})
    report['canonical_phrase_pages'] = [p['page'] for p in pages if 'quality gate' in p['text'].lower()]
    report['phrase_chunks'] = describe([(d, 0) for d in chunks if contains(d)])
    real_penalty = vs.apply_quality_penalty
    questions = ['Explain the quality gate.', 'How are weak chunks scored and handled?',
                 'What checks assess chunk quality?', 'What is the lunar cheese budget?']
    if args.regression:
        questions += ['Which embedding model is used, and what is its vector dimension?',
                      'How does hybrid retrieval combine dense and lexical search?',
                      'Compare the chunking strategies: time, number of chunks, and gate pass rate.',
                      'What limitations currently prevent horizontal scaling?',
                      'Which evaluation metrics does RAGAS measure?',
                      'What is implemented versus planned for PII detection?',
                      'Which generation model is used?',
                      'What annual subscription price does the synopsis give for enterprise customers?']
    for question in questions:
        for neutral in ([False] if args.normal_quality_only else [False, True]):
            penalty = (lambda chunks, base_scores: list(zip(chunks, base_scores))) if neutral else real_penalty
            with patch.object(vs, 'apply_quality_penalty', penalty):
                dense = store.similarity_search(question, k=min(50, len(chunks)))
                scores = bm25.get_scores(vs.tokenize_for_bm25(question))
                retrieved = vs.hybrid_retrieve(question, store, bm25, chunks, top_n=10)
                expanded = vs.expand_with_neighbors_scored(retrieved, chunks)
                context, kept = service._build_context_blob(expanded, MAX_CONTEXT_TOKENS)
                answer, generated = 'Not called (offline diagnostic)', False
                final = None
                if not args.offline:
                    captured = {}
                    generate = service._generate_answer
                    def trace_generation(*positional, **kwargs):
                        result = generate(*positional, **kwargs)
                        captured.update(answer=result[0], generated=result[1])
                        return result
                    with patch.object(service, '_generate_answer', trace_generation):
                        final = service.answer(owner, QueryRequest(document_id=ingested.document_id, question=question, top_k=10))
                    answer, generated = captured['answer'], captured['generated']
                report['runs'].append({'question': question, 'neutral_quality': neutral,
                    'dense_phrase_ranks': [i+1 for i,d in enumerate(dense) if contains(d)],
                    'lexical_phrase_scores': [float(s) for d,s in zip(chunks,scores) if contains(d)],
                    'retrieved': describe(retrieved), 'kept': describe(kept),
                    'context_has_phrase': 'quality gate' in context.lower(),
                    'context_sha256': hashlib.sha256(context.encode()).hexdigest(),
                    'generated': generated, 'answer': answer,
                    'response': final.model_dump() if final else None})
                output.write_text(json.dumps(report, indent=2))
                print(json.dumps({k: report['runs'][-1][k] for k in ['question','neutral_quality','context_has_phrase','generated']}), flush=True)
    service.qdrant.close()
