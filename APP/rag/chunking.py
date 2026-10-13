import os
import json
import hashlib
from langchain_core.documents import Document
from pathlib import Path

from APP.rag.structure_chunking import structure_aware_split

# structure = split on the document's own headings (default).
# recursive = fixed-size character splitting, the fallback.
#
# Semantic chunking (LangChain's SemanticChunker) was removed: it embedded
# every sentence to locate topic breakpoints, which cost 7m28s on a 44-page
# PDF against the recursive splitter's 1m31s — and exceeded Azure Container
# Apps' ~240s ingress timeout — for a retrieval benefit that was never
# demonstrated. Headings already mark topic boundaries and cost no model call.
CHUNKING_STRATEGY = os.getenv("CHUNKING_STRATEGY", "structure").strip().lower()

try:
    from langchain_text_splitters import RecursiveCharacterTextSplitter
except Exception:
    RecursiveCharacterTextSplitter = None


def _recursive_splitter_factory(chunk_size: int, chunk_overlap: int):
    def build():
        if RecursiveCharacterTextSplitter is None:
            raise RuntimeError("RecursiveCharacterTextSplitter not available; cannot chunk documents.")
        return RecursiveCharacterTextSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            separators=["\n\n", "\n", ". ", " ", ""],
            length_function=len,
            is_separator_regex=False,
        )
    return build


def chunk_documents(
    documents: list[Document],
    chunk_size: int = 1000,
    chunk_overlap: int = 150,
) -> list[Document]:
    factory = _recursive_splitter_factory(chunk_size, chunk_overlap)

    if CHUNKING_STRATEGY == "structure":
        chunks = structure_aware_split(documents, chunk_size, chunk_overlap, factory)
        if chunks:
            sectioned = sum(1 for c in chunks if c.metadata.get("section"))
            print(f"✅ Structure-aware chunking: {len(chunks)} chunks, {sectioned} carry a section heading")
        else:
            # No headings found at all (e.g. a flat text dump) — the recursive
            # splitter still produces usable chunks, so degrade rather than fail.
            print("⚠️ Structure-aware chunking produced nothing; falling back to RecursiveCharacterTextSplitter")
            chunks = factory().split_documents(documents)
    else:
        chunks = factory().split_documents(documents)
        print(f"✅ Recursive character chunking: {len(chunks)} chunks")

    for i, chunk in enumerate(chunks):
        chunk.metadata["chunk_id"]   = i
        chunk.metadata["chunk_size"] = len(chunk.page_content)

    assign_page_offsets(build_page_texts(documents), chunks)

    sizes = [len(c.page_content) for c in chunks]
    print(f"   Total chunks : {len(chunks)}")
    print(f"   Strategy     : {CHUNKING_STRATEGY}")
    print(f"   Chunk size   : {chunk_size} chars (overlap: {chunk_overlap})")
    if sizes:
        print(f"   Avg size     : {sum(sizes) // len(sizes)} chars")
        print(f"   Min size     : {min(sizes)} chars")
        print(f"   Max size     : {max(sizes)} chars")
    return chunks


def finalize_native_chunks(documents: list[Document]) -> list[Document]:
    """Chunks a native parser produced directly: numbered and located in their
    pages exactly as chunk_documents would, but never re-split."""
    chunks = [Document(page_content=d.page_content, metadata=dict(d.metadata)) for d in documents]
    for i, chunk in enumerate(chunks):
        chunk.metadata["chunk_id"] = i
        chunk.metadata["chunk_size"] = len(chunk.page_content)
    assign_page_offsets(build_page_texts(documents), chunks)
    return chunks


# Bumped whenever extraction or chunking changes in a way that moves character
# offsets. Saved annotations carry the version they were created against, so a
# reprocessed document can relocate them by quote instead of silently pointing
# at the wrong text.
EXTRACTION_VERSION = "1"


