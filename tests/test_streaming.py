"""Answers shown while they are written; summaries pinned to sentences and
remembered. Only retrieval and the model are fixtures: the real service,
evidence checks, endpoint, history and usage counting run."""

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
from APP.providers.chat import ChatProvider, ContentFilterError
from APP.rag.service import RAGService
from APP.rag.streaming import StreamGate, json_answer_so_far

SECTIONS = [
    "OCR stands for Optical Character Recognition. It converts scanned documents and photographs into machine-readable text.",
    "Tesseract is a popular open-source OCR engine. It supports more than one hundred languages.",
    "Prompt engineering is the practice of designing inputs for language models. Few-shot prompts include worked examples to guide the model.",
    "Evaluation of extraction quality needs a labelled test set. Accuracy is measured per field.",
]
LEAK = "sk-proj-" + "a" * 30


class Typing:
    """A model fixture that writes each reply a few characters at a time."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []
        self.chat_model = "fixture"

    def complete_messages(self, messages, *, max_tokens=512, temperature=0, on_delta=None):
        self.calls.append({"messages": messages, "streamed": on_delta is not None})
        reply = self.replies.pop(0)
        if on_delta:
            for end in range(5, len(reply) + 5, 5):
                on_delta(reply[:end])
        return reply


class Base(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.temp = Path(temp.name)
        self.patch(db, "DB_PATH", self.temp / "test.db")
        db.init_db()
        self.owner = db.create_user("stream@example.invalid")
        self.document = db.create_document(self.owner, "Report.txt", pages=4)
        self.chunks = [Document(page_content=t, metadata={"chunk_id": i, "page": i + 1, "source": "Report.txt"}) for i, t in enumerate(SECTIONS)]
        self.service = RAGService.__new__(RAGService)
        self.service.settings = SimpleNamespace(qdrant_collection="test")
        self.service._load_document_artifacts = Mock(return_value=(None, None, self.chunks))
        self.service._rewrite_query_if_needed = Mock(side_effect=lambda question, *_: question)
        self.service.get_document_pages = Mock(return_value=[{"page": i + 1, "text": t, "extraction_version": "v1"} for i, t in enumerate(SECTIONS)])
        self.patch(app.state, "rag_service", self.service, create=True)
        app.dependency_overrides[get_current_user] = lambda: {"id": self.owner, "email": "stream@example.invalid"}
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app)
        self.index_dir = self.temp / "index"
        self.patch(__import__("APP.rag.service", fromlist=["x"]), "document_index_dir", lambda owner, doc: self.index_dir / doc)

    def patch(self, target, name, value, **kw):
        p = patch.object(target, name, value, **kw)
        p.start()
        self.addCleanup(p.stop)

    def model(self, *replies):
        self.provider = self.service.chat_provider = Typing(replies)
        return self.provider

    def stream(self, question):
        with patch("APP.rag.service.hybrid_retrieve", return_value=[(self.chunks[1], 1.0)]), \
             patch("APP.rag.service.expand_with_neighbors_scored", side_effect=lambda **kw: kw["results"]):
            r = self.client.post("/query/stream", json={"document_id": self.document, "question": question})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers["content-type"], "application/x-ndjson")
        return [json.loads(line) for line in r.text.splitlines() if line.strip()]

    def ask(self, question):
        with patch("APP.rag.service.hybrid_retrieve", return_value=[(self.chunks[1], 1.0)]), \
             patch("APP.rag.service.expand_with_neighbors_scored", side_effect=lambda **kw: kw["results"]):
            r = self.client.post("/query", json={"document_id": self.document, "question": question})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()


def reply(answer, *citations, status="supported"):
    return json.dumps({"answer_status": status, "answer": answer, "citations": [{"id": f"C{n}", "quote": q} for n, q in citations]})


class GateTest(unittest.TestCase):
    def test_the_answer_string_is_read_out_of_half_written_json(self):
        self.assertIsNone(json_answer_so_far('{"answer_status": "supported", "ans'))
        self.assertEqual(json_answer_so_far('{"answer_status": "supported", "answer": "Line one.\\nLine \\"two'), 'Line one.\nLine "two')
        self.assertEqual(json_answer_so_far('{"answer": "caf\\u00e9 and \\u00'), "café and ")          # a half escape waits
        self.assertEqual(json_answer_so_far('{"answer": "done", "citations": [{"quote": "not this"}]}'), "done")
        self.assertIsNone(json_answer_so_far('{"answer_status": "insufficient_evidence", "answer": "No."'))

    def test_only_whole_sentences_and_lines_are_shown_without_markers(self):
        gate = StreamGate(json_mode=False, evidence=())
        self.assertIsNone(gate.feed("The report cov"))
        self.assertEqual(gate.feed("The report covers OCR [C1]. It also cov"), "The report covers OCR.")
        self.assertIsNone(gate.feed("The report covers OCR [C1]. It also covers prompts [C"))   # nothing new and complete
        self.assertEqual(gate.feed("The report covers OCR [C1]. It also covers prompts [C2].\n- next"),
                         "The report covers OCR. It also covers prompts.")

    def test_a_reply_that_trips_the_safety_check_stops_being_shown(self):
        gate = StreamGate(json_mode=False, evidence=("ordinary text",))
        self.assertEqual(gate.feed("Fine so far.\n"), "Fine so far.")
        self.assertIsNone(gate.feed(f"Fine so far.\nThe key is {LEAK}.\n"))
        self.assertTrue(gate.blocked)
        self.assertIsNone(gate.feed(f"Fine so far.\nThe key is {LEAK}.\nMore innocent text.\n"))


class StreamEndpointTest(Base):
    def test_the_answer_arrives_in_pieces_then_the_checked_final_answer(self):
        fact = SECTIONS[1]
        self.model(reply("Tesseract is a popular open-source OCR engine [C1]. It supports more than one hundred languages [C1].",
                         (1, "Tesseract is a popular open-source OCR engine")))
        events = self.stream("which OCR engine is mentioned?")
        deltas = [e["text"] for e in events if e["type"] == "delta"]
        self.assertGreaterEqual(len(deltas), 2)
        self.assertEqual(deltas[0], "Tesseract is a popular open-source OCR engine.")
        self.assertTrue(all(b.startswith(a) for a, b in zip(deltas, deltas[1:])))          # each one extends the last
        self.assertNotIn("[C1]", "".join(deltas))
        self.assertEqual(events[-1]["type"], "done")
        final = events[-1]["response"]
        self.assertIn("[1]", final["answer"])
        self.assertEqual(final["sources"][0]["content"], fact)
        self.assertTrue(self.provider.calls[0]["streamed"])
        history = self.client.get(f"/documents/{self.document}/history").json()
        self.assertEqual(history[-1]["answer"], final["answer"])                            # saved like any answer

    def test_a_second_attempt_is_announced_and_the_final_answer_is_the_second(self):
        no_evidence = json.dumps({"answer_status": "supported", "answer": "Something unsupported.", "citations": []})
        self.model(no_evidence, reply("Tesseract is an OCR engine [C1].", (1, "Tesseract is a popular open-source OCR engine")))
        events = self.stream("which OCR engine is mentioned?")
        kinds = [e["type"] for e in events]
        self.assertIn("reset", kinds)
        self.assertEqual(kinds[-1], "done")
        self.assertIn("Tesseract is an OCR engine", events[-1]["response"]["answer"])

    def test_a_leak_is_never_shown_and_the_final_answer_is_the_protected_message(self):
        self.model(reply(f"Tesseract is used [C1].\nThe key is {LEAK}.\nMore text follows.", (1, "Tesseract is a popular open-source OCR engine")))
        events = self.stream("which OCR engine is mentioned?")
        shown = " ".join(e["text"] for e in events if e["type"] == "delta")
        self.assertNotIn(LEAK, shown)
        self.assertNotIn("More text follows", shown)
        self.assertIn("couldn't safely return that answer", events[-1]["response"]["answer"])

    def test_a_failure_arrives_as_an_error_event_and_the_question_is_not_counted(self):
        from APP import usage
        self.model()
        self.service._load_document_artifacts = Mock(side_effect=FileNotFoundError("No index found for document x."))
        with patch.object(usage, "is_limited", return_value=True), patch.object(usage, "limits", return_value={
                "upload": {"account": 3, "daily": 10}, "question": {"account": 5, "daily": 10}}):
            events = self.stream("anything at all?")
            self.assertEqual(events, [{"type": "error", "status": 404, "detail": "No index found for document x."}])
            self.assertEqual(db.usage_counts(self.owner, usage.today())["account"].get("question", 0), 0)

    def test_a_limit_reached_is_an_ordinary_429_before_any_stream(self):
        from APP import usage
        with patch.object(usage, "reserve", side_effect=db.UsageLimitReached("question", "account")):
            r = self.client.post("/query/stream", json={"document_id": self.document, "question": "hi"})
        self.assertEqual(r.status_code, 429)

    def test_the_streamed_and_plain_answers_are_the_same(self):
        answer = reply("Tesseract is a popular open-source OCR engine [C1].", (1, "Tesseract is a popular open-source OCR engine"))
        self.model(answer, answer)
        plain = self.ask("which OCR engine is mentioned?")
        streamed = self.stream("which OCR engine is mentioned?")[-1]["response"]
        self.assertEqual((plain["answer"], plain["sources"]), (streamed["answer"], streamed["sources"]))


class SummaryTest(Base):
    SUMMARY = ("The report explains that OCR turns scanned documents and photographs into machine-readable text [C1].\n"
               "- Few-shot prompts include worked examples to guide the model [C3]\n"
               "- Quality needs a labelled test set [C4]")

    def test_each_summary_point_cites_the_sentence_it_came_from(self):
        self.model(self.SUMMARY)
        result = self.ask("Summarize the key takeaways.")
        quotes = [s["quote"] for s in result["sources"]]
        self.assertIn("It converts scanned documents and photographs into machine-readable text.", quotes)
        self.assertIn("Few-shot prompts include worked examples to guide the model.", quotes)
        self.assertIn("Evaluation of extraction quality needs a labelled test set.", quotes)
        for source in result["sources"]:                                     # each one points at exact characters of its page
            page = SECTIONS[source["page"] - 1]
            self.assertEqual(page.encode("utf-16-le")[2 * source["page_char_start"]:2 * source["page_char_end"]].decode("utf-16-le"), source["quote"])
        self.assertEqual([m for m in __import__("re").findall(r"\[(\d+)\]", result["answer"])], ["1", "2", "3"])

    def test_a_point_that_matches_no_sentence_cites_the_whole_passage(self):
        self.model("Something about history entirely unrelated [C2].")
        result = self.ask("Summarize the document")
        self.assertEqual(result["sources"][0]["quote"], SECTIONS[1])

    def test_asking_for_the_same_summary_again_is_instant_and_the_same(self):
        self.model(self.SUMMARY)
        first = self.ask("Summarize the key takeaways.")
        second = self.ask("summarize   the key takeaways")                  # case, spacing, punctuation aside
        self.assertEqual(len(self.provider.calls), 1)                         # no second model call
        self.assertEqual((first["answer"], first["sources"]), (second["answer"], second["sources"]))
        self.assertEqual(len(self.client.get(f"/documents/{self.document}/history").json()), 2)   # both saved to the conversation

    def test_a_reindexed_document_or_a_different_question_is_written_fresh(self):
        self.model(self.SUMMARY, self.SUMMARY, self.SUMMARY)
        self.ask("Summarize the key takeaways.")
        self.ask("What are the main findings?")                              # a different question
        self.assertEqual(len(self.provider.calls), 2)
        (self.index_dir / self.document).mkdir(parents=True)
        (self.index_dir / self.document / "bm25.pkl").write_bytes(b"new index")
        self.ask("Summarize the key takeaways.")                             # the file was re-indexed
        self.assertEqual(len(self.provider.calls), 3)

    def test_deleting_the_document_forgets_its_summaries(self):
        self.model(self.SUMMARY)
        self.ask("Summarize the key takeaways.")
        with db._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM answer_cache").fetchone()[0], 1)
        db.delete_document(self.document, self.owner)
        with db._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM answer_cache").fetchone()[0], 0)

    def test_fallbacks_are_never_remembered(self):
        self.model("No markers at all.", "Still none.", self.SUMMARY)
        self.ask("Summarize the key takeaways.")
        self.ask("Summarize the key takeaways.")
        self.assertEqual(len(self.provider.calls), 3)

    def test_a_streamed_summary_shows_text_as_it_is_written(self):
        self.model(self.SUMMARY)
        events = self.stream("Summarize the key takeaways.")
        deltas = [e["text"] for e in events if e["type"] == "delta"]
        self.assertTrue(deltas and deltas[0].startswith("The report explains that OCR"))
        self.assertNotIn("[C", "".join(deltas))
        self.assertEqual(len(events[-1]["response"]["sources"]), 3)


class ProviderStreamTest(unittest.TestCase):
    def chunk(self, text=None, finish=None, empty=False):
        choice = SimpleNamespace(delta=SimpleNamespace(content=text), finish_reason=finish)
        return SimpleNamespace(choices=[] if empty else [choice])

    def provider(self, chunks):
        p = ChatProvider.__new__(ChatProvider)
        p.chat_model, p.reasoning_effort = "m", None
        p._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=Mock(return_value=iter(chunks)))))
        return p

    def test_pieces_are_delivered_and_joined(self):
        p = self.provider([self.chunk(empty=True), self.chunk("Hel"), self.chunk("lo"), self.chunk(None, "stop")])
        seen = []
        self.assertEqual(p.complete_messages([{"role": "user", "content": "x"}], on_delta=seen.append), "Hello")
        self.assertEqual(seen, ["Hel", "Hello"])
        self.assertTrue(p._client.chat.completions.create.call_args.kwargs["stream"])

    def test_a_filter_stop_mid_answer_is_a_content_filter_error(self):
        p = self.provider([self.chunk("Partial"), self.chunk(None, "content_filter")])
        with self.assertRaises(ContentFilterError):
            p.complete_messages([{"role": "user", "content": "x"}], on_delta=lambda t: None)

    def test_without_on_delta_nothing_streams(self):
        p = ChatProvider.__new__(ChatProvider)
        p.chat_model, p.reasoning_effort = "m", None
        create = Mock(return_value=SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="Whole"))]))
        p._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        self.assertEqual(p.complete_messages([{"role": "user", "content": "x"}]), "Whole")
        self.assertNotIn("stream", create.call_args.kwargs)


if __name__ == "__main__":
    unittest.main()


def test_quote_specific_ids_never_leak_into_streamed_text():
    from APP.rag.streaming import StreamGate
    gate = StreamGate(json_mode=True, evidence=('Split the points.',))
    raw = json.dumps({'answer': 'Split the points. [E12]\nThen continue. [E2]',
                      'citations': [{'id': 'E12', 'passage_id': 'C1', 'quote': 'Split the points.'}]})
    outputs = [gate.feed(raw[:i]) for i in range(1, len(raw) + 1)]
    assert all('[E' not in text for text in outputs if text)
    assert gate.shown == 'Split the points.\nThen continue.'
