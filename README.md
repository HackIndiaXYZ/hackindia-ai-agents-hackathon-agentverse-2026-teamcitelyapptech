<div align="center">

<img src="docs/readme/citely-intro.gif" alt="Animated introduction: the Citely mark builds, then the stack appears by layer — interface, API, retrieval, generation, delivery — beside the flow from your files to the exact passage." width="100%">

<h3>Grounded answers, cited.</h3>

<p>Ask a question, follow its citation, and keep the thinking that matters.</p>

<a href="https://citelyapp.tech/"><img src="docs/readme/cta-explore.svg" alt="Explore Citely → https://citelyapp.tech/" height="52"></a>

<p><sub>Public preview with prepared sample files · Product access by request</sub></p>

<img src="docs/readme/badges/nextjs-15.svg" alt="Next.js 15" height="28"> <img src="docs/readme/badges/react-19.svg" alt="React 19" height="28"> <img src="docs/readme/badges/typescript.svg" alt="TypeScript" height="28"> <img src="docs/readme/badges/fastapi.svg" alt="FastAPI" height="28"> <img src="docs/readme/badges/python.svg" alt="Python" height="28"><br>
<img src="docs/readme/badges/qdrant.svg" alt="Qdrant" height="28"> <img src="docs/readme/badges/bm25.svg" alt="BM25" height="28"> <img src="docs/readme/badges/bge-m3.svg" alt="bge-m3" height="28"> <img src="docs/readme/badges/rrf-and-flashrank.svg" alt="RRF + FlashRank" height="28"> <img src="docs/readme/badges/azure-openai.svg" alt="Azure OpenAI" height="28"><br>
<img src="docs/readme/badges/azure-container-apps.svg" alt="Azure Container Apps" height="28"> <img src="docs/readme/badges/github-pages.svg" alt="GitHub Pages" height="28"> <img src="docs/readme/badges/sqlite.svg" alt="SQLite" height="28">

<p><a href="#the-experience">Experience</a> · <a href="#the-product-as-a-skeleton">Skeleton</a> · <a href="#the-pipeline">Pipeline</a> · <a href="#behind-the-product">Posters</a> · <a href="#engineering-map">Engineering</a> · <a href="#local-development">Development</a></p>

</div>

---

## The experience

Citely brings a document library, conversation, source reader, citations, highlights, and working notes into one workspace. It retrieves relevant document content before generating an answer and carries source locations back to the reader so the evidence can be inspected.

<img src="docs/readme/citely-film-evidence.gif" alt="Product film excerpt: a question is typed, the answer arrives with a citation, and the citation opens the original page with the exact passage highlighted." width="100%">

<a href="https://citelyapp.tech/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="Citely-Modernist-Next-Final/public/screenshots/workspace-dark.jpg">
    <img src="Citely-Modernist-Next-Final/public/screenshots/workspace-light.jpg" alt="Citely workspace product screenshot showing conversation and document reader" width="100%">
  </picture>
</a>

*Product screenshot. Click to visit the public site. Sample content illustrates the workflow.*

| Start with a file | Follow the evidence | Keep your work |
| :--- | :--- | :--- |
| Organize files and folders, then open a document or collection for chat. | Open a citation, navigate to its source, and inspect the located passage. | Save citations, make manual highlights, and maintain revisioned working notes. |
| Upload progress tracks processing before a document is ready. | Valid page-relative offsets highlight the exact text range. | Stale note updates surface a conflict; earlier revisions can be restored. |

### Two ways to explore

**Public demo.** A guided, interactive sample workspace uses prepared files and responses. Visitors can explore the flow without uploading personal documents or making model/API calls for demo answers. Its entry notice explains the synthetic data, and “Back to Citely” returns to the public site in the same tab.

**Approved account.** The real product connects authenticated users to document processing, retrieval, generation, and persistence. Access is requested through the public site; existing approved users retain their separate sign-in flow.

### Precision is part of the interface

- **Citations:** valid `page_char_start` / `page_char_end` offsets locate a passage. Missing or invalid offsets do not trigger a whole-page highlight; the UI reports that the precise passage location is unavailable.
- **Manual highlights:** selections across adjacent text nodes become page-relative ranges. Selections across pages are rejected.
- **Saved evidence:** quote, document, conversation, page, range, and extraction version retain the context needed to locate a saved annotation.
- **Notes:** revision checks surface `409` conflicts instead of silently replacing a newer version. History and restore support revisiting previous work.
- **Readers:** PDF and extracted-text flows coexist with native Office viewers. Word, Excel, and PowerPoint uploads open in their original readers — Excel citations land on cells, PowerPoint citations on the exact text in a slide shape. Files uploaded before originals were kept stay in the extracted-text view.

