"""What kind of question this is, decided without a model call.

- Is it about the document as a whole ("summarise this", "key points")?
  Those can't be answered from the few passages that happen to match the
  question's words, so the document is read from start to end instead, and
  the model writes the summary itself (citing the passages it drew on).
- How long an answer was asked for, so the model is given room to write it.

How the answer looks (bullets of any kind, numbers, a table, paragraphs, a
word count) is left to the model, which follows what the question asks. Only
the facts are fixed: they come from the uploaded sources.
"""

from __future__ import annotations

import re

MAX_WORDS = 1500

_OVERVIEW = re.compile(
    r"\b(?:summar(?:y|ise|ize|ies|ising|izing)|overview|tl;?dr|synopsis|abstract|gist|recap|"
    r"(?:key|main|major|important|core) (?:points?|takeaways?|findings?|ideas?|themes?|conclusions?|highlights?|messages?)|"
    r"highlights|takeaways|"
    r"what(?:'s| is| are) (?:this|the|that) (?:document|doc|file|report|paper|deck|presentation|sheet|spreadsheet|pdf|article|text)(?: about)?|"
    r"what (?:does|do) (?:this|the|that) (?:document|doc|file|report|paper|deck|presentation|sheet|spreadsheet|pdf|article) "
    r"(?:say|cover|contain|discuss|describe|talk about)|"
    r"(?:explain|describe|walk me through|go through) (?:this|the|that) (?:document|doc|file|report|paper|deck|presentation|sheet|spreadsheet|pdf|article))\b",
    re.I)

_WORDS = re.compile(r"(?P<n>\d{2,4})[\s-]*words?\b", re.I)


def is_overview(question: str) -> bool:
    """A question about the document as a whole, not about one thing in it."""
    return bool(_OVERVIEW.search(question or ""))


def requested_words(question: str) -> int | None:
    """The word count a question asks for ("in about 300 words"), if any."""
    found = _WORDS.search(question or "")
    return min(MAX_WORDS, int(found.group("n"))) if found else None


def max_tokens(question: str, default: int) -> int:
    """Room for the answer asked for: about 1.4 tokens a word, plus citations."""
    words = requested_words(question)
    return min(4500, max(default, int(words * 1.6) + 600)) if words else default


def spread_indices(total: int, pick: int) -> list[int]:
    """`pick` positions spread evenly from the first to the last of `total`
    (both ends always included), in order and without repeats."""
    if total <= 0 or pick <= 0:
        return []
    if pick >= total:
        return list(range(total))
    if pick == 1:
        return [0]
    return sorted({round(i * (total - 1) / (pick - 1)) for i in range(pick)})
