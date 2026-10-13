"""Answer/citation regression for spreadsheets and slide decks.

Runs the real ingest and answer pipeline (parser router, chunking, bge-m3,
hybrid retrieval, reranker, the configured chat model, evidence validation)
over the synthetic fixtures in tests/fixtures/regression, entirely offline
from shared state: Qdrant is in-memory, the database and document files live
in a temporary directory, and Redis is disabled. Only Azure Document
Intelligence and the chat model are called.

    .venv/bin/python scripts/office_regression.py --out /tmp/native.json \\
        --compare tests/fixtures/regression/baseline.json

A case passes when the expected unit is retrieved, the answer contains every
expected fact, and — when the document carries native anchors — one of the
answer's citations resolves to the expected sheet/cell or slide/shape.
`--compare` exits non-zero if any case that passed in the baseline fails now.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
FIXTURES = REPO / "tests" / "fixtures" / "regression"


def _load_vendor_keys() -> None:
    """Only the two vendors this harness may call. Everything that could
    reach shared state (Qdrant, Redis) is pinned to inert values first, and
    load_dotenv elsewhere never overrides a variable that is already set."""
    os.environ.update({
        "QDRANT_URL": "http://127.0.0.1:9", "QDRANT_API_KEY": "", "QDRANT_COLLECTION": "office_regression",
        "REDIS_URL": "", "ORIGINALS_ENABLED": "false",
    })
    env = REPO / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            key, _, value = line.partition("=")
            key = key.strip()
            if key.startswith(("AZURE_OPENAI_", "AZURE_DOC_INTEL_")) and key not in os.environ:
                os.environ[key] = value.strip().strip('"').strip("'")


def _norm(text: str) -> str:
    text = (text or "").lower().replace(" ", " ").replace(" ", " ")
    text = re.sub(r"(?<=\d),(?=\d{3})", "", text)
    text = re.sub(r"\s+%", "%", text)
    return re.sub(r"\s+", " ", text)


def _has_facts(text: str, facts: list[list[str]]) -> bool:
    haystack = _norm(text)
    return all(any(_norm(option) in haystack for option in options) for options in facts)


def _cell_in_range(cell: str, a1_range: str) -> bool:
    from openpyxl.utils.cell import range_boundaries
    c_col, c_row, _, _ = range_boundaries(cell)
    min_col, min_row, max_col, max_row = range_boundaries(a1_range)
    return min_col <= c_col <= max_col and min_row <= c_row <= max_row


def _anchor_hits(anchor: dict | None, target: dict) -> bool:
    if not anchor:
        return False
    if "cell" in target:
        return (anchor.get("format") == "xlsx" and anchor.get("sheet_name") == target["sheet_name"]
                and bool(anchor.get("range")) and _cell_in_range(target["cell"], anchor["range"]))
    if anchor.get("format") != "pptx":
        return False
    if anchor.get("slide_index") != target["slide_index"] or anchor.get("shape_id") != target["shape_id"]:
        return False
    return "row" not in target or anchor.get("row") == target["row"]


def run(out: Path) -> dict:
    _load_vendor_keys()
    workdir = Path(tempfile.mkdtemp(prefix="office-regression-"))
    os.chdir(workdir)
    sys.path.insert(0, str(REPO))

    from qdrant_client import QdrantClient

    from APP import db
    from APP.rag.service import RAGService
    from APP.rag.vector_store import hybrid_retrieve
    from APP.schemas import QueryRequest

    db.init_db()
    owner = db.create_user("regression@example.invalid", email_verified=True)
    service = RAGService()
    service.qdrant = QdrantClient(":memory:")

    spec = json.loads((FIXTURES / "cases.json").read_text())
    ingested: dict[str, dict] = {}
    for key, name in spec["files"].items():
        result = service.ingest(owner, name, (FIXTURES / name).read_bytes(),
                                chunk_size=1000, chunk_overlap=150, quality_threshold=4.0)
        ingested[key] = {"document_id": result.document_id, "parser": result.parser_used,
                         "pages": result.pages, "chunks": result.indexed_chunks}
        print(f"ingested {name}: parser={result.parser_used} pages={result.pages} chunks={result.indexed_chunks}")

    results = []
    for case in spec["cases"]:
        doc_id = ingested[case["file"]]["document_id"]
        with db._connect() as conn:  # each case starts a fresh conversation
            conn.execute("DELETE FROM chat_turns WHERE document_id = ?", (doc_id,))
        vectorstore, bm25, chunks = service._load_document_artifacts(doc_id, owner)
        retrieved = hybrid_retrieve(query=case["question"], vectorstore=vectorstore, bm25=bm25, chunks=chunks, top_n=4)
        native = any(doc.metadata.get("native_anchor") for doc, _ in retrieved) or any(
            c.metadata.get("native_anchor") for c in chunks)
        if native:
            retrieved_ok = any(_anchor_hits(doc.metadata.get("native_anchor"), case["target"]) for doc, _ in retrieved)
        else:
            retrieved_ok = any(_has_facts(doc.page_content, case["facts"]) for doc, _ in retrieved)

        response = service.answer(owner, QueryRequest(document_id=doc_id, question=case["question"], top_k=4))
        answer_ok = _has_facts(response.answer, case["facts"])
        anchors = [getattr(s, "anchor", None) for s in response.sources]
        cited_ok = any(_anchor_hits(a, case["target"]) for a in anchors) if native else None
        passed = retrieved_ok and answer_ok and (cited_ok is not False)
        results.append({"id": case["id"], "passed": passed, "retrieved": retrieved_ok, "answer": answer_ok,
                        "cited": cited_ok, "answer_text": response.answer[:400],
                        "citations": [a for a in anchors if a]})
        print(f"{case['id']}: {'PASS' if passed else 'FAIL'} retrieved={retrieved_ok} answer={answer_ok} cited={cited_ok}")

    report = {"files": ingested, "passed": sum(r["passed"] for r in results), "total": len(results), "cases": results}
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(f"{report['passed']}/{report['total']} passed → {out}")
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--compare", type=Path, help="baseline report; fail if any case that passed there fails now")
    args = parser.parse_args()
    out = args.out.resolve()
    baseline = json.loads(args.compare.resolve().read_text()) if args.compare else None
    report = run(out)
    if baseline is None:
        return 0
    before = {c["id"]: c["passed"] for c in baseline["cases"]}
    regressed = [c["id"] for c in report["cases"] if before.get(c["id"]) and not c["passed"]]
    failing = [c["id"] for c in report["cases"] if not c["passed"]]
    print("regressed vs baseline:", regressed or "none")
    print("failing:", failing or "none")
    return 1 if regressed or failing else 0


if __name__ == "__main__":
    raise SystemExit(main())