---

## The product, as a skeleton

One loop through the workspace, stripped to its structure.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/product-skeleton-dark.svg">
  <img src="docs/readme/product-skeleton-light.svg" alt="Animated skeleton of the Citely workspace: a file is selected in the library, a question is asked, the answer arrives with a citation, the reader highlights the exact range, and the citation is kept with a revisioned note." width="100%">
</picture>

| | Step | What the interface does |
| :---: | :--- | :--- |
| **1** | Pick a source | A document or collection from the library becomes the chat context. |
| **2** | Ask | The question goes to retrieval before any answer is generated. |
| **3** | Read the answer | Citations come back with resolvable source locations. |
| **4** | Follow a citation | The reader opens the source and renders the exact valid range. |
| **5** | Keep the work | Citations, highlights, and revisioned notes persist through the API. |

---

## The pipeline

Ingestion and question-time work are separate paths. Source identity and location connect them.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/pipeline-skeleton-dark.svg">
  <img src="docs/readme/pipeline-skeleton-light.svg" alt="Animated pipeline: a file moves through upload, parse, chunk and index into Qdrant and the BM25 store; a question then moves through retrieve, rank, answer and return, ending on a highlighted exact passage." width="100%">
</picture>

**Open any stage** to see what happens inside it.

<details>
<summary><b>01 · Upload</b> — authenticated intake records the file and its processing state</summary>
<br>
<img src="docs/readme/stages/01-upload.svg" alt="Upload stage animation" width="100%">

- **What happens:** authenticated intake records the file and processing state.
- **Carries forward:** owner and document identity.
- **Where to look:** `APP/auth/`, `APP/main.py`
</details>

<details>
<summary><b>02 · Parse</b> — format-aware extraction</summary>
<br>
<img src="docs/readme/stages/02-parse.svg" alt="Parse stage animation" width="100%">

- **What happens:** format-aware extraction routes through configured local and optional external parsers.
- **Carries forward:** text, pages, and available structural anchors.
- **Where to look:** `APP/parsers/` (parser routing, native Office extraction, PDF handling, optional Azure Document Intelligence and Mistral OCR paths)
</details>

<details>
<summary><b>03 · Chunk</b> — structure-aware retrieval units</summary>
<br>
<img src="docs/readme/stages/03-chunk.svg" alt="Chunk stage animation" width="100%">

- **What happens:** structure-aware splitting prepares retrieval units; quality scoring informs downstream handling.
- **Carries forward:** source identity, offsets, and extraction provenance.
- **Where to look:** `APP/rag/`
</details>

<details>
<summary><b>04 · Index</b> — dense vectors and a per-document BM25 index</summary>
<br>
<img src="docs/readme/stages/04-index.svg" alt="Index stage animation" width="100%">

- **What happens:** the default embedding provider runs `BAAI/bge-m3` locally; dense vectors and a per-document BM25 index support search.
- **Carries forward:** searchable content with source metadata.
- **Where to look:** `APP/providers/`, `APP/rag/`
</details>

<details>
<summary><b>05 · Retrieve</b> — dense and keyword candidates</summary>
<br>
<img src="docs/readme/stages/05-retrieve.svg" alt="Retrieve stage animation" width="100%">

- **What happens:** a question searches the selected document context using dense and keyword candidates.
- **Carries forward:** candidate passages and retrieval scores.
- **Where to look:** `APP/rag/`
</details>

<details>
<summary><b>06 · Rank</b> — fusion, rerank, and a context budget</summary>
<br>
<img src="docs/readme/stages/06-rank.svg" alt="Rank stage animation" width="100%">

- **What happens:** Reciprocal Rank Fusion, optional FlashRank reranking, neighbor expansion, and context assembly select evidence within a token budget.
- **Carries forward:** relevant evidence for generation.
- **Where to look:** `APP/rag/`
</details>

<details>
<summary><b>07 · Answer</b> — generation, validation, citation resolution</summary>
<br>
<img src="docs/readme/stages/07-answer.svg" alt="Answer stage animation" width="100%">

- **What happens:** the configured model generates from selected context; answer validation and citation resolution process the result.
- **Carries forward:** an answer with resolvable citations, or an explicit limitation.
- **Where to look:** `APP/rag/`, `APP/providers/`, `APP/security/`, `prompts/`
</details>

