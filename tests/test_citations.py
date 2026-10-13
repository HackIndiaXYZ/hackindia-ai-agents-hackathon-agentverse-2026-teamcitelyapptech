"""Citations must point at the passage that supports the answer.

Before offsets existed a citation could only name a page, so the reader had no
choice but to highlight the whole page and every retrieved chunk looked like
the same citation. These tests pin the behaviour that fixed it.
"""

import unittest

from langchain_core.documents import Document

from APP.rag.chunking import EXTRACTION_VERSION, assign_page_offsets, build_page_texts
from APP.rag.service import merge_overlapping_citations
from APP.schemas import SourceChunk

PAGE = (
    "Citely Integration Test Document\n\n"
    "Revenue increased by 24% this year, driven primarily by expansion within\n"
    "enterprise accounts. Enterprise customers represented 62% of total revenue.\n\n"
    "Operating cash flow was 8.4 million dollars, compared with 6.1 million in\n"
    "the previous year.\n\n"
    "The principal planning risks are slower enterprise purchase cycles."
)


def chunk(text: str, page: int = 1) -> Document:
    return Document(page_content=text, metadata={"page": page})


class PageOffsetTests(unittest.TestCase):
    def setUp(self):
        self.pages = build_page_texts([chunk(PAGE)])

    def test_offsets_select_only_the_chunk_text(self):
        # A chunk re-joined across line breaks still resolves to its exact span.
        c = chunk("Revenue increased by 24% this year, driven primarily by expansion within "
                  "enterprise accounts. Enterprise customers represented 62% of total revenue.")
        assign_page_offsets(self.pages, [c])
        start, end = c.metadata["page_char_start"], c.metadata["page_char_end"]
        selected = PAGE[start:end]
        self.assertTrue(selected.startswith("Revenue increased by 24%"))
        self.assertTrue(selected.rstrip().endswith("62% of total revenue."))
        # The whole page must never be the answer to "where is this passage".
        self.assertLess(end - start, len(PAGE))

    def test_distinct_chunks_get_distinct_spans(self):
        first = chunk("Revenue increased by 24% this year")
        second = chunk("The principal planning risks are slower enterprise purchase cycles.")
        assign_page_offsets(self.pages, [first, second])
        self.assertNotEqual(
            (first.metadata["page_char_start"], first.metadata["page_char_end"]),
            (second.metadata["page_char_start"], second.metadata["page_char_end"]),
        )

    def test_whitespace_differences_still_resolve(self):
        c = chunk("The principal    planning\nrisks are slower enterprise purchase cycles.")
        assign_page_offsets(self.pages, [c])
        self.assertIn("planning risks", PAGE[c.metadata["page_char_start"]:c.metadata["page_char_end"]])

    def test_unlocatable_chunk_leaves_offsets_unset(self):
        # Never fall back to 0..len: that is what highlighted whole documents.
        c = chunk("text that does not appear on this page at all")
        assign_page_offsets(self.pages, [c])
        self.assertIsNone(c.metadata.get("page_char_start"))
        self.assertIsNone(c.metadata.get("page_char_end"))
        self.assertTrue(c.metadata["extraction_version"].startswith(EXTRACTION_VERSION + ':'))

    def test_repeated_text_resolves_in_document_order(self):
        pages = build_page_texts([chunk("Alpha repeated. Beta. Alpha repeated.")])
        first, second = chunk("Alpha repeated."), chunk("Alpha repeated.")
        assign_page_offsets(pages, [first, second])
        self.assertLess(first.metadata["page_char_start"], second.metadata["page_char_start"])


def source(cid, start, end, score, page=1, document_id="doc-1") -> SourceChunk:
    text = "x" * (end - start) if start is not None else "x"
    return SourceChunk(
        citation_id=cid, content=text, quote=text, page=page, score=score,
        document_id=document_id, page_char_start=start, page_char_end=end,
    )


class CitationMergeTests(unittest.TestCase):
    def test_overlapping_chunks_collapse_to_one_citation(self):
        merged = merge_overlapping_citations([
            source("a", 0, 100, 0.9), source("b", 10, 105, 0.8), source("c", 5, 95, 0.5),
        ])
        self.assertEqual(len(merged), 1)
        # Keep a real passage; never grow chained unions beyond its quote.
        self.assertEqual((merged[0].page_char_start, merged[0].page_char_end), (0, 100))
        self.assertEqual(merged[0].score, 0.9)

    def test_separate_passages_stay_separate(self):
        merged = merge_overlapping_citations([source("a", 0, 100, 0.9), source("b", 400, 500, 0.8)])
        self.assertEqual(len(merged), 2)

    def test_same_offsets_on_different_pages_never_merge(self):
        merged = merge_overlapping_citations([
            source("a", 0, 100, 0.9), source("b", 0, 100, 0.8, page=2),
        ])
        self.assertEqual(len(merged), 2)

    def test_same_offsets_in_different_documents_never_merge(self):
        merged = merge_overlapping_citations([
            source("a", 0, 100, 0.9), source("b", 0, 100, 0.8, document_id="doc-2"),
        ])
        self.assertEqual(len(merged), 2)

    def test_citations_without_offsets_are_never_merged_away(self):
        # Unknown location is not evidence of being the same passage.
        unknown_a = SourceChunk(content="a", quote="a", page=1, score=0.4, document_id="doc-1")
        unknown_b = SourceChunk(content="b", quote="b", page=1, score=0.3, document_id="doc-1")
        merged = merge_overlapping_citations([unknown_a, unknown_b])
        self.assertEqual(len(merged), 2)
        self.assertTrue(all(s.page_char_start is None for s in merged))

    def test_every_citation_carries_a_stable_id(self):
        merged = merge_overlapping_citations([source("a", 0, 50, 0.9), source("b", 400, 450, 0.8)])
        self.assertEqual(len({s.citation_id for s in merged}), 2)


if __name__ == "__main__":
    unittest.main()
