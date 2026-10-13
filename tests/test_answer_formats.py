"""Summaries and answer formats through the real service: the whole document
is sampled for overview questions, the style reaches the model as fixed
wording, a length that misses gets one honest retry, a summary that can't be
verified falls back to the document's own quoted passages, and the evidence
check is the same as ever. Only retrieval and the model are fixtures."""

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
from APP.rag.evidence import UNVERIFIED_ANSWER
from APP.rag.service import RAGService

SECTIONS = [f"Section {i} of the report explains topic number {i} and its findings in some detail." for i in range(40)]


def reply(answer, *citations):
    return json.dumps({'answer_status': 'supported', 'answer': answer,
                       'citations': [{'id': f'C{n}', 'quote': q} for n, q in citations]})


class Base(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.patch(db, 'DB_PATH', Path(temp.name) / 'test.db')
        db.init_db()
        self.owner = db.create_user('formats@example.invalid')
        self.document = db.create_document(self.owner, 'Report.txt', pages=40)
        self.chunks = [Document(page_content=t, metadata={'chunk_id': i, 'page': i + 1, 'source': 'Report.txt'}) for i, t in enumerate(SECTIONS)]
        self.service = RAGService.__new__(RAGService)
        self.service.settings = SimpleNamespace(qdrant_collection='test')
        self.provider = self.service.chat_provider = Mock(chat_model='fixture')
        self.service._load_document_artifacts = Mock(return_value=(None, None, self.chunks))
        self.service._rewrite_query_if_needed = Mock(side_effect=lambda question, *_: question)
        self.service.get_document_pages = Mock(return_value=[])
        self.patch(app.state, 'rag_service', self.service, create=True)
        app.dependency_overrides[get_current_user] = lambda: {'id': self.owner}
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app)

    def patch(self, target, name, value, **kw):
        p = patch.object(target, name, value, **kw)
        p.start()
        self.addCleanup(p.stop)

    def ask(self, question, responses, **extra):
        self.provider.complete_messages.reset_mock()
        self.provider.complete_messages.side_effect = responses
        with patch('APP.rag.service.hybrid_retrieve', return_value=[(self.chunks[3], 1.0)]) as retrieve, \
             patch('APP.rag.service.expand_with_neighbors_scored', side_effect=lambda **kw: kw['results']):
            r = self.client.post('/query', json={'document_id': self.document, 'question': question, **extra})
            self.retrieved = retrieve.called
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def request(self, call=0):
        """(system, user) text of the n-th request sent to the model."""
        messages = self.provider.complete_messages.call_args_list[call].args[0]
        return messages[0]['content'], messages[1]['content']


def markdown(text):
    return text


class SummaryQuestionsTest(Base):
    def test_a_summary_reads_the_whole_document_and_is_written_not_quoted(self):
        summary = ("The report covers ten sections of findings [C1][C2].\n\n- Early sections set out topics 0 to 5 [C1]\n"
                   "- Later sections close with topic 39 [C2]")
        result = self.ask('Summarize the key takeaways.', [summary])
        self.assertFalse(self.retrieved)                                     # no keyword retrieval
        self.assertEqual(self.provider.complete_messages.call_count, 1)       # one model call, nothing extra
        system, user = self.request()
        for section in (SECTIONS[0], SECTIONS[-1]):                          # first and last passages are both read
            self.assertIn(section, user)
        positions = [user.index(x) for x in SECTIONS if x in user]
        self.assertEqual(positions, sorted(positions))
        self.assertIn('in your own words', system)
        self.assertIn('not JSON', system)
        self.assertNotIn('quote', system.split('in your own words')[1])        # a summary is not asked for quotes
        self.assertIn('Later sections close with topic 39', result['answer'])
        self.assertNotIn('quoted exactly', result['answer'])
        self.assertEqual(len(result['sources']), 2)

    def test_the_format_and_length_come_from_the_question_itself(self):
        self.ask('summarise this in about 300 words as a table', ['| Point | Detail |\n| --- | --- |\n| Topics | Ten [C1] |'])
        system, user = self.request()
        self.assertIn('format and length the user asks for', system)
        self.assertIn('summarise this in about 300 words as a table', user)
        self.assertGreaterEqual(self.provider.complete_messages.call_args.kwargs['max_tokens'], 780)

    def test_a_summary_with_no_passage_ids_is_asked_again_once(self):
        result = self.ask('summarize this document', ['A fluent summary with nothing cited.', 'A better summary [C1].'])
        self.assertEqual(self.provider.complete_messages.call_count, 2)
        self.assertIn('A better summary', result['answer'])
        self.assertTrue(result['sources'])

    def test_a_summary_that_never_cites_falls_back_to_the_documents_own_passages(self):
        result = self.ask('summarize this document', ['Nothing cited.', 'Still nothing cited.'])
        self.assertIn('quoted exactly', result['answer'])
        self.assertIn(SECTIONS[0], result['answer'])
        self.assertNotIn('Nothing cited', result['answer'])

    def test_an_empty_document_says_so(self):
        result = self.ask('summarize this document', ['NO_CONTENT'])
        self.assertIn("couldn't find enough information", result['answer'])
        self.assertEqual(self.provider.complete_messages.call_count, 1)

    def test_a_specific_question_still_uses_retrieval_and_short_exact_quotes(self):
        fact = SECTIONS[3]
        result = self.ask('what does section 3 explain?', [reply(f'{fact} [C1]', (1, fact))])
        self.assertTrue(self.retrieved)
        system, _user = self.request()
        self.assertIn('shortest exact phrase', system)
        self.assertIn('format and length the user asks for', system)
        self.assertEqual(len(result['sources']), 1)