<details>
<summary><b>08 · Return</b> — the exact range, and the work that follows</summary>
<br>
<img src="docs/readme/stages/08-return.svg" alt="Return stage animation" width="100%">

- **What happens:** the reader opens the source and renders valid exact ranges; annotation and notes APIs persist subsequent work.
- **Carries forward:** evidence you can inspect and revisit.
- **Where to look:** `APP/main.py` (annotations, revisioned notes), `Citely-Modernist-Next-Final/`
</details>

<details>
<summary><b>Full system diagram</b> — every service and store, in one view</summary>
<br>

```mermaid
flowchart TD
    WEB["Browser · Next.js static export"] --> MODE{"Public demo or authenticated product?"}
    MODE --> DEMO["Synthetic demo · prepared local files and answers"]
    MODE --> AUTH["Authentication · approved access"]
    AUTH --> API["FastAPI · Azure Container Apps"]
    API --> INGEST["Upload → parse → chunk → embed"]
    INGEST --> VECTOR[("Qdrant · dense vectors")]
    INGEST --> DISK[("Persistent files · BM25 index · originals")]
    API --> QUERY["Question → hybrid retrieval → RRF → rerank"]
    VECTOR --> QUERY
    DISK --> QUERY
    QUERY --> CONTEXT["Evidence selection · context budget"]
    CONTEXT --> MODEL["Configured generation provider · Azure OpenAI"]
    MODEL --> VALIDATE["Answer validation · citation resolution"]
    VALIDATE --> READER["Answer + source navigation + exact range"]
    API <--> DB[("SQLite · accounts · conversations · annotations · note revisions")]
    READER --> SAVE["Keep citation · highlight · edit notes"]
    SAVE --> API
```

</details>

Local embeddings avoid an external embedding request on the default path, but hosting and compute still have costs. Generation and optional external parsing depend on configured providers. Grounding and validation reduce unsupported answers; they do not guarantee that every generated statement is correct.

---

## Behind the product

Campaign posters from the *Building in public* series. They explain the mechanisms using illustrative sample data; the pipeline above describes the implementation.

<table>
<tr>
<td width="33%"><img src="docs/readme/posters/Citely-D2-2-Mechanism-motion.gif" alt="Split the content. Keep its address. Source identity travels with each chunk." width="100%"></td>
<td width="33%"><img src="docs/readme/posters/Citely-D4-2-Mechanism-motion.gif" alt="From answer to exact passage. A citation connects the answer to a source location." width="100%"></td>
<td width="33%"><img src="docs/readme/posters/Citely-D6-3-Takeaway-motion.gif" alt="Edits need history. Revisioned notes make conflicting changes visible." width="100%"></td>
</tr>
<tr><td align="center"><b>Keep the address</b></td><td align="center"><b>Follow the citation</b></td><td align="center"><b>Preserve the revision</b></td></tr>
</table>

<details>
<summary><b>See the full poster series</b> — six days, sixteen posters</summary>
<br>

| Day 1 · Introduction | Day 2 · From files to context | | |
| :---: | :---: | :---: | :---: |
| <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D1-Intro.png" alt="Your documents. Answers you can trace. Meet Citely." width="200"> | <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D2-1-Problem.png" alt="An upload is only the beginning." width="200"> | <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D2-2-Mechanism.png" alt="Split the content. Keep its address." width="200"> | <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D2-3-Takeaway.png" alt="The way back starts at upload." width="200"> |

| Day 3 · Inside a RAG answer | | | Day 4 · Citations that land |
| :---: | :---: | :---: | :---: |
| <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D3-1-Problem.png" alt="A question needs context." width="200"> | <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D3-2-Mechanism.png" alt="Retrieve. Then generate." width="200"> | <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D3-3-Takeaway.png" alt="Every component has a job." width="200"> | <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D4-1-Problem.png" alt="‘Page 4’ still leaves you searching." width="200"> |

| Day 4 · continued | | Day 5 · Keep the document structure | |
| :---: | :---: | :---: | :---: |
| <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D4-2-Mechanism.png" alt="From answer to exact passage." width="200"> | <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D4-3-Takeaway.png" alt="If the match is unclear, don’t guess." width="200"> | <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D5-1-Problem.png" alt="A spreadsheet is more than text." width="200"> | <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D5-2-Mechanism.png" alt="Different formats. Different source locations." width="200"> |

