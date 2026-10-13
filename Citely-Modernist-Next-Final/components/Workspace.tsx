"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { BrandIcon } from "./Brand";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  adapter,
  type Document,
  type Turn,
  type UploadStatus,
} from "@/lib/adapter";
import { siteConfig } from "@/lib/config";
import { Connectivity, useSession } from "./Shell";
export function Home() {
  const { session } = useSession();
  const [documents, setDocuments] = useState<Document[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [search, setSearch] = useState(""),
    [view, setView] = useState<"list" | "grid">("list"),
    [deleting, setDeleting] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    adapter
      .documents()
      .then((d) => {
        if (live) setDocuments(d);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);
  const remove = async (d: Document) => {
    if (!window.confirm("Delete " + d.filename + "? This cannot be undone."))
      return;
    setDeleting(d.id);
    try {
      await adapter.deleteDocument(d.id);
      setDocuments((ds) => ds.filter((x) => x.id !== d.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(null);
    }
  };
  const filtered = documents.filter((d) =>
    d.filename.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="app-design library-files">
      <div className="library-shell">
        <div className="library-content">
          <div className="library-title">
            <div>
              <span className="eyebrow">YOUR KNOWLEDGE. IN GOOD COMPANY.</span>
              <h1>Pick up where you left off.</h1>
              <p>Signed in as {session?.user.email}</p>
            </div>
            <Link className="button primary" href="/workbench">
              Ingest a document ↗
            </Link>
          </div>
          <div className="workspace-summary">
            <span className="summary-label">YOUR LIBRARY</span>
            <strong>
              {documents.length} <span>documents</span>
            </strong>
            <p>
              Grounded answers.
              <br />
              Sources close at hand.
            </p>
          </div>
          <section className="finder" aria-label="Documents">
            <div className="finder-toolbar">
              <strong>All files</strong>
              <div className="finder-controls">
                <label className="search">
                  <span className="sr-only">Search files</span>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search files…"
                  />
                </label>
                <div className="view-switch">
                  <button
                    aria-label="List view"
                    aria-pressed={view === "list"}
                    className={view === "list" ? "active" : ""}
                    onClick={() => setView("list")}
                  >
                    ☰
                  </button>
                  <button
                    aria-label="Grid view"
                    aria-pressed={view === "grid"}
                    className={view === "grid" ? "active" : ""}
                    onClick={() => setView("grid")}
                  >
                    ▦
                  </button>
                </div>
              </div>
            </div>
            <div className={"file-collection " + view} aria-live="polite">
              {loading ? (
                <div className="empty" role="status">
                  Loading…
                </div>
              ) : error ? (
                <div className="empty" role="alert">
                  {error}
                </div>
              ) : !filtered.length ? (
                <div className="empty">
                  <h2>
                    {search
                      ? "No matching documents."
                      : "Your next good question starts here."}
                  </h2>
                  <p>
                    {search
                      ? "Try a different filename."
                      : "Add your first document to begin."}
                  </p>
                  {!search && (
                    <Link className="button primary" href="/workbench">
                      Ingest your first document
                    </Link>
                  )}
                </div>
              ) : (
                filtered.map((d) => (
                  <article className="file-row" key={d.id}>
                    <div className="file-name">
                      <span className="file-symbol" aria-hidden="true">
                        ≡
                      </span>
                      <span>
                        <strong>{d.filename}</strong>
                        <small>
                          {new Date(d.ingested_at).toLocaleDateString()} ·{" "}
                          {d.pages ?? "—"} pages · {d.indexed_chunks ?? "—"}{" "}
                          chunks
                        </small>
                      </span>
                    </div>
                    <div className="inline-actions">
                      <Link
                        className="button"
                        href={"/workbench?doc=" + encodeURIComponent(d.id)}
                      >
                        Resume ↗
                      </Link>
                      <button
                        className="icon-button"
                        disabled={deleting === d.id}
                        aria-label={"Delete " + d.filename}
                        onClick={() => remove(d)}
                      >
                        ×
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
            <footer className="finder-footer">
              {documents.length} documents{" "}
              {search && `· ${filtered.length} matching`}
            </footer>
          </section>
          <div className="library-caption">
            <span>GROUNDED ANSWERS, CITED.</span>
            <span>YOUR SPACE TO THINK.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
export function Workbench() {
  const query = useSearchParams();
  const id = query.get("doc");
  return id ? <Chat key={id} id={id} /> : <Ingest />;
}
function Ingest() {
  const router = useRouter(),
    { connection } = useSession();
  const [files, setFiles] = useState<File[]>([]),
    [chunkSize, setChunkSize] = useState(1000),
    [overlap, setOverlap] = useState(150),
    [statuses, setStatuses] = useState<UploadStatus[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!files.length) return;
    setBusy(true);
    setError("");
    try {
      if (overlap >= chunkSize)
        throw Error("Overlap must be smaller than chunk size.");
      const docs = await adapter.ingest(files, { chunkSize, overlap }, (s) =>
        setStatuses((old) => [...old.filter((x) => x.name !== s.name), s]),
      );
      if (docs.length)
        router.push("/workbench?doc=" + encodeURIComponent(docs[0].id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="app-design">
      <section className="ingest-page">
        <Link href="/home">← Back to Home</Link>
        <span className="eyebrow">BRING THE CONTEXT.</span>
        <h1>Ingest a document.</h1>
        {connection !== "online" && (
          <p className="notice" role="status">
            Backend {connection}. Uploading requires a connected backend.
          </p>
        )}
        <form onSubmit={upload}>
          <fieldset disabled={busy}>
            <label
              className="dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!busy) setFiles(Array.from(e.dataTransfer.files));
              }}
            >
              <span>Drop documents here</span>
              <span>or choose files</span>
              <input
                type="file"
                multiple
                accept={siteConfig.acceptedFileTypes}
                aria-label="Choose documents"
                onChange={(e) => setFiles(Array.from(e.target.files || []))}
              />
              <small>Accepted: {siteConfig.acceptedFileTypes}</small>
            </label>
            <ul>
              {files.map((f, i) => (
                <li key={f.name + i}>{f.name}</li>
              ))}
            </ul>
            <details className="advanced">
              <summary>Advanced parameters</summary>
              <label>
                Chunk size
                <input
                  type="number"
                  min={100}
                  max={10000}
                  required
                  value={chunkSize}
                  onChange={(e) => setChunkSize(Number(e.target.value))}
                />
              </label>
              <label>
                Overlap
                <input
                  type="number"
                  min={0}
                  max={9999}
                  required
                  value={overlap}
                  onChange={(e) => setOverlap(Number(e.target.value))}
                />
              </label>
            </details>
            <button className="button primary" disabled={busy || !files.length}>
              {busy ? "Ingesting…" : "Ingest documents"}
            </button>
          </fieldset>
        </form>
        {error && <p role="alert">{error}</p>}
        <ul aria-live="polite">
          {statuses.map((s) => (
            <li key={s.name}>
              {s.name} — {s.status} <progress max={100} value={s.progress} />
              {s.error}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
function Thinking() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % 3), 1800);
    return () => clearInterval(t);
  }, []);
  return (
    <span role="status">
      <span className="spinner" aria-hidden="true" />
      {
        [
          "Finding relevant passages…",
          "Following the evidence…",
          "Preparing your answer…",
        ][i]
      }
    </span>
  );
}
function Chat({ id }: { id: string }) {
  const [turns, setTurns] = useState<Turn[]>([]),
    [question, setQuestion] = useState(""),
    [topK, setTopK] = useState(5),
    [apiKey, setApiKey] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [focused, setFocused] = useState<number | null>(null),
    [mobile, setMobile] = useState<"chat" | "sources">("chat"),
    [newMessage, setNewMessage] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const messages = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true),
    controller = useRef<AbortController | null>(null);
  const active = turns.find((t) => t.id === selected) || turns.at(-1);
  const pending = turns.some((t) => t.pending);
  useEffect(() => {
    let live = true;
    adapter
      .history(id)
      .then((t) => {
        if (live) setTurns(t);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      controller.current?.abort();
    };
  }, [id]);
  useEffect(() => {
    const el = messages.current;
    if (!el) return;
    if (nearBottom.current) {
      el.scrollTop = el.scrollHeight;
      setNewMessage(false);
    } else setNewMessage(true);
  }, [turns]);
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (pending || !question.trim()) return;
    const q = question.trim(),
      localId = crypto.randomUUID();
    setQuestion("");
    setError("");
    setTurns((t) => [
      ...t,
      { id: localId, question: q, sources: [], pending: true },
    ]);
    setSelected(localId);
    setFocused(null);
    const ac = new AbortController();
    controller.current = ac;
    try {
      const result = await adapter.ask(
        id,
        q,
        { topK, apiKey: apiKey || undefined },
        ac.signal,
      );
      if (ac.signal.aborted) return;
      setTurns((t) =>
        t.map((x) =>
          x.id === localId
            ? { ...result, id: localId, question: q, pending: false }
            : x,
        ),
      );
    } catch (e) {
      if (!ac.signal.aborted)
        setTurns((t) =>
          t.map((x) =>
            x.id === localId
              ? { ...x, pending: false, error: (e as Error).message }
              : x,
          ),
        );
    }
  };
  const citation = (turn: Turn, n: number) => {
    setSelected(turn.id);
    setFocused(n);
    setMobile("sources");
    requestAnimationFrame(() =>
      document
        .getElementById("source-" + n)
        ?.scrollIntoView({ block: "nearest" }),
    );
  };
  return (
    <div className="app-design workspace-page">
      <div className="desk-header">
        <Link href="/home">← Back to Home</Link>
        <span className="document-id" title={id}>
          {id}
        </span>
        <Connectivity />
        <Link className="button" href="/workbench">
          + New document
        </Link>
      </div>
      <div className="mobile-panes" role="tablist" aria-label="Workspace panes">
        <button
          role="tab"
          aria-selected={mobile === "chat"}
          onClick={() => setMobile("chat")}
        >
          Chat
        </button>
        <button
          role="tab"
          aria-selected={mobile === "sources"}
          onClick={() => setMobile("sources")}
        >
          Sources
        </button>
      </div>
      <div className="desk-panes converted-panes" data-active-pane={mobile}>
        <section className="conversation-pane">
          <div className="pane-heading">
            <h2>Ask this document</h2>
          </div>
          <div className="message-region">
            <div
              ref={messages}
              className="messages"
              onScroll={(e) => {
                const t = e.currentTarget;
                nearBottom.current =
                  t.scrollHeight - t.scrollTop - t.clientHeight < 90;
                if (nearBottom.current) setNewMessage(false);
              }}
            >
              {loading && <p role="status">Loading conversation…</p>}
              {error && <p role="alert">{error}</p>}
              {!loading && !turns.length && !error && (
                <p>What would you like to understand?</p>
              )}
              {turns.map((t) => (
                <div key={t.id}>
                  <article className="message own">
                    <div className="message-meta">
                      <strong>You</strong>
                      {t.createdAt && (
                        <time dateTime={t.createdAt}>
                          {new Date(t.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      )}
                    </div>
                    <div className="message-body">{t.question}</div>
                  </article>
                  <article className="message assistant">
                    <div className="message-meta">
                      <strong>
                        <BrandIcon /> Citely
                      </strong>
                      {t.createdAt && (
                        <time dateTime={t.createdAt}>
                          {new Date(t.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      )}
                    </div>
                    <div className="message-body">
                      {t.pending ? (
                        <Thinking />
                      ) : t.error ? (
                        <p role="alert">{t.error}</p>
                      ) : (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ href, children, ...props }) => {
                              const m = href?.match(/^#citely-source-(\d+)$/);
                              if (m) {
                                const n = Number(m[1]) - 1;
                                return (
                                  <button
                                    className="inline-citation"
                                    aria-label={"Show source " + (n + 1)}
                                    aria-pressed={
                                      active?.id === t.id && focused === n
                                    }
                                    onClick={() => citation(t, n)}
                                  >
                                    {children}
                                  </button>
                                );
                              }
                              return (
                                <a
                                  {...props}
                                  href={href}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {children}
                                </a>
                              );
                            },
                          }}
                        >
                          {(t.answer || "").replace(
                            /\[(\d+)\](?!\()/g,
                            (match, n) =>
                              Number(n) > 0 && Number(n) <= t.sources.length
                                ? `[${n}](#citely-source-${n})`
                                : match,
                          )}
                        </ReactMarkdown>
                      )}
                    </div>
                    {!!t.sources.length && (
                      <button
                        className="text-button"
                        onClick={() => {
                          setSelected(t.id);
                          setFocused(null);
                          setMobile("sources");
                        }}
                      >
                        View {t.sources.length} sources ↗
                      </button>
                    )}
                  </article>
                </div>
              ))}
            </div>
            <span className="sr-only" aria-live="polite">
              {turns.at(-1)?.pending
                ? "Answer in progress"
                : turns.length
                  ? "Answer received."
                  : ""}
            </span>
            {newMessage && (
              <button
                className="new-messages"
                onClick={() => {
                  const el = messages.current;
                  if (el) el.scrollTop = el.scrollHeight;
                  nearBottom.current = true;
                  setNewMessage(false);
                }}
              >
                ↓ New message
              </button>
            )}
          </div>
          <form className="composer" onSubmit={send}>
            <details className="chat-options">
              <summary>Options</summary>
              <label>
                Top-k
                <input
                  type="number"
                  min={1}
                  max={30}
                  required
                  value={topK}
                  onChange={(e) => setTopK(Number(e.target.value))}
                />
              </label>
              <label>
                Your own OpenAI key (optional)
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>
              <small>
                Used for this request. Kept in memory only; the backend defines
                key handling.
              </small>
            </details>
            <div className="composer-box">
              <label className="sr-only" htmlFor="question">
                Your question
              </label>
              <textarea
                id="question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask a question about this document…"
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div>
                <span>Enter to send · Shift+Enter for a new line</span>
                <button
                  type="submit"
                  disabled={pending || loading || !question.trim()}
                  aria-label="Send question"
                >
                  ↑
                </button>
              </div>
            </div>
          </form>
        </section>
        <section className="sources-pane">
          <div className="pane-heading">
            <h2>
              Sources <span>{active?.sources.length || 0}</span>
            </h2>
          </div>
          <div className="source-cards">
            {!active?.sources.length ? (
              <p>Ask a question and its sources will appear here.</p>
            ) : (
              active.sources.map((s, i) => (
                <button
                  id={"source-" + i}
                  key={i}
                  className={"source-card " + (focused === i ? "focused" : "")}
                  aria-pressed={focused === i}
                  onClick={() => setFocused(focused === i ? null : i)}
                >
                  <span className="source-card-top">
                    <strong>
                      {i + 1}. {s.source}
                    </strong>
                    <span>Page {s.page ?? "—"}</span>
                  </span>
                  {s.score !== null && (
                    <span className="score">
                      <meter
                        min={0}
                        max={1}
                        value={Math.min(1, Math.max(0, s.score))}
                      />
                      <span>{s.score.toFixed(3)}</span>
                    </span>
                  )}
                  <span>{s.content}</span>
                </button>
              ))
            )}
          </div>
          <p className="source-notice">
            Document preview is coming in a future update.
          </p>
        </section>
      </div>
      <details className="pipeline">
        <summary>How retrieval works</summary>
        <p>
          Question → Retrieve relevant chunks → Rank sources → Generate cited
          answer
        </p>
      </details>
    </div>
  );
}