class QuoteTest(Base):
    fact = SECTIONS[3]

    def test_a_tidied_quote_is_kept_as_a_whole_passage_citation_without_asking_again(self):
        tidied = 'Section 3 of the report explains topic number 3 and its findings in detail'   # "some" dropped
        result = self.ask('what does section 3 explain?', [reply('Section 3 explains topic 3 [C1].', (1, tidied))])
        self.assertEqual(self.provider.complete_messages.call_count, 1)
        self.assertIn('Section 3 explains topic 3', result['answer'])
        self.assertEqual(result['sources'][0]['content'], self.fact)

    def test_an_invented_quote_is_still_refused(self):
        bad = reply('Revenue doubled [C1].', (1, 'Revenue doubled because of strong sales in Asia'))
        result = self.ask('what does section 3 explain?', [bad, bad])
        self.assertEqual(self.provider.complete_messages.call_count, 2)
        self.assertEqual(result['answer'], UNVERIFIED_ANSWER)
        self.assertEqual(result['sources'], [])


class FolderSummaryTest(Base):
    def test_a_folder_summary_samples_every_document_and_keeps_to_the_budget(self):
        other = [Document(page_content=f'Other file part {i} describes something else entirely.', metadata={'chunk_id': i, 'page': i + 1, 'source': 'Other.txt'}) for i in range(30)]
        self.service._load_document_artifacts = Mock(side_effect=[(None, None, self.chunks), (None, None, other)])
        second = db.create_document(self.owner, 'Other.txt', pages=30)
        self.provider.complete_messages.side_effect = ['Both files are covered [C1][C2].']
        r = self.client.post('/query', json={'document_id': self.document, 'document_ids': [second], 'question': 'summarise these files'})
        self.assertEqual(r.status_code, 200, r.text)
        _system, user = self.request()
        self.assertIn('Report.txt', user)
        self.assertIn('Other.txt', user)
        from APP.rag.service import _CONTEXT_TOKENIZER, MAX_CONTEXT_TOKENS
        self.assertLessEqual(len(_CONTEXT_TOKENIZER.encode(user.split('Reference passages:')[1])), MAX_CONTEXT_TOKENS + 200)


if __name__ == '__main__':
    unittest.main()


class PromptContractTest(Base):
    def test_the_prompt_asks_for_passage_ids_and_keeps_quotes_out_of_the_answer(self):
        self.ask('what does section 3 explain?', [reply(f'{SECTIONS[3]} [C1]', (1, SECTIONS[3]))])
        system, _user = self.request()
        self.assertIn("[C1]", system)
        self.assertIn("{id: 'C1', quote:", system)
        self.assertNotIn("[E1]", system)                                           # one simple labelling the model follows reliably
        self.assertIn("not in a 'Key supporting quotes' section", system)