| Day 5 · continued | Day 6 · Thinking that persists | | |
| :---: | :---: | :---: | :---: |
| <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D5-3-Takeaway.png" alt="Keep the structure. Keep the context." width="200"> | <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D6-1-Problem.png" alt="Your thinking shouldn’t disappear on refresh." width="200"> | <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D6-2-Mechanism.png" alt="Save the highlight and its location." width="200"> | <img src="Citely-Modernist-Next-Final/public/posters/building-in-public/Citely-D6-3-Takeaway.png" alt="Edits need history." width="200"> |

</details>

<details>
<summary><b>See the document library and citation reader</b></summary>

![Document library with sample files](Citely-Modernist-Next-Final/public/screenshots/library-dark.jpg)

![Source citation product screenshot](Citely-Modernist-Next-Final/public/screenshots/source-citation-dark.jpg)

</details>

---

## Engineering map

| Layer | Implementation |
| :--- | :--- |
| Interface | `Citely-Modernist-Next-Final/` — authoritative Next.js frontend, shared branding, marketing pages, and workspace assets. |
| API and access | FastAPI, JWT, configured OAuth/email authentication, access requests, and per-user state. |
| Extraction | Parser routing, native Office extraction, PDF handling, optional Azure Document Intelligence and Mistral OCR paths. |
| Retrieval | Local embeddings, Qdrant, BM25, Reciprocal Rank Fusion, and FlashRank. |
| Generation | Provider abstraction, context assembly, evidence handling, and answer validation. |
| Persistence | SQLite plus file storage; conversations, annotations, note revisions, and document indexes. |
| Delivery | Static frontend on GitHub Pages; containerized backend on Azure Container Apps. |
| Verification | Python tests, frontend unit tests, TypeScript checks, static export, browser tests, and container builds. |

<details>
<summary><b>Repository layout</b></summary>

```text
APP/
  auth/                   Authentication and email
  parsers/                Format-aware extraction and routing
  providers/              Embedding and chat providers
  rag/                    Chunking, retrieval, evidence, generation, originals
  security/               Input and output guardrails
  db.py                   Persistent application state
  main.py                 API routes, annotations, revisioned notes
Citely-Modernist-Next-Final/  Authoritative product frontend
prompts/                  Generation prompts and data boundaries
tests/                    Backend tests
eval/                     Evaluation harness
docs/                     Architecture, implementation, and release evidence
docker/                   Container configuration
.github/workflows/        CI and deployment workflows
```

</details>

### Boundaries that matter

Authenticated routes and owner-scoped data access protect real user workflows. Retrieved text is treated as untrusted input. Deletion, annotation persistence, and note conflicts have explicit server behavior and tests. These controls are implementation safeguards, not a claim of perfect security or a certification.

The public demo is a separate synthetic experience. Office reader flags, configured parsing providers, model deployments, and access settings can differ between environments. Repository code alone does not prove that every optional path is enabled in production.

---

## Local development

Use the finalized frontend directory for interface changes:

```bash
cd Citely-Modernist-Next-Final
npm ci
BASE_PATH='' NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000 npm run dev
```

Configure the backend using [`.env.example`](.env.example) and the [deployment guide](docs/deployment.md). Authentication requires a JWT secret; real parsing and generation require the relevant configured providers. See [`docker-compose.yml`](docker-compose.yml) for the container services and environment mapping.

<details>
<summary><b>Checks</b> — frontend and backend</summary>

```bash
# Frontend checks — inside Citely-Modernist-Next-Final/
npm test
npm run typecheck
BASE_PATH='' NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000 npm run build
npm run test:browser

# Backend checks — from the repository root, in the configured Python environment
python -m unittest discover -s tests -v
```

</details>

For deeper implementation context: [precise citations](docs/CITELY-PRECISE-CITATIONS.md), [answer validation](docs/CITELY-ANSWER-VALIDATION.md), [viewer evaluation](docs/viewer-evaluation.md), and [project history](PROJECT_DOCUMENTATION.txt). Historical documents describe their own point in time; current code and deployment settings determine current behavior.

---

<div align="center">

<p><strong>Built by Vaibhav · Citely</strong></p>

Grounded answers, cited.

<a href="https://citelyapp.tech/"><img src="docs/readme/cta-explore.svg" alt="Visit the public product → https://citelyapp.tech/" height="52"></a>

<sub>© 2026 Citely. Product artwork and screenshots are included for this project’s documentation.</sub>

</div>
