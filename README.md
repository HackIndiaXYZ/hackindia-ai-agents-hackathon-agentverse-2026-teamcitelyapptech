# Citely

Ask questions of your own documents and get answers that point to the exact passage they came from.
Upload a PDF, Word, PowerPoint or Excel file, ask in plain language, and every claim in the answer links
to its source. Clicking a citation opens the original document and highlights that passage.

Built by TeamCitelyapp.Tech for HackIndia AI Agents Hackathon (AgentVerse 2026).

[hackindia-team:hackindia-ai-agents-hackathon-agentverse-2026:teamcitelyapptech]

## What it does

- **Cited answers.** Retrieval-augmented answers over large documents. Each answer is checked against the
  retrieved passages; an answer that cannot be verified is reported as such instead of being shown as fact.
- **Original viewers.** PDFs, Word, PowerPoint and Excel open as their real pages, with the cited passage
  highlighted. Pictures read from scanned pages are marked as regions of the page.
- **Streaming notebook-style answers**, summaries with precise citations, notes, and saved highlights.
- **Many formats.** PDF, DOCX, PPTX, XLSX, CSV, TXT, MD and JSON, with a parser per type.
- **Safety.** Prompt-injection guardrails, per-user limits, and an admin console for access requests.

## Layout

| Path | What |
|---|---|
| `APP/` | FastAPI backend: ingestion and parsers (`parsers/`), retrieval and answering (`rag/`), picture/evidence extraction (`extraction/`), auth, security guardrails |
| `Citely-Modernist-Next-Final/` | Next.js (static export) frontend and the document viewers |
| `prompts/` | The prompts used for answering and query rewriting |
| `tests/` | Backend tests (no network or API keys needed) |
| `eval/` | Answer-quality evaluation scripts |
| `docker/`, `docker-compose.yml` | Container build and local stack (API + Qdrant) |

## Run it locally

Backend (Python 3.11):

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-api.txt
cp .env.example .env        # then fill in your own keys; never commit .env
uvicorn APP.main:app --port 8000
```

Frontend:

```bash
cd Citely-Modernist-Next-Final
npm ci
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000 npm run dev
```

The vector store is Qdrant (`docker compose up qdrant`). `.env.example` lists every setting; picture reading
is off by default and has spending caps when turned on.

## Tests

```bash
python -m unittest discover -s tests            # backend
cd Citely-Modernist-Next-Final && npm test && npm run typecheck && npm run test:browser
```

## License

See [LICENSE](LICENSE).
