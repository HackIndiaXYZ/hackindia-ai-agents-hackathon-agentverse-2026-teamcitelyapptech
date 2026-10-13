"""Which questions are about the whole document, and how much room to give."""

import unittest

from APP.rag import answer_style as s


class OverviewTest(unittest.TestCase):
    def test_whole_document_questions(self):
        for q in ("give me a detailed summary of this research report in about 300 words with key points", "Summarize the document",
                  "Summarize the key takeaways.", "what is this document about?", "main points please", "tl;dr",
                  "overview of the paper", "explain this report", "what does this deck cover", "highlights?", "Key points"):
            with self.subTest(q):
                self.assertTrue(s.is_overview(q))

    def test_specific_questions_are_not(self):
        for q in ("what was the revenue in 2024", "who is the author", "how does the OCR step work", "what is the refund policy",
                  "define precision", "which risks are mentioned for vendor B", "list the OCR tools in a table"):
            with self.subTest(q):
                self.assertFalse(s.is_overview(q))


class RoomTest(unittest.TestCase):
    def test_words_asked_for(self):
        self.assertEqual(s.requested_words("summarise in about 300 words"), 300)
        self.assertEqual(s.requested_words("a 200-word summary"), 200)
        self.assertIsNone(s.requested_words("what happened in 2024"))
        self.assertEqual(s.requested_words("in 9000 words"), s.MAX_WORDS)

    def test_room_grows_with_the_length_asked_for(self):
        self.assertEqual(s.max_tokens("what is x", 1200), 1200)
        self.assertGreater(s.max_tokens("in 800 words", 1200), 1300)
        self.assertLessEqual(s.max_tokens("in 1500 words", 1200), 3000)


class SpreadTest(unittest.TestCase):
    def test_even_spread_includes_both_ends(self):
        self.assertEqual(s.spread_indices(100, 5), [0, 25, 50, 74, 99])
        self.assertEqual(s.spread_indices(10, 20), list(range(10)))
        self.assertEqual(s.spread_indices(7, 1), [0])
        self.assertEqual(s.spread_indices(0, 5), [])

    def test_ordered_and_unique(self):
        for total in (3, 17, 250):
            for pick in (2, 6, 40):
                got = s.spread_indices(total, pick)
                self.assertEqual(got, sorted(set(got)))
                self.assertEqual((got[0], got[-1]), (0, total - 1))


if __name__ == "__main__":
    unittest.main()