def extraction_version(page_texts: dict[int, str]) -> str:
    digest = hashlib.sha256(json.dumps(page_texts, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]
    return f"{EXTRACTION_VERSION}:{digest}"


def build_page_texts(documents: list[Document]) -> dict[int, str]:
    """The authoritative extracted text for each page.

    This exact string is what the viewer renders and what every character
    offset is measured against, so it is built once here and stored verbatim.
    """
    pages: dict[int, str] = {}
    for document in documents:
        try:
            page = int(document.metadata.get("page", 1) or 1)
        except (TypeError, ValueError):
            page = 1
        pages[page] = f"{pages[page]}\n{document.page_content}" if page in pages else document.page_content
    return pages


def _normalise_with_map(text: str) -> tuple[str, list[int]]:
    """Collapse whitespace runs to single spaces, keeping a map back to the
    original indices. Chunkers re-join lines and strip edges, so a chunk rarely
    matches its page byte-for-byte — but it always matches once both sides are
    normalised this way."""
    out: list[str] = []
    index_map: list[int] = []
    previous_space = False
    for index, character in enumerate(text):
        if character.isspace():
            if previous_space:
                continue
            out.append(" ")
            index_map.append(index)
            previous_space = True
        else:
            out.append(character)
            index_map.append(index)
            previous_space = False
    return "".join(out), index_map


def assign_page_offsets(page_texts: dict[int, str], chunks: list[Document]) -> None:
    """Record where each chunk sits inside its page's extracted text.

    Without this a citation can only say "page 4", which forces the reader to
    highlight the whole page. Chunks are located in order with a per-page
    cursor so repeated text resolves to the occurrence the chunk actually came
    from. A chunk that cannot be located leaves its offsets unset rather than
    guessing — callers must treat that as "exact location unavailable".
    """
    normalised: dict[int, tuple[str, list[int]]] = {
        page: _normalise_with_map(text) for page, text in page_texts.items()
    }
    cursors: dict[int, int] = {}
    version = extraction_version(page_texts)

    for chunk in chunks:
        try:
            page = int(chunk.metadata.get("page", 1) or 1)
        except (TypeError, ValueError):
            page = 1

        chunk.metadata["extraction_version"] = version
        entry = normalised.get(page)
        if not entry:
            continue

        haystack, index_map = entry
        needle, _ = _normalise_with_map(chunk.page_content)
        needle = needle.strip()
        if not needle:
            continue

        cursor = cursors.get(page, 0)
        found = haystack.find(needle, cursor)
        if found == -1:
            candidate = haystack.find(needle)
            if candidate >= 0 and haystack.find(needle, candidate + 1) == -1:
                found = candidate
        if found == -1:
            # Truncated or re-wrapped beyond recognition (a merged section, an
            # OCR retry). Leave the offsets unset so the reader shows an
            # honest "location unavailable" instead of the whole page.
            continue

        end = found + len(needle) - 1
        chunk.metadata["page_char_start"] = index_map[found]
        chunk.metadata["page_char_end"] = index_map[end] + 1
        cursors[page] = found + 1


def save_chunks_jsonl(chunks: list[Document], output_path: str) -> None:
    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as f:
        for chunk in chunks:
            record = {
                "page_content": chunk.page_content,
                "metadata": chunk.metadata,
            }
            f.write(json.dumps(record, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    import argparse
    from APP.rag.pdf_loading import load_pdf

    def choose_pdf() -> Path:
        pdf_dir = Path("data")
        pdfs = sorted(pdf_dir.glob("*.pdf"))
        if not pdfs:
            raise FileNotFoundError("No PDFs found in the data folder.")

        print("Available PDFs:")
        for idx, pdf in enumerate(pdfs, start=1):
            print(f"  {idx}. {pdf.name}")

        selection = input("Select a PDF number (or press Enter to cancel): ").strip()
        if not selection:
            raise SystemExit("Cancelled.")

        try:
            return pdfs[int(selection) - 1]
        except (ValueError, IndexError):
            raise SystemExit("Invalid selection.")

    parser = argparse.ArgumentParser(description="Load a PDF, chunk it, and save the result.")
    parser.add_argument("pdf_path", nargs="?", help="Path to the PDF file")
    parser.add_argument("--output", type=str, default="data/chunks/chunks.jsonl", help="Path to save chunks as JSONL")
    args = parser.parse_args()

    pdf_path = Path(args.pdf_path) if args.pdf_path else choose_pdf()

    documents = load_pdf(str(pdf_path))
    chunks = chunk_documents(documents)

    save_chunks_jsonl(chunks, args.output)
    print(f"Saved chunks to {args.output}")
