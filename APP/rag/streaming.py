"""Showing an answer while it is being written, safely.

The model's reply arrives a few characters at a time. What the reader sees
is held back to whole lines and sentences, and every piece passes the same
output safety check as a finished answer before it is shown, so a leak can
never be half-shown and then withdrawn. If a piece fails, nothing more is
shown and the reader gets the checked final answer only. The final answer
(evidence check, citations) is always the one that is kept.
"""

from __future__ import annotations

import json
import re

from APP.security import validate_output

_MARKER = re.compile(r"\s*\[(?:C|E)\d+\]")
_PARTIAL_MARKER = re.compile(r"\s*\[(?:C|E)?\d*$")
# The last place it is safe to cut: after a line, or after a sentence's end.
_BOUNDARY = re.compile(r"\n|[.!?:;](?=\s)")


def json_answer_so_far(raw: str) -> str | None:
    """The "answer" string of a JSON reply that is still being written, as
    far as it has been written. None until the answer has started, or when
    the reply says there is no evidence (that answer is replaced anyway)."""
    found = _json_answer(raw)
    return found[0] if found else None


def _json_answer(raw: str) -> tuple[str, bool] | None:
    """(answer so far, whether its closing quote has arrived)."""
    status = re.search(r'"answer_status"\s*:\s*"([a-z_]*)"', raw)
    if status and status.group(1) == "insufficient_evidence":
        return None
    start = re.search(r'"answer"\s*:\s*"', raw)
    if not start:
        return None
    out, i = [], start.end()
    while i < len(raw):
        ch = raw[i]
        if ch == '"':
            return "".join(out), True
        if ch == "\\":
            if i + 1 >= len(raw):
                break
            nxt = raw[i + 1]
            if nxt == "u":
                if i + 6 > len(raw):
                    break
                try:
                    out.append(json.loads(f'"{raw[i:i + 6]}"'))
                except ValueError:
                    break
                i += 6
                continue
            out.append({"n": "\n", "t": "\t", "r": "", '"': '"', "\\": "\\", "/": "/", "b": "", "f": ""}.get(nxt, nxt))
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out), False


class StreamGate:
    """Turns the growing raw reply into the text a reader may see so far."""

    def __init__(self, *, json_mode: bool, evidence: tuple[str, ...]):
        self.json_mode = json_mode
        self.evidence = evidence
        self.shown = ""
        self.blocked = False

    def feed(self, raw: str) -> str | None:
        """The text to show now, or None when nothing new may be shown."""
        if self.blocked:
            return None
        complete = False
        if self.json_mode:
            found = _json_answer(raw)
            text, complete = found if found else (None, False)
        else:
            text = None if raw.lstrip().startswith(("{", "`")) else raw
        if not text:
            return None
        cut = len(text) if complete else None
        for match in ([] if complete else _BOUNDARY.finditer(text)):
            cut = match.end()
        if cut is None:
            return None
        visible = _PARTIAL_MARKER.sub("", _MARKER.sub("", text[:cut])).rstrip()
        if len(visible) <= len(self.shown):
            return None
        if validate_output(visible, source_texts=self.evidence) != visible:
            self.blocked = True
            return None
        self.shown = visible
        return visible
