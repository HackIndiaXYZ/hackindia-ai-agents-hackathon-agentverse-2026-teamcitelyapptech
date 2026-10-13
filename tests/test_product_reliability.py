import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from langchain_core.documents import Document
from APP import db
from APP.auth import get_current_user
from APP.main import app
from APP.rag.chunking import chunk_documents, extraction_version
from APP.rag.evidence import source_for, selected_evidence, bounded_absence, LIMITED_CONTEXT
from APP.rag.service import RAGService
from APP.rag.structure_chunking import split_into_sections
from APP.rag.vector_store import hybrid_retrieve, expand_with_neighbors_scored, apply_quality_penalty, tokenize_for_bm25
from APP.rag import cache


def doc(text, cid=0, **meta):
    return Document(page_content=text, metadata={'chunk_id': cid, 'page': 1, 'document_id': 'doc', 'source': 'same.txt', **meta})


class RetrievalRegressionTests(unittest.TestCase):
    def test_late_document_evidence_is_retained_ahead_of_long_neighbors(self):
        chunks=[doc('Unrelated background. '*250,i) for i in range(50)]
        chunks.append(doc('4. Quality gate\nLength and sentence completeness determine quality.',50))
        expanded=expand_with_neighbors_scored([(chunks[-1],.9)],chunks)
        context,kept=RAGService._build_context_blob(expanded,100)
        self.assertEqual(kept[0][0].metadata['chunk_id'],50)
        self.assertIn('Quality gate',context)

    def test_cache_invalidation_covers_versions_and_preserves_other_owners(self):
        with patch.object(cache,'_get_redis',return_value=None):
            cache.put('owner','doc:100:50','old');cache.put('owner','doc:200:60','new')
            cache.put('other','doc:100:50','private')
            cache.invalidate('owner','doc')
            self.assertIsNone(cache.get('owner','doc:100:50'))
            self.assertIsNone(cache.get('owner','doc:200:60'))
            self.assertEqual(cache.get('other','doc:100:50'),'private')
            cache.invalidate('other','doc')

    def test_reranker_order_survives_fusion(self):
        chunks = [doc('background', 0), doc('4. Quality gate\nChunk scoring evidence.', 1)]
        store, bm25 = Mock(), Mock()
        store.similarity_search.return_value = chunks
        bm25.get_scores.return_value = [5, 1]
        with patch('APP.rag.vector_store.flashrank_rerank', return_value=chunks[::-1]):
            result = hybrid_retrieve('Explain the quality gate.', store, bm25, chunks, top_n=2)
        self.assertEqual(result[0][0].metadata['chunk_id'], 1)

    def test_direct_evidence_precedes_neighbors_under_budget(self):
        chunks = [doc('Unrelated background. '*100, 0), doc('Meaningful short evidence.', 1), doc('Another fact.', 2)]
        results = expand_with_neighbors_scored([(chunks[1], .9), (chunks[2], .8)], chunks)
        context, kept = RAGService._build_context_blob(results, 50)
        self.assertEqual([d.metadata['chunk_id'] for d,_ in kept], [1,2])
        self.assertIn('Meaningful short evidence', context)
        self.assertEqual(results[1][1], .8)

    def test_absent_quality_metadata_is_neutral_but_failure_is_penalised(self):
        result = apply_quality_penalty([doc('unknown'),doc('weak',1,passed_gate=False)], [1,1])
        self.assertEqual([score for _,score in result], [1,.7])

    def test_unicode_lexical_terms_are_retained(self):
        self.assertIn('qualité', tokenize_for_bm25('Qualité 质量 оценка'))
        self.assertIn('质量', tokenize_for_bm25('Qualité 质量 оценка'))

    def test_short_sections_never_merge_across_pages(self):
        pages = [doc('4. Quality gate\nShort meaningful evidence.',page=1), doc('5. Retrieval\nNext page body.',page=2)]
        sections = split_into_sections(pages)
        self.assertEqual([s.metadata['page'] for s in sections], [1,2])
        chunks = chunk_documents(pages)
        self.assertTrue(all(c.metadata.get('page_char_start') is not None for c in chunks))

    def test_self_contained_question_ignores_bad_history(self):
        service = RAGService.__new__(RAGService)
        provider = Mock()
        question='Explain the quality gate.'
        self.assertEqual(service._rewrite_query_if_needed(question,[{'question':'Explain','answer':'No such section'}],provider),question)
        provider.complete.assert_not_called()