class YamlStyleReplyTest(unittest.TestCase):
    """The model sometimes writes its reply as YAML-style text instead of JSON."""
    KEPT = [(Document(page_content="Jarvis's march runs in O(nh) time, where h is the number of hull vertices."), 1.0)]

    def read(self, raw):
        from APP.rag.evidence import selected_evidence
        return selected_evidence(raw, self.KEPT)

    def test_the_header_never_reaches_the_reader_and_the_citation_is_kept(self):
        raw = ('answer_status: "supported"\nanswer: |\n  Jarvis’s march runs in O(nh) time [C1].\n  It outputs the hull vertices.\n'
               'citations:\n  - id: C1\n    quote: Jarvis\'s march runs in O(nh) time\n')
        answer, selected = self.read(raw)
        self.assertEqual(answer, "Jarvis’s march runs in O(nh) time [C1].\nIt outputs the hull vertices.\n")
        self.assertNotIn("answer_status", answer)
        self.assertEqual(selected, [(0, "Jarvis's march runs in O(nh) time")])

    def test_a_quote_with_a_colon_that_breaks_the_yaml_is_still_read(self):
        raw = ('answer_status: supported\nanswer: |\n  It runs in O(nh) time [C1].\n'
               'citations:\n  - id: C1\n    quote: runs in O(nh) time, where h: the number of hull vertices\n')
        answer, selected = self.read(raw)
        self.assertEqual(answer.strip(), "It runs in O(nh) time [C1].")
        self.assertEqual([i for i, _ in selected], [0])

    def test_insufficient_evidence_in_this_format_is_still_insufficient(self):
        from APP.rag.evidence import LIMITED_CONTEXT
        self.assertEqual(self.read('answer_status: insufficient_evidence\nanswer: |\n  Not covered.\ncitations: []\n'), (LIMITED_CONTEXT, []))

    def test_fenced_yaml_and_plain_json_still_work(self):
        self.assertEqual(self.read('```yaml\nanswer_status: supported\nanswer: "Runs in O(nh) time [C1]."\ncitations: []\n```')[0], "Runs in O(nh) time [C1].")
        self.assertEqual(self.read('{"answer_status": "supported", "answer": "Fine [C1].", "citations": []}')[0], "Fine [C1].")


class CutOffReplyTest(Base):
    """A reply that runs out of room (empty, or JSON cut off part-way) is retried, and is
    never reported as "the document does not contain this"."""
    fact = SECTIONS[3]

    def good(self):
        return reply(f'| Topic |\n|---|\n| {self.fact} [C1] |', (1, self.fact))

    def test_an_empty_reply_is_retried_and_the_retry_is_used(self):
        result = self.ask('give the section 3 details in a table', ['', self.good()])
        self.assertEqual(self.provider.complete_messages.call_count, 2)
        self.assertIn(self.fact, result['answer'])
        self.assertTrue(result['sources'])

    def test_json_cut_off_part_way_is_retried_and_the_retry_is_used(self):
        cut = self.good()[:len(self.good()) // 2]
        result = self.ask('give the section 3 details in a table', [cut, self.good()])
        self.assertEqual(self.provider.complete_messages.call_count, 2)
        self.assertIn(self.fact, result['answer'])

    def test_if_both_attempts_are_cut_off_the_reader_is_told_it_could_not_be_verified_not_that_the_document_lacks_it(self):
        from APP.rag.evidence import LIMITED_CONTEXT, UNVERIFIED_ANSWER
        cut = self.good()[:40]
        result = self.ask('give the section 3 details in a table', [cut, cut])
        self.assertEqual(result['answer'], UNVERIFIED_ANSWER)
        self.assertNotEqual(result['answer'], LIMITED_CONTEXT)

    def test_the_answer_is_given_room_for_thinking_a_table_and_its_quotes(self):
        self.ask('give the section 3 details in a table', [self.good()])
        self.assertGreaterEqual(self.provider.complete_messages.call_args.kwargs['max_tokens'], 2400)
        self.ask('summarize this document', ['A summary [C1].'])
        self.assertGreaterEqual(self.provider.complete_messages.call_args.kwargs['max_tokens'], 3000)


class BareStatusLineTest(unittest.TestCase):
    KEPT = [(Document(page_content="The LINK FIELD holds the pointer and the DATA FIELD holds the value."), 1.0)]

    def read(self, raw):
        from APP.rag.evidence import selected_evidence
        return selected_evidence(raw, self.KEPT)

    def test_a_status_word_on_its_own_line_is_not_shown_to_the_reader(self):
        answer, selected = self.read("supported\n\n**Answer:**  \n- The LINK FIELD holds the pointer. [C1]")
        self.assertTrue(answer.startswith("**Answer:**"))
        self.assertNotIn("supported", answer)
        self.assertEqual([i for i, _ in selected], [0])                       # the citation is still read

    def test_insufficient_evidence_on_its_own_line_is_insufficient_evidence(self):
        from APP.rag.evidence import LIMITED_CONTEXT
        self.assertEqual(self.read("insufficient_evidence\n\nThe passages do not say."), (LIMITED_CONTEXT, []))

    def test_an_ordinary_answer_that_merely_starts_with_the_word_is_left_alone(self):
        answer, _ = self.read("Supported formats include the LINK FIELD [C1].")
        self.assertTrue(answer.startswith("Supported formats"))
        answer, _ = self.read("supported by the LINK FIELD, the DATA FIELD holds the value [C1].")
        self.assertTrue(answer.startswith("supported by"))