class EvidenceRegressionTests(unittest.TestCase):
    def test_explicit_provider_quotes_without_inline_markers_are_retained(self):
        raw=json.dumps({'answer':'Two supported facts.','citations':[{'id':'C1','quote':'First.'},{'id':'C1','quote':'Second.'}]})
        answer,selected=selected_evidence(raw,[(doc('First. Second.'),1),(doc('Unused.'),.5)])
        self.assertEqual(answer,'Two supported facts. [C1]')
        self.assertEqual(selected,[(0,'First.'),(0,'Second.')])

    def test_truncated_structured_response_is_not_displayed_as_json(self):
        # Nothing of the cut-off reply is shown, and it is not reported as "the document
        # lacks this" (LIMITED_CONTEXT): it has no usable answer, so it is retried, and if the
        # retry fails too the reader is told the answer could not be verified.
        answer, selected = selected_evidence('{"answer": "Incomplete', [])
        self.assertEqual((answer, selected), ('', []))
        self.assertNotIn('{', answer)
        self.assertNotEqual(answer, LIMITED_CONTEXT)

    def test_only_answer_cited_passages_are_returned(self):
        kept=[(doc('First.',0),1),(doc('Second.',1),.9),(doc('Unused.',2),.8)]
        raw=json.dumps({'answer':'Two facts [C1] [C2].','citations':[{'id':'C1','quote':'First.'},{'id':'C2','quote':'Second.'}]})
        answer, selected=selected_evidence(raw,kept)
        self.assertEqual(selected,[(0,'First.'),(1,'Second.')])

    def test_ambiguous_filename_page_does_not_become_many_buttons(self):
        _,chosen=selected_evidence('Fact [Source: same.txt | Page: 1]',[(doc('First'),1),(doc('Second',1),1)])
        self.assertEqual(chosen,[])

    def test_unicode_offsets_are_explicit_utf16_and_quote_is_exact(self):
        text='😀 lead\n4. Quality gate\nScoring counts words.'
        chunk=doc(text[7:],page_char_start=7,page_char_end=len(text),extraction_version='v1')
        source=source_for(chunk,1,{'text':text,'extraction_version':'v1'},'Scoring counts words.')
        selected=text.encode('utf-16-le')[2*source.page_char_start:2*source.page_char_end].decode('utf-16-le')
        self.assertEqual(selected,source.quote)
        self.assertEqual(source.offset_unit,'utf16')
        self.assertEqual(source.citation_id,source_for(chunk,1,{'text':text,'extraction_version':'v1'},'Scoring counts words.').citation_id)

    def test_legacy_backfill_requires_unique_text_and_no_stale_version(self):
        page={'text':'Repeated. Repeated.','extraction_version':'v1'}
        self.assertIsNone(source_for(doc('Repeated.'),1,page).page_char_start)
        self.assertIsNone(source_for(doc('Repeated.',extraction_version='old'),1,{'text':'Repeated.','extraction_version':'v1'}).page_char_start)
        self.assertEqual(source_for(doc('Repeated.'),1,{'text':'Repeated.','extraction_version':'v1'}).page_char_start,0)

    def test_document_wide_absence_claim_is_bounded(self):
        self.assertEqual(bounded_absence('The document does not mention that section.'),LIMITED_CONTEXT)
        self.assertEqual(bounded_absence('Scores use length and sentence completeness [C1].'),'Scores use length and sentence completeness [C1].')

    def test_extraction_identity_changes_with_content(self):
        self.assertNotEqual(extraction_version({1:'old'}),extraction_version({1:'new'}))


class ActualAnnotationApiTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.patcher=patch.object(db,'DB_PATH',Path(self.temp.name)/'test.db');self.patcher.start();self.addCleanup(self.patcher.stop)
        db.init_db();self.owner=db.create_user('disposable@example.invalid');self.document=db.create_document(self.owner,'Unicode.txt',pages=1)
        self.text='😀 first\nEvidence across inline nodes. 尾'
        service=Mock();service.get_document_pages.return_value=[{'page':1,'text':self.text,'extraction_version':'v1'}]
        service_patch=patch.object(app.state,'rag_service',service,create=True);service_patch.start();self.addCleanup(service_patch.stop)
        app.dependency_overrides[get_current_user]=lambda:{'id':self.owner}
        self.addCleanup(app.dependency_overrides.clear)
        self.client=TestClient(app);self.url='/conversations/disposable/annotations'
        self.payload={'document_id':self.document,'kind':'manual-highlight','page_number':1,'quote':'Evidence across inline nodes.',
                      'page_char_start':9,'page_char_end':38,'extraction_version':'v1'}

    def test_acknowledged_unicode_selection_survives_fresh_client_and_delete(self):
        response=self.client.post(self.url,json=self.payload)
        self.assertEqual(response.status_code,201,response.text)
        loaded=TestClient(app).get(self.url).json()
        self.assertEqual(loaded[0]['quote'],self.payload['quote'])
        self.assertEqual(loaded[0]['page_char_start'],9)
        self.assertEqual(self.client.delete('/annotations/'+loaded[0]['id']).status_code,200)
        self.assertEqual(TestClient(app).get(self.url).json(),[])

    def test_stale_version_and_invalid_utf16_ranges_are_rejected(self):
        self.assertEqual(self.client.post(self.url,json={**self.payload,'extraction_version':'old'}).status_code,409)
        self.assertEqual(self.client.post(self.url,json={**self.payload,'page_char_start':1}).status_code,422)
        self.assertEqual(self.client.post(self.url,json={**self.payload,'quote':'invented'}).status_code,422)
        self.assertEqual(self.client.get(self.url).json(),[])

    def test_another_owner_cannot_read_or_write_annotations(self):
        self.assertEqual(self.client.post(self.url,json=self.payload).status_code,201)
        other=db.create_user('other@example.invalid')
        app.dependency_overrides[get_current_user]=lambda:{'id':other}
        self.assertEqual(self.client.get(self.url).json(),[])
        self.assertEqual(self.client.post(self.url,json=self.payload).status_code,404)


if __name__=='__main__': unittest.main()
