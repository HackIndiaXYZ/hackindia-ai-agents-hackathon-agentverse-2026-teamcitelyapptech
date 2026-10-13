"use client";
// Citely admin console (admin.citely.example). One session per environment
// (prod, dev, hack): each is its own server, database and accounts, so the
// console signs in to each separately and labels everything with where it
// came from. Only the Citely admin account gets past the server's checks.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ThemeButton } from "./Shell";
import { asset } from "@/lib/config";
import { AdminError, FRESH_MS, adminEnvs, api, cached, emailFor, enterCode, googleCallback, googleEnabled, googleUrl, load, remember, resendCode,
  signIn, signOutOf, tokenFor, sharedNote, type AdminEnv } from "@/lib/admin";
import { whilePresent } from "@/lib/presence.mjs";

type Section = "overview" | "traffic" | "limits" | "pending" | "users" | "activity" | "requests" | "samples" | "database" | "server";
const SECTIONS: [Section, string][] = [["overview", "Overview"], ["traffic", "Traffic"], ["limits", "Limits"], ["pending", "Pending review"], ["users", "Users"], ["activity", "Activity"],
  ["requests", "Demo requests"], ["samples", "Samples"], ["database", "Database"], ["server", "Server"]];

// ---- formatting ---------------------------------------------------------------

const ago = (iso?: string | null) => {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
};
/** Presence from the workspace's own signals: online (a tab in front of them,
 *  used in the last minutes), away (a tab still open but hidden or idle),
 *  otherwise when they were last working. Pending and declined accounts
 *  can't use the workspace: no presence at all. */
function Presence({ u }: { u: any }) {
  if (u.status === "pending" || u.status === "declined" || u.presence === null) return <span className="adm-muted">—</span>;
  if (u.presence === "online") return <span className="adm-online">Online</span>;
  if (u.presence === "away") return <span className="adm-away" title={when(u.last_seen_at)}>Away · {ago(u.last_seen_at)}</span>;
  return <span title={u.last_seen_at ? when(u.last_seen_at) : undefined}>{u.last_seen_at ? "Last seen " + ago(u.last_seen_at) : "Never seen"}</span>;
}
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—");
const bytes = (n?: number | null) => {
  if (n == null) return "—";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
};
const duration = (s?: number | null) => {
  if (s == null) return "—";
  if (s < 60) return s + " s";
  if (s < 3600) return Math.floor(s / 60) + " min";
  if (s < 86400) return Math.floor(s / 3600) + " h " + Math.floor((s % 3600) / 60) + " min";
  return Math.floor(s / 86400) + " d " + Math.floor((s % 86400) / 3600) + " h";
};
const EVENT_LABELS: Record<string, string> = {
  "auth.login": "Signed in", "auth.login_failed": "Sign-in failed", "auth.login_blocked": "Blocked sign-in", "auth.login_code_sent": "Sign-in code sent",
  "auth.signup": "Account created", "auth.signup_started": "Sign-up started", "auth.signed_out_everywhere": "Signed out everywhere",
  "upload": "Upload", "question": "Question", "document.deleted": "Document deleted", "session.start": "Visit", "demo.request": "Demo request",
  "server.start": "Server started", "admin.approve": "Approved", "admin.decline": "Declined", "admin.suspend": "Suspended", "admin.unsuspend": "Unsuspended",
  "admin.delete": "Account deleted", "admin.approve_request": "Request approved", "admin.revoke_browsers": "Browsers revoked",
  "admin.sample_added": "Sample added", "admin.sample_deleted": "Sample deleted", "email.failed": "Email not delivered",
  "auth.signup_refused": "Sign-up refused", "demo.request_refused": "Demo request refused", "admin.password_reset": "Reset link sent",
  "admin.limits_changed": "Limits changed", "admin.usage_reset": "Account limits reset", "admin.daily_reset": "Today's shared count cleared", "question.unanswered": "Not enough information (not counted)", "question.unverified": "Answer not verified (not counted)", "admin.uptime_check": "Uptime checked",
  "admin.notified": "Admin notification", "admin.notification_test": "Test notification requested",
};
const eventLabel = (t: string) => EVENT_LABELS[t] || t;
const detailText = (d: any) => (d ? Object.entries(d).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ") : "");

// ---- small pieces ---------------------------------------------------------------

function Status({ value }: { value: string }) {
  return <span className={"adm-status s-" + value}><i aria-hidden="true" />{value}</span>;
}
function Tile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return <div className="adm-tile"><span className="adm-label">{label}</span><strong>{value}</strong>{note ? <small>{note}</small> : null}</div>;
}
function Problem({ error, retry }: { error: string; retry?: () => void }) {
  return <div className="adm-problem" role="alert"><p>{error}</p>{retry && <button className="adm-btn" onClick={retry}>Try again</button>}</div>;
}
/** "Loading…", and after a few seconds the likely reason: a server that
 *  sleeps when idle is starting (~30 s). */
function Loading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 2500); return () => clearTimeout(t); }, []);
  return <p className="adm-muted" role="status">{slow ? "Waking the server… this usually takes under a minute." : "Loading…"}</p>;
}

/** One series of daily counts as thin bars, with a hover readout and a table
 *  for screen readers. Each chart is its own measure (no shared scale). */
function DailyBars({ title, days, field }: { title: string; days: any[]; field: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = days.map((d) => Number(d[field]) || 0);
  const max = Math.max(1, ...values), total = values.reduce((a, b) => a + b, 0);
  const W = 280, H = 84, gap = 2, bw = (W - gap * (values.length - 1)) / Math.max(1, values.length);
  const shown = hover ?? values.length - 1;
  return (
    <figure className="adm-chart">
      <figcaption><span className="adm-label">{title}</span><strong>{total}</strong><small>in {days.length} days</small></figcaption>
      <div className="adm-chart-read" aria-hidden="true">{days[shown] ? `${new Date(days[shown].day).toLocaleDateString([], { day: "numeric", month: "short" })}: ${values[shown]}` : ""}</div>
      <svg viewBox={`0 0 ${W} ${H + 1}`} role="img" aria-label={`${title}: ${total} over ${days.length} days, most ${max} on one day`} onMouseLeave={() => setHover(null)}>
        <line x1="0" x2={W} y1={H + 0.5} y2={H + 0.5} className="adm-axis" />
        {values.map((v, i) => {
          const h = v ? Math.max(2, (v / max) * (H - 4)) : 0;
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={i * (bw + gap)} y="0" width={bw} height={H} fill="transparent" />
              {h > 0 && <rect className={"adm-bar" + (hover === i ? " on" : "")} x={i * (bw + gap)} y={H - h} width={bw} height={h} rx="2" />}
            </g>
          );
        })}
      </svg>
      <div className="adm-chart-ends" aria-hidden="true"><span>{days[0] ? new Date(days[0].day).toLocaleDateString([], { day: "numeric", month: "short" }) : ""}</span><span>today</span></div>
      <table className="sr-only"><caption>{title} per day</caption><tbody>{days.map((d, i) => <tr key={d.day}><th>{d.day}</th><td>{values[i]}</td></tr>)}</tbody></table>
    </figure>
  );
}

// ---- sign-in ---------------------------------------------------------------

/** "t••••@example.com": enough to recognise the account, not the whole address. */
const maskEmail = (email: string) => {
  const [local, domain] = email.split("@");
  return domain ? `${local.slice(0, 1)}••••@${domain}` : email;
};

function GoogleLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18">
      <path d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.89-1.74 2.98-4.3 2.98-7.36Z" fill="var(--provider-4285F4)" />
      <path d="M12 22c2.7 0 4.96-.89 6.62-2.41l-3.24-2.51c-.89.6-2.03.96-3.38.96-2.6 0-4.81-1.76-5.6-4.12H3.05v2.59A10 10 0 0 0 12 22Z" fill="var(--provider-34A853)" />
      <path d="M6.4 13.92a6 6 0 0 1 0-3.84V7.49H3.05a10 10 0 0 0 0 9.02l3.35-2.59Z" fill="var(--provider-FBBC05)" />
      <path d="M12 5.96c1.47 0 2.79.51 3.82 1.51l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.95 5.49l3.35 2.59C7.19 7.72 9.4 5.96 12 5.96Z" fill="var(--provider-EA4335)" />
    </svg>
  );
}

/** The signed-in account for this environment, behind an initial: the full
 *  address isn't on screen all the time. */
function AccountMenu({ env, email, onSignOut }: { env: AdminEnv; email: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("pointerdown", away);
    addEventListener("keydown", esc);
    return () => { removeEventListener("pointerdown", away); removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="adm-account" ref={box}>
      <button className="adm-avatar" aria-label={`Account for ${env.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {email.slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div className="adm-menu" role="menu">
          <span className="adm-label">SIGNED IN TO {env.name.toUpperCase()}</span>
          <span className="adm-menu-email">{maskEmail(email)}</span>
          <button role="menuitem" onClick={() => { setOpen(false); onSignOut(); }}>Sign out of {env.name}</button>
        </div>
      )}
    </div>
  );
}

type Challenge = { ticket: string; sentTo: string };

function SignInPanel({ env, onDone, initial = null }: { env: AdminEnv; onDone: () => void; initial?: Challenge | null }) {
  const [email, setEmail] = useState(emailFor(env.id) || ""), [password, setPassword] = useState(""),
    [challenge, setChallenge] = useState<Challenge | null>(initial),
    [code, setCode] = useState(""), [trust, setTrust] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const after = (step: any) => { if (step.done) onDone(); else { setChallenge({ ticket: step.ticket, sentTo: step.sentTo }); setCode(""); } };
  const submit = (e: FormEvent) => { e.preventDefault(); return run(async () => after(await signIn(env, email.trim(), password))); };
  const confirm = (e: FormEvent) => { e.preventDefault(); return run(async () => after(await enterCode(env, challenge!.ticket, code, trust))); };
  return (
    <section className="adm-signin">
      <span className="adm-label">ADMIN · {env.name.toUpperCase()}</span>
      {challenge ? (<>
        <h1>Check your inbox.</h1>
        <p className="adm-muted">Enter the 6-digit code sent to <strong>{challenge.sentTo}</strong>.</p>
        <form onSubmit={confirm}>
          <label className="adm-field"><span>Sign-in code</span>
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} required autoFocus value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
          <label className="adm-check"><input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} /> Trust this browser for 30 days</label>
          <button className="adm-btn primary" disabled={busy || code.length !== 6}>{busy ? "Please wait…" : "Verify and continue"}</button>
        </form>
        <div className="adm-row">
          <button className="adm-link" disabled={busy} onClick={() => run(async () => { const r = await resendCode(env, challenge.ticket); setChallenge({ ticket: r.ticket, sentTo: r.sent_to }); })}>Resend code</button>
          <button className="adm-link" disabled={busy} onClick={() => setChallenge(null)}>Back</button>
        </div>
      </>) : (<>
        <h1>Sign in to {env.name}.</h1>
        <p className="adm-muted">Each environment has its own server, database and sign-in. Use the Citely admin account{env.site ? <> for <strong>{env.site.replace(/^https?:\/\//, "")}</strong></> : null}.</p>
        {googleEnabled() && (<>
          <button className="adm-btn adm-google" disabled={busy} onClick={() => { location.assign(googleUrl(env)); }}><GoogleLogo />Continue with Google</button>
          <div className="adm-divider"><span>or with email</span></div>
        </>)}
        <form onSubmit={submit}>
          <label className="adm-field"><span>Email</span><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="adm-field"><span>Password</span><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className="adm-btn primary" disabled={busy}>{busy ? "Signing in… (a sleeping server takes a moment)" : "Sign in"}</button>
        </form>
      </>)}
      {error && <p className="adm-error" role="alert">{error}</p>}
    </section>
  );
}

// ---- data hook ---------------------------------------------------------------

/** One view's data: its key in the shared store (environment first, so
 *  signing out of one forgets only its views) and how to load it. Sections
 *  and the background prefetch build views the same way, so a prefetched
 *  answer is the one the section looks for. */
type View<T = any> = { key: string; load: () => Promise<T> };
const view = {
  overview: (env: AdminEnv): View => ({ key: `${env.id}:overview`, load: () => api.overview(env) }),
  traffic: (env: AdminEnv, days: number): View => ({ key: `${env.id}:traffic:${days}`, load: () => api.traffic(env, days) }),
  limits: (env: AdminEnv): View => ({ key: `${env.id}:limits`, load: () => api.limits(env) }),
  users: (env: AdminEnv, query: string, status: string): View<{ total: number; items: any[] }> =>
    ({ key: `${env.id}:users:${status}:${query}`, load: () => api.users(env, { query, status }) }),
  user: (env: AdminEnv, id: string): View => ({ key: `${env.id}:user:${id}`, load: () => api.user(env, id) }),
  events: (env: AdminEnv, type: string): View<{ items: any[] }> => ({ key: `${env.id}:events:${type}`, load: () => api.events(env, { type }) }),
  requests: (env: AdminEnv): View<{ items: any[] }> => ({ key: `${env.id}:requests`, load: () => api.demoRequests(env) }),
  samples: (env: AdminEnv): View<{ items: any[] }> => ({ key: `${env.id}:samples`, load: () => api.samples(env) }),
  database: (env: AdminEnv): View => ({ key: `${env.id}:database`, load: () => api.database(env) }),
  server: (env: AdminEnv): View => ({ key: `${env.id}:server`, load: () => api.server(env) }),
  uptime: (env: AdminEnv): View => ({ key: `${env.id}:uptime`, load: () => api.uptime(env) }),
  // A server from before admin notifications has no such endpoint: "absent", shown as nothing.
  notifications: (env: AdminEnv): View => ({ key: `${env.id}:notifications`,
    load: () => api.notifications(env).catch((e: AdminError) => (e.status === 404 ? { absent: true } : Promise.reject(e))) }),
};
/** What each section shows first, for prefetching it in the other environments. */
const SECTION_VIEWS: Record<Section, (env: AdminEnv) => View[]> = {
  overview: (e) => [view.overview(e), view.notifications(e)], traffic: (e) => [view.traffic(e, 14)], limits: (e) => [view.limits(e)],
  pending: (e) => [view.users(e, "", "pending"), view.notifications(e)], users: (e) => [view.users(e, "", "members")], activity: (e) => [view.events(e, "")],
  requests: (e) => [view.requests(e)], samples: (e) => [view.samples(e)], database: (e) => [view.database(e)],
  server: (e) => [view.server(e), view.uptime(e), view.notifications(e)],
};

/** Loads a view: its last answer (prefetched, or from an earlier visit) shows
 *  at once; it is refreshed unless it is only seconds old; an identical
 *  request already in flight is shared. reload() always asks the server. */
function useLoad<T>(v: View<T>, deps: unknown[]) {
  const key = v.key;
  const [data, setDataState] = useState<T | null>(() => cached<T>(key)?.data ?? null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(true);
  const seq = useRef(0);
  const setData = useCallback((d: T) => { remember(key, d); setDataState(d); }, [key]);
  const run = useCallback(async (force: boolean) => {
    const n = ++seq.current; setBusy(true); setError("");
    setDataState(cached<T>(key)?.data ?? null);
    try { const d = await load(key, v.load, { maxAgeMs: FRESH_MS, force }); if (n === seq.current) setDataState(d); }
    catch (e) { if (n === seq.current) setError((e as Error).message); }
    finally { if (n === seq.current) setBusy(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, key]);
  const reload = useCallback(() => run(true), [run]);
  useEffect(() => { void run(false); }, [run]);
  return { data, error, busy, reload, setData };
}

// ---- admin notifications ---------------------------------------------------------------

const NOTICE_KIND: Record<string, string> = { "new account": "New account", "demo request": "Demo request", test: "Test" };
const noticeKind = (e: any) => NOTICE_KIND[e?.detail?.kind] || e?.detail?.kind || "Notification";

/** Admin notifications (new account, demo request) that failed in the last
 *  days, on Overview and Pending review: a failed one means a sign-up or a
 *  request may have gone unnoticed. Nothing when all went out; nothing on
 *  a server without this feature yet (404). */
function NotificationAlert({ env, onShow }: { env: AdminEnv; onShow: () => void }) {
  const { data, error } = useLoad(view.notifications(env), [env.id]);
  if (error) return <p className="adm-error" role="alert">Couldn&rsquo;t check admin notifications: {error}</p>;
  if (!data || data.absent || !data.failed) return null;
  const last = data.last_failed;
  return (
    <div className="adm-banner" role="alert">
      <p><strong>{data.failed === 1 ? "1 admin notification" : `${data.failed} admin notifications`} failed in the last {data.days} days.</strong>{" "}
        You may have missed a sign-up or a demo request. Latest: {noticeKind(last).toLowerCase()}{last.email ? ` for ${last.email}` : ""}, {when(last.at)}
        {last.detail?.reason ? <> &mdash; {last.detail.reason}</> : null}.
        {data.last_sent && new Date(data.last_sent.at) > new Date(last.at) ? <> A later one was sent fine ({when(data.last_sent.at)}).</> : null}</p>
      <button className="adm-btn small" onClick={onShow}>See notifications in Activity</button>
    </div>
  );
}

/** Server → Notifications: where admin notifications go, how the recent
 *  ones went, and a test: accepted by the email service, then sent or
 *  failed. "Sent" is as far as the service can see; whether the inbox
 *  provider filed it as spam isn't reported back. */
function NotificationsCard({ env }: { env: AdminEnv }) {
  // A server from before this release has no notifications endpoint: show nothing there (as the banner does).
  const { data, error, reload, setData } = useLoad(view.notifications(env), [env.id]);
  const [test, setTest] = useState<{ state: "sending" | "accepted" | "sent" | "failed" | "unconfirmed"; recipient?: string | null; reason?: string; at?: string } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const send = async () => {
    setTest({ state: "sending" });
    let id: string;
    try {
      const r = await api.testNotification(env);
      id = r.test_id;
      setTest({ state: "accepted", recipient: r.recipient });
    } catch (e) { setTest({ state: "failed", reason: (e as Error).message }); void reload(); return; }
    // The service confirms within seconds; the server gives up after 3 minutes.
    const until = Date.now() + 200_000;
    while (live.current && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const d = await api.notifications(env, id);
        if (d.test) {
          setData(d);
          const ok = d.test.detail?.outcome === "sent";
          setTest((t) => ({ ...t, state: ok ? "sent" : "failed", reason: d.test.detail?.reason, at: d.test.at }));
          return;
        }
      } catch (e) { setTest((t) => ({ ...t, state: "failed", reason: "Couldn't read the result: " + (e as Error).message })); return; }
    }
    if (live.current) setTest((t) => ({ ...t, state: "unconfirmed" }));
  };
  if (error) return <Problem error={"Notifications: " + error} retry={reload} />;
  if (data?.absent) return null;
  if (!data) return <Loading />;
  return (
    <section className="adm-card" aria-label="Notifications">
      <div className="adm-row spread">
        <span className="adm-label">ADMIN NOTIFICATIONS</span>
        <button className="adm-btn small" onClick={send} disabled={!data.recipient || test?.state === "sending" || test?.state === "accepted"}>
          {test?.state === "sending" ? "Sending…" : test?.state === "accepted" ? "Waiting for the email service…" : "Send test notification"}</button>
      </div>
      <p className="adm-muted">New accounts awaiting review and demo requests are emailed to{" "}
        {data.recipient ? <strong>{data.recipient}</strong> : <span className="adm-error">nobody: no address is set on this server (CITELY_DEMO_RECIPIENT)</span>}
        {data.sender ? <> from {data.sender}</> : null}.</p>
      {test && test.state !== "sending" && (
        <div className="adm-check-result" role="status">
          {test.state === "accepted" && <span><Status value="accepted" /> Accepted by the email service. Waiting for it to confirm the send…</span>}
          {test.state === "sent" && <span><Status value="sent" /> Sent to {test.recipient} {when(test.at)}. Check that inbox, and its Spam folder: the email service can&rsquo;t see where the inbox files it.</span>}
          {test.state === "failed" && <span><Status value="failed" /> Not sent: {test.reason || "unknown reason"}</span>}
          {test.state === "unconfirmed" && <span><Status value="unconfirmed" /> Accepted, but the email service hasn&rsquo;t confirmed it yet. It will appear under Activity → Notifications.</span>}
        </div>
      )}
      {data.recent.length === 0 ? <p className="adm-muted">No admin notifications in the last 30 days.</p> : (
        <ul className="adm-list">{data.recent.slice(0, 5).map((e: any) => (
          <li key={e.id}>
            <span><Status value={e.detail?.outcome === "sent" ? "sent" : "failed"} /> {noticeKind(e)}{e.email ? ` · ${e.email}` : ""}</span>
            <small>{e.detail?.outcome === "sent" ? "" : (e.detail?.reason || "unknown reason") + " · "}{when(e.at)}</small>
          </li>))}
        </ul>
      )}
    </section>
  );
}

/** Reloads every 30 s while the console is visible and in use (who is
 *  online changes by the minute). Stops 10 minutes after the last input, so
 *  a console left open never keeps a server awake. */
function useLiveRefresh(reload: () => unknown, enabled = true) {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    if (!enabled) return;
    let mounted = false;                       // the first run is the load that is already under way
    const h = whilePresent({ run: () => { if (mounted) void latest.current(); mounted = true; }, intervalMs: 30_000, idleMs: 600_000 });
    return () => h.stop();
  }, [enabled]);
}

// ---- sections ---------------------------------------------------------------

function Overview({ env, onNotices }: { env: AdminEnv; onNotices: () => void }) {
  const { data, error, busy, reload } = useLoad(view.overview(env), [env.id]);
  useLiveRefresh(reload);
  if (error) return <Problem error={error} retry={reload} />;
  if (!data) return <Loading />;
  const u = data.users, days = data.per_day as any[], today = days[days.length - 1] || {}, lim = data.limits;
  return (
    <div className="adm-stack" aria-busy={busy}>
      <NotificationAlert key={env.id} env={env} onShow={onNotices} />
      <div className="adm-tiles">
        <Tile label="MEMBERS" value={u.members ?? u.total} note={`${u.new_24h} new today · ${u.new_7d} this week`} />
        <Tile label="ONLINE NOW" value={u.online_now} note={`${u.active_24h} active in 24 h`} />
        <Tile label="PENDING REVIEW" value={u.by_status.pending} note={`${u.by_status.declined} declined · ${u.by_status.suspended} suspended`} />
        <Tile label="DEMO REQUESTS" value={u.demo_requests_pending} note={`${u.demo_requests_total} in total`} />
        <Tile label="DOCUMENTS" value={u.documents} note={`${today.uploads || 0} added today`} />
        <Tile label="QUESTIONS" value={u.questions} note={`${today.questions || 0} asked today`} />
      </div>
      <div className="adm-charts">
        <DailyBars title="UPLOADS" days={days} field="uploads" />
        <DailyBars title="QUESTIONS" days={days} field="questions" />
        <DailyBars title="SIGN-UPS" days={days} field="signups" />
        <DailyBars title="API REQUESTS" days={days} field="requests" />
      </div>
      <div className="adm-card">
        <span className="adm-label">LIMITS · {lim.enabled ? "ON" : "OFF"}</span>
        <p className="adm-muted">Each account: {lim.uploads_per_account} uploads and {lim.questions_per_account} questions {lim.period === "daily" ? "a day" : "in total"}, files up to {lim.max_upload_mb} MB and {lim.max_pages} pages.
          Everyone together, per day: {lim.uploads_per_day} uploads ({data.usage_today?.upload ?? 0} used today) and {lim.questions_per_day} questions ({data.usage_today?.question ?? 0} used today).</p>
        <p className="adm-muted">API errors today: {today.errors || 0}.</p>
      </div>
    </div>
  );
}

const countryName = (() => {
  let names: Intl.DisplayNames | null = null;
  try { names = new Intl.DisplayNames(["en"], { type: "region" }); } catch { /* old browser: show the code */ }
  return (code: string) => (code && /^[A-Z]{2}$/.test(code) && names ? names.of(code) || code : code);
})();

/** A ranked list: each row's share of page views as a thin bar, the number in text. */
function Ranked({ title, rows, label = (n: string) => n }: { title: string; rows: any[]; label?: (n: string) => string }) {
  return (
    <section className="adm-card">
      <span className="adm-label">{title}</span>
      {rows.length === 0 ? <p className="adm-muted">No visits yet.</p> : (
        <ul className="adm-ranked">{rows.map((r) => (
          <li key={r.name}>
            <span className="adm-ranked-name" title={label(r.name)}>{label(r.name)}</span>
            <span className="adm-ranked-num">{r.views}</span>
            <span className="adm-ranked-bar" aria-hidden="true"><i style={{ width: Math.max(2, r.share * 100) + "%" }} /></span>
          </li>))}
        </ul>
      )}
    </section>
  );
}

function Traffic({ env }: { env: AdminEnv }) {
  const [days, setDays] = useState(14);
  const { data, error, busy, reload } = useLoad(view.traffic(env, days), [env.id, days]);
  const range = (
    <div className="adm-seg" role="group" aria-label="Period">
      {[7, 14, 30].map((d) => <button key={d} className={days === d ? "on" : ""} aria-pressed={days === d} onClick={() => setDays(d)}>{d} days</button>)}
    </div>
  );
  if (error) return <div className="adm-stack">{range}<Problem error={error} retry={reload} /></div>;
  if (!data) return <Loading />;
  if (!data.configured) return (
    <div className="adm-problem"><p>Traffic isn&rsquo;t set up for {env.name}: missing {data.missing.join(", ")} on its server.</p></div>
  );
  const t = data.totals, top = data.countries[0];
  return (
    <div className="adm-stack" aria-busy={busy}>
      <div className="adm-row spread">
        <p className="adm-muted">Visits to <strong>{data.host}</strong>, from Cloudflare Web Analytics. Public pages only; the workspace is under Activity → Visits.</p>
        {range}
      </div>
      <div className="adm-tiles">
        <Tile label="VISITS" value={t.visits} note={`in ${data.days} days`} />
        <Tile label="PAGE VIEWS" value={t.views} note={t.visits ? `${(t.views / t.visits).toFixed(1)} pages per visit` : "—"} />
        <Tile label="TOP COUNTRY" value={top ? countryName(top.name) : "—"} note={top ? `${Math.round(top.share * 100)}% of page views` : "no visits yet"} />
        <Tile label="TOP SOURCE" value={data.referrers[0]?.name.startsWith("Direct") ? "Direct" : data.referrers[0]?.name || "—"} note={data.referrers[0] ? `${Math.round(data.referrers[0].share * 100)}% of page views` : "no visits yet"} />
      </div>
      <div className="adm-charts">
        <DailyBars title="VISITS" days={data.per_day} field="visits" />
        <DailyBars title="PAGE VIEWS" days={data.per_day} field="views" />
      </div>
      <div className="adm-two">
        <Ranked title="TOP PAGES" rows={data.pages} />
        <Ranked title="COUNTRIES" rows={data.countries} label={countryName} />
        <Ranked title="WHERE THEY CAME FROM" rows={data.referrers} />
        <Ranked title="DEVICES" rows={data.devices} />
        <Ranked title="BROWSERS" rows={data.browsers} />
      </div>
      <p className="adm-fine">Cloudflare estimates these from a sample, so at low traffic they move in steps (often of 10). Bots it recognises are left out. Updated every few minutes.</p>
    </div>
  );
}

/** The usage limits, editable. Saved limits apply straight away. */
function Limits({ env }: { env: AdminEnv }) {
  const { data, error, reload, setData } = useLoad(view.limits(env), [env.id]);
  const [form, setForm] = useState<any>(null), [saving, setSaving] = useState(false), [note, setNote] = useState("");
  useEffect(() => { if (data) setForm(data.limits); }, [data]);
  if (error) return <Problem error={error} retry={reload} />;
  if (!data || !form) return <Loading />;
  const changed = JSON.stringify(form) !== JSON.stringify(data.limits);
  const num = (key: string, label: string, hint: string, max?: number) => (
    <div className="adm-field">
      <label htmlFor={`limit-${key}`}>{label}</label>
      <input id={`limit-${key}`} type="number" min={key.startsWith("max") ? 1 : 0} max={max} required value={form[key]} aria-describedby={`limit-${key}-hint`}
        onChange={(e) => setForm({ ...form, [key]: e.target.value === "" ? "" : Number(e.target.value) })} />
      <small id={`limit-${key}-hint`} className="adm-muted">{hint}</small>
    </div>
  );
  const save = async (e: FormEvent) => {
    e.preventDefault(); setSaving(true); setNote("");
    try { const r = await api.saveLimits(env, form); setData(r); setNote("Saved. The new limits apply straight away."); }
    catch (err) { setNote((err as Error).message); } finally { setSaving(false); }
  };
  const daily = form.period === "daily";
  return (
    <form className="adm-stack adm-limits" onSubmit={save}>
      <section className="adm-card">
        <label className="adm-check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Limits are on <small className="adm-muted">(the admin account is never limited)</small></label>
      </section>
      <section className="adm-card">
        <span className="adm-label">EACH ACCOUNT</span>
        <div className="adm-seg" role="group" aria-label="Account limit period">
          <button type="button" className={!daily ? "on" : ""} aria-pressed={!daily} onClick={() => setForm({ ...form, period: "total" })}>One time (in total)</button>
          <button type="button" className={daily ? "on" : ""} aria-pressed={daily} onClick={() => setForm({ ...form, period: "daily" })}>Every day</button>
        </div>
        <div className="adm-form-grid">
          {num("uploads", "Uploads", daily ? "Per account, each day." : "Per account, ever.")}
          {num("questions", "Questions", daily ? "Per account, each day." : "Per account, ever.")}
          {num("max_upload_mb", "Largest file (MB)", `Up to ${data.max_upload_mb_cap} MB.`, data.max_upload_mb_cap)}
          {num("max_pages", "Most pages per file", "Pages, slides or sheets.")}
        </div>
      </section>
      <section className="adm-card">
        <span className="adm-label">EVERYONE TOGETHER, PER DAY</span>
        <p className="adm-muted">A safety cap on the whole site, so a burst of sign-ups can't run up costs. When it's reached, everyone waits until tomorrow.</p>
        <div className="adm-form-grid">
          {num("daily_uploads", "Uploads per day", "Across all accounts.")}
          {num("daily_questions", "Questions per day", "Across all accounts.")}
        </div>
      </section>
      <div className="adm-row">
        <button className="adm-btn primary" disabled={saving || !changed}>{saving ? "Saving…" : "Save limits"}</button>
        {changed && <button type="button" className="adm-link" onClick={() => setForm(data.limits)}>Undo changes</button>}
        {!data.saved && <small className="adm-muted">Using the defaults from the server's settings until you save.</small>}
      </div>
      {note && <p className="adm-note" role="status">{note}</p>}
      <ResetOneAccount env={env} />
    </form>
  );
}

/** Gives one account its uploads and questions back, by email. */
function ResetOneAccount({ env }: { env: AdminEnv }) {
  const [email, setEmail] = useState(""), [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const run = async () => {
    const wanted = email.trim().toLowerCase();
    if (!wanted) return;
    setBusy(true); setNote("");
    try {
      const found = (await api.users(env, { query: wanted, status: "" })).items.find((u: any) => u.email.toLowerCase() === wanted);
      if (!found) { setNote(`No account with the address ${wanted}.`); return; }
      if (found.is_admin) { setNote("The admin account has no limits to reset."); return; }
      if (!confirm(`Give ${found.email} their uploads and questions back?\n\nEverything they have used is cleared (in total and today).`)) return;
      const r = await api.resetUsage(env, found.id);
      const n = (k: string) => r.cleared.total?.[k] ?? 0;
      setNote(`Reset for ${r.email}: ${n("upload")} upload${n("upload") === 1 ? "" : "s"} and ${n("question")} question${n("question") === 1 ? "" : "s"} given back.` + sharedNote(r.shared));
      setEmail("");
    } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="adm-card" aria-label="Reset one account">
      <span className="adm-label">RESET ONE ACCOUNT</span>
      <p className="adm-muted">Gives one account its uploads and questions back, without touching anyone else&rsquo;s. You can also do this from an account&rsquo;s panel under Users.</p>
      <div className="adm-row">
        <input className="adm-search" type="email" placeholder="Their email address" aria-label="Email address of the account to reset" value={email}
          onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void run(); } }} />
        <button type="button" className="adm-btn" disabled={busy || !email.trim()} onClick={run}>{busy ? "Working…" : "Reset their limits"}</button>
      </div>
      {note && <p className="adm-note" role="status">{note}</p>}
      <ClearSharedToday env={env} />
    </section>
  );
}

/** Starts the site-wide daily count (shared by everyone) again from zero. */
function ClearSharedToday({ env }: { env: AdminEnv }) {
  const [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const run = async () => {
    if (!confirm("Clear today's shared count?\n\nThe live demo's daily limit starts again from zero for everyone. Each account's own limit is unchanged.")) return;
    setBusy(true); setNote("");
    try {
      const r = await api.resetToday(env);
      setNote(`Today's shared count is cleared (it was ${r.cleared.question ?? 0} question${r.cleared.question === 1 ? "" : "s"} and ${r.cleared.upload ?? 0} upload${r.cleared.upload === 1 ? "" : "s"}). Everyone can use their own allowance again today.`);
    } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="adm-subsection">
      <span className="adm-label">TODAY&rsquo;S SHARED COUNT</span>
      <p className="adm-muted">The daily limit is shared by everyone. When it is nearly used, people see fewer than their own allowance (&ldquo;3 of 5 left&rdquo;) even after a reset. Clearing it starts today&rsquo;s count again from zero.</p>
      <button type="button" className="adm-btn" disabled={busy} onClick={run}>{busy ? "Working…" : "Clear today's shared count"}</button>
      {note && <p className="adm-note" role="status">{note}</p>}
    </div>
  );
}

function UserDetail({ env, id, onClose, onChanged }: { env: AdminEnv; id: string; onClose: () => void; onChanged: () => void }) {
  const { data, error, reload } = useLoad(view.user(env, id), [env.id, id]);
  useLiveRefresh(reload);
  const [busy, setBusy] = useState(false), [note, setNote] = useState("");
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [onClose]);
  const act = async (fn: () => Promise<any>, done: string | ((result: any) => string)) => {
    setBusy(true); setNote("");
    try { const result = await fn(); setNote(typeof done === "function" ? done(result) : done); await reload(); onChanged(); } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async (typed: string) => {
    setBusy(true); setNote("");
    try { await api.deleteUser(env, id, typed); onChanged(); onClose(); } catch (e) { setNote((e as Error).message); setBusy(false); }
  };
  if (error) return <aside className="adm-drawer"><button className="adm-link" onClick={onClose}>Close</button><Problem error={error} retry={reload} /></aside>;
  if (!data) return <aside className="adm-drawer"><Loading /></aside>;
  const u = data.user, isAdmin = !!u.is_admin;
  return (
    <aside className="adm-drawer" aria-label={"Account " + u.email}>
      <div className="adm-drawer-head"><div><span className="adm-label">ACCOUNT · {env.name.toUpperCase()}</span><h2>{u.email}</h2></div><button className="adm-link" onClick={onClose}>Close</button></div>
      <div className="adm-row"><Status value={u.status} />{u.status_reason && <small className="adm-muted">Reason: {u.status_reason}</small>}</div>
      {!isAdmin && (
        // Only what makes sense for the account's state. Pending: approve or
        // decline. Declined: approve after all, or delete. Approved: suspend,
        // browsers, password. Suspended: unsuspend.
        <div className="adm-actions">
          {(u.status === "pending" || u.status === "declined") && <button className="adm-btn primary" disabled={busy} onClick={() => act(() => api.setStatus(env, id, "approve"), "Approved. They've been emailed.")}>Approve</button>}
          {u.status === "pending" && <button className="adm-btn" disabled={busy} onClick={() => act(() => api.setStatus(env, id, "decline"), "Declined. They've been sent a polite note.")}>Decline</button>}
          {u.status === "approved" && <button className="adm-btn" disabled={busy} onClick={() => { const reason = prompt("Reason for suspending (shown to you only):"); if (reason !== null) act(() => api.setStatus(env, id, "suspend", reason || undefined), "Suspended. They're signed out everywhere."); }}>Suspend</button>}
          {u.status === "suspended" && <button className="adm-btn" disabled={busy} onClick={() => act(() => api.setStatus(env, id, "unsuspend"), "Unsuspended.")}>Unsuspend</button>}
          {u.status === "approved" && u.has_password && <button className="adm-btn" disabled={busy} onClick={() => { if (confirm(`Email ${u.email} a link to choose a new password?`)) act(() => api.passwordReset(env, id), `Reset link sent to ${u.email}.`); }}>Send password reset link</button>}
          {(u.status === "approved" || u.status === "suspended") && <button className="adm-btn" disabled={busy} onClick={() => { if (confirm(`Give ${u.email} their uploads and questions back?\n\nEverything they have used is cleared (in total and today).`)) act(() => api.resetUsage(env, id), (r) => "Limits reset: their uploads and questions are back." + sharedNote(r?.shared)); }}>Reset limits</button>}
          {u.status === "approved" && data.trusted_browsers?.length > 0 && <button className="adm-btn" disabled={busy} onClick={() => act(() => api.revokeBrowsers(env, id), "Trusted browsers revoked.")}>Revoke trusted browsers</button>}
          <button className="adm-btn danger" disabled={busy} onClick={() => { const typed = prompt(`This permanently deletes ${u.email} and all their documents, chats, notes and highlights.\n\nType their email to confirm:`); if (typed) remove(typed); }}>Delete account</button>
        </div>
      )}
      {isAdmin && <p className="adm-muted">This is the admin account; it can't be changed here.</p>}
      {note && <p className="adm-note" role="status">{note}</p>}
      <dl className="adm-facts">
        <dt>Joined</dt><dd>{when(u.created_at)}</dd>
        <dt>Presence</dt><dd><Presence u={u} /></dd>
        <dt>Last working</dt><dd>{u.status === "pending" || u.status === "declined" ? "—" : when(u.last_seen_at)}</dd>
        <dt>Sign-in</dt><dd>{[u.has_password ? "email" : null, ...(data.providers || [])].filter(Boolean).join(", ") || "—"}</dd>
        <dt>Documents</dt><dd>{data.documents.length}</dd>
        <dt>Questions</dt><dd>{data.questions}</dd>
        <dt>Highlights · notes</dt><dd>{data.highlights} · {data.notes}</dd>
        <dt>Storage</dt><dd>{bytes(data.storage_bytes)}</dd>
        <dt>Uploads used</dt><dd>{data.usage?.total?.upload ?? 0} in total · {data.usage?.today?.upload ?? 0} today</dd>
        <dt>Questions used</dt><dd>{data.usage?.total?.question ?? 0} in total · {data.usage?.today?.question ?? 0} today</dd>
      </dl>
      {data.documents.length > 0 && (<><span className="adm-label">DOCUMENTS</span>
        <ul className="adm-list">{data.documents.map((d: any) => <li key={d.id}><span>{d.filename}</span><small>{d.pages ?? "?"} pages · {when(d.ingested_at)}</small></li>)}</ul></>)}
      <span className="adm-label">TRUSTED BROWSERS</span>
      {data.trusted_browsers?.length
        ? <ul className="adm-list">{data.trusted_browsers.map((b: any) => <li key={b.id}><span>{b.label || "Browser"}</span><small>until {when(b.expires_at)}</small></li>)}</ul>
        : <p className="adm-muted">None.</p>}
      <span className="adm-label">RECENT ACTIVITY</span>
      <ul className="adm-feed">{data.events.slice(0, 30).map((e: any) => <EventRow key={e.id} e={e} />)}</ul>
    </aside>
  );
}

function EventRow({ e }: { e: any }) {
  return (
    <li className="adm-event">
      <time title={e.at}>{when(e.at)}</time>
      <strong>{eventLabel(e.type)}</strong>
      <span className="adm-ev-who">{e.email || "—"}</span>
      <span className="adm-ev-where">{[e.country, e.timezone].filter(Boolean).join(" · ") || ""}</span>
      <small>{detailText(e.detail)}</small>
    </li>
  );
}

function Users({ env, pendingOnly = false, onNotices }: { env: AdminEnv; pendingOnly?: boolean; onNotices?: () => void }) {
  const [query, setQuery] = useState(""), [status, setStatus] = useState(pendingOnly ? "pending" : "members"), [open, setOpen] = useState<string | null>(null);
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(query), 300); return () => clearTimeout(t); }, [query]);
  const { data, error, busy, reload } = useLoad(view.users(env, debounced, status), [env.id, debounced, status]);
  useLiveRefresh(reload);
  const [rowBusy, setRowBusy] = useState<string | null>(null), [note, setNote] = useState("");
  const quick = async (id: string, action: string, done: string) => {
    setRowBusy(id); setNote("");
    try { await api.setStatus(env, id, action); setNote(done); await reload(); } catch (e) { setNote((e as Error).message); } finally { setRowBusy(null); }
  };
  return (
    <div className="adm-stack">
      {pendingOnly && onNotices && <NotificationAlert key={env.id} env={env} onShow={onNotices} />}
      {!pendingOnly && (
        <div className="adm-filters">
          <input className="adm-search" type="search" placeholder="Search by email" aria-label="Search users" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="adm-seg" role="group" aria-label="Status">
            {/* Pending accounts live in Pending review; declined ones only under Declined. */}
            {[["members", "Members"], ["approved", "Approved"], ["suspended", "Suspended"], ["declined", "Declined"]].map(([v, n]) =>
              <button key={v} className={status === v ? "on" : ""} aria-pressed={status === v} onClick={() => setStatus(v)}>{n}</button>)}
          </div>
        </div>
      )}
      {note && <p className="adm-note" role="status">{note}</p>}
      {error ? <Problem error={error} retry={reload} /> : !data ? <Loading /> : data.items.length === 0 ? (
        <p className="adm-empty">{pendingOnly ? "Nobody is waiting for review." : "No accounts match."}</p>
      ) : (
        <div className="adm-table-wrap" aria-busy={busy}>
          <table className="adm-table">
            <thead><tr><th>Account</th><th>Status</th><th>Joined</th><th>Presence</th><th className="num">Docs</th><th className="num">Questions</th><th>{pendingOnly ? "Review" : "Sign-in"}</th></tr></thead>
            <tbody>{data.items.map((u: any) => (
              <tr key={u.id} className={open === u.id ? "on" : ""}>
                <td><button className="adm-link strong" onClick={() => setOpen(u.id)}>{u.email}</button>{u.is_admin && <span className="adm-tag">admin</span>}</td>
                <td><Status value={u.status} /></td>
                <td>{when(u.created_at)}</td>
                <td><Presence u={u} /></td>
                <td className="num">{u.documents}</td><td className="num">{u.questions}</td>
                <td>{pendingOnly
                  ? <span className="adm-row"><button className="adm-btn primary small" disabled={rowBusy === u.id} onClick={() => quick(u.id, "approve", `${u.email} approved and emailed.`)}>Approve</button>
                      <button className="adm-btn small" disabled={rowBusy === u.id} onClick={() => quick(u.id, "decline", `${u.email} declined; a polite note was sent.`)}>Decline</button></span>
                  : [u.has_password ? "email" : null, ...(u.providers || [])].filter(Boolean).join(", ")}</td>
              </tr>))}
            </tbody>
          </table>
          <p className="adm-muted">{data.total} {data.total === 1 ? "account" : "accounts"}{data.total > data.items.length ? ` · showing ${data.items.length}` : ""}</p>
        </div>
      )}
      {open && <UserDetail env={env} id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

const ACTIVITY_FILTERS: [string, string][] = [["", "All"], ["auth.login,auth.login_failed,auth.login_blocked", "Sign-ins"], ["auth.signup", "Sign-ups"],
  ["upload", "Uploads"], ["question", "Questions"], ["session.start", "Visits"], ["demo.request", "Demo requests"], ["admin.", "Admin"], ["auth.signup_refused,demo.request_refused", "Refused"], ["admin.notified", "Notifications"], ["email.failed", "Email problems"], ["server.start", "Server"]];

/** The filter is kept by the console, so a banner can open Activity on Notifications. */
function Activity({ env, type, setType }: { env: AdminEnv; type: string; setType: (t: string) => void }) {
  const { data, error, busy, reload, setData } = useLoad(view.events(env, type), [env.id, type]);
  const [more, setMore] = useState(false);
  const loadMore = async () => {
    if (!data?.items.length) return;
    setMore(true);
    try { const next = await api.events(env, { type, before_id: data.items[data.items.length - 1].id }); setData({ items: [...data.items, ...next.items] }); }
    finally { setMore(false); }
  };
  return (
    <div className="adm-stack">
      <div className="adm-seg wrap" role="group" aria-label="Activity type">
        {ACTIVITY_FILTERS.map(([v, n]) => <button key={n} className={type === v ? "on" : ""} aria-pressed={type === v} onClick={() => setType(v)}>{n}</button>)}
      </div>
      {error ? <Problem error={error} retry={reload} /> : !data ? <Loading /> : data.items.length === 0 ? <p className="adm-empty">Nothing yet.</p> : (<>
        <ul className="adm-feed" aria-busy={busy}>{data.items.map((e: any) => <EventRow key={e.id} e={e} />)}</ul>
        {data.items.length % 50 === 0 && <button className="adm-btn" disabled={more} onClick={loadMore}>{more ? "Loading…" : "Load more"}</button>}
      </>)}
      <p className="adm-fine">Country from the visitor&rsquo;s address via DB-IP Lite (IP Geolocation by DB-IP); the address itself is never stored.</p>
    </div>
  );
}

function Requests({ env }: { env: AdminEnv }) {
  const { data, error, reload } = useLoad(view.requests(env), [env.id]);
  const [busy, setBusy] = useState<string | null>(null), [note, setNote] = useState("");
  if (error) return <Problem error={error} retry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="adm-stack">
      {note && <p className="adm-note" role="status">{note}</p>}
      {data.items.length === 0 ? <p className="adm-empty">No demo requests yet.</p> : (
        <ul className="adm-cards">{data.items.map((r: any) => (
          <li key={r.id} className="adm-card">
            <div className="adm-row spread"><div><strong>{r.name}</strong> <span className="adm-muted">{r.email}</span></div><Status value={r.status} /></div>
            <p>{r.comment}</p>
            <div className="adm-row spread"><small className="adm-muted">{r.phone} · {when(r.at)}</small>
              {r.status === "pending" && <button className="adm-btn primary small" disabled={busy === r.id} onClick={async () => {
                setBusy(r.id); setNote("");
                try { await api.approveRequest(env, r.id); setNote(`${r.email} approved and emailed.`); await reload(); } catch (e) { setNote((e as Error).message); } finally { setBusy(null); }
              }}>Approve</button>}
            </div>
          </li>))}
        </ul>
      )}
    </div>
  );
}

function Samples({ env }: { env: AdminEnv }) {
  const { data, error, reload } = useLoad(view.samples(env), [env.id]);
  const [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true); setNote("");
    const failed: string[] = [];
    for (const f of Array.from(files)) { try { await api.addSample(env, f); } catch (e) { failed.push(`${f.name}: ${(e as Error).message}`); } }
    setNote(failed.length ? "Not added: " + failed.join("; ") : `${files.length} sample${files.length === 1 ? "" : "s"} added.`);
    if (input.current) input.current.value = "";
    setBusy(false); await reload();
  };
  const groups = useMemo(() => {
    const g: Record<string, any[]> = {};
    for (const s of data?.items || []) (g[s.kind] ||= []).push(s);
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [data]);
  if (error) return <Problem error={error} retry={reload} />;
  return (
    <div className="adm-stack">
      <div className="adm-row spread">
        <p className="adm-muted">Offered under &ldquo;Use a sample&rdquo; in Upload, sorted by type. Using one counts against the upload limit.</p>
        <label className="adm-btn primary">
          {busy ? "Uploading…" : "Add samples"}
          <input ref={input} type="file" multiple accept=".pdf,.docx,.pptx,.xlsx" hidden disabled={busy} onChange={(e) => upload(e.target.files)} />
        </label>
      </div>
      {note && <p className="adm-note" role="status">{note}</p>}
      {!data ? <Loading /> : groups.length === 0 ? <p className="adm-empty">No samples yet. Add PDF, Word, PowerPoint or Excel files.</p> :
        groups.map(([kind, items]) => (
          <section key={kind} className="adm-card">
            <span className="adm-label">{kind} · {items.length}</span>
            <ul className="adm-list">{items.map((s: any) => (
              <li key={s.id}>
                <span>{s.name} <small className="adm-muted">{s.filename} · {bytes(s.bytes)}</small></span>
                <span className="adm-row">
                  <button className="adm-link" onClick={async () => { const name = prompt("Sample name", s.name); if (name && name.trim()) { await api.renameSample(env, s.id, name.trim()); await reload(); } }}>Rename</button>
                  <button className="adm-link danger" onClick={async () => { if (confirm(`Remove “${s.name}” from the samples?`)) { await api.deleteSample(env, s.id); await reload(); } }}>Remove</button>
                </span>
              </li>))}
            </ul>
          </section>
        ))}
    </div>
  );
}

function Database({ env }: { env: AdminEnv }) {
  const { data, error, reload } = useLoad(view.database(env), [env.id]);
  if (error) return <Problem error={error} retry={reload} />;
  if (!data) return <Loading />;
  const d = data.database, v = data.vectors, disk = data.storage.disk;
  return (
    <div className="adm-stack">
      <div className="adm-tiles">
        <Tile label="DATABASE" value={bytes(d.bytes)} note={`${d.engine} · last write ${ago(d.modified_at)}`} />
        <Tile label="FILE STORAGE" value={disk ? bytes(disk.used_bytes) : "—"} note={disk ? `of ${bytes(disk.total_bytes)} (${Math.round((disk.used_bytes / disk.total_bytes) * 100)}% used)` : "unknown"} />
        <Tile label="VECTORS" value={v?.error ? "unavailable" : v?.points ?? "—"} note={v?.error ? v.error : `${v?.collection} · ${v?.status}`} />
      </div>
      <div className="adm-two">
        <section className="adm-card"><span className="adm-label">TABLES</span>
          <table className="adm-table compact"><tbody>{Object.entries(d.tables).map(([t, n]) => <tr key={t}><td>{t}</td><td className="num">{String(n)}</td></tr>)}</tbody></table>
        </section>
        <section className="adm-card"><span className="adm-label">STORAGE BY AREA</span>
          <table className="adm-table compact"><tbody>{Object.entries(data.storage.areas).map(([a, s]: [string, any]) => <tr key={a}><td>{a}</td><td className="num">{bytes(s.bytes)}</td><td className="num">{s.files} files</td></tr>)}</tbody></table>
          {/* Walking every file is slow, so the server keeps the totals a few minutes. */}
          {data.storage.measured_at && <p className="adm-fine">Measured {ago(data.storage.measured_at)}; refreshed every few minutes.</p>}
          {data.storage.refresh_error && <p className="adm-error">Couldn&rsquo;t measure again: {data.storage.refresh_error}</p>}
        </section>
      </div>
    </div>
  );
}

const every = (s: number) => (s === 3600 ? "checked hourly" : s === 86400 ? "checked daily" : s % 3600 === 0 ? `checked every ${s / 3600} h` : `checked every ${Math.round(s / 60)} min`);
const STATUS_CLASS: Record<string, string> = { up: "up", down: "down", "seems down": "degraded", paused: "pending", "not checked yet": "pending" };
const pct = (v?: number | null) => (v == null ? "—" : (v >= 99.995 ? "100" : v.toFixed(2)) + "%");
/** A response time; an API answer over a few seconds was a sleeping server waking. */
const responseText = (ms: number | null | undefined, kind: string) => {
  if (ms == null) return "no result yet";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s${kind === "api" && ms > 5000 ? " (includes waking the server)" : ""}`;
};
const dayClass = (u: number | null) => (u == null ? "none" : u >= 99.995 ? "ok" : u >= 95 ? "warn" : "bad");

/** Production uptime from UptimeRobot, with an on-demand check. */
function UptimeCard({ env }: { env: AdminEnv }) {
  const { data, error, reload } = useLoad(view.uptime(env), [env.id]);
  const [check, setCheck] = useState<any>(null), [checking, setChecking] = useState(false);
  const runCheck = async () => {
    setChecking(true); setCheck(null);
    const started = performance.now();
    let apiResult: any, site: any;
    try {
      await api.health(env, 90_000);
      apiResult = { ok: true, ms: Math.round(performance.now() - started) };
    } catch (e) { apiResult = { ok: false, ms: Math.round(performance.now() - started), error: (e as Error).message }; }
    if (apiResult.ok) {
      try {
        const r = await api.uptimeCheck(env);
        site = { ...r.website, from: "the server" };
        apiResult.woke = r.api.uptime_seconds < apiResult.ms / 1000 + 60 && apiResult.ms > 5000;
      } catch (e) { site = { ok: false, error: (e as Error).message, from: "the server" }; }
    } else if (env.site) {
      // The API is unreachable, so check the website from this browser instead.
      const t = performance.now();
      try { await fetch(env.site + "/", { mode: "no-cors", cache: "no-store" }); site = { ok: true, ms: Math.round(performance.now() - t), from: "your browser" }; }
      catch (e) { site = { ok: false, ms: Math.round(performance.now() - t), error: (e as Error).message, from: "your browser" }; }
    }
    setCheck({ at: new Date().toISOString(), api: apiResult, website: site });
    setChecking(false);
  };
  if (error) return <Problem error={"Uptime: " + error} retry={reload} />;
  if (!data) return <Loading />;
  if (!data.configured) return env.id === "prod"
    ? <section className="adm-card"><span className="adm-label">UPTIME</span><p className="adm-muted">Not set up on this server yet (UPTIMEROBOT_READONLY_KEY).</p></section>
    : null;
  return (
    <section className="adm-card adm-uptime" aria-label="Uptime">
      <div className="adm-row spread">
        <span className="adm-label">UPTIME · CHECKED BY UPTIMEROBOT · LAST {data.days} DAYS</span>
        <button className="adm-btn small" onClick={runCheck} disabled={checking}>{checking ? "Checking… (a sleeping server takes ~30 s)" : "Check now"}</button>
      </div>
      {check && (
        <div className="adm-check-result" role="status">
          <strong>Checked {when(check.at)}</strong>
          <span><Status value={check.api.ok ? "up" : "down"} /> API {check.api.ok ? `answered in ${responseText(check.api.ms, "api")}` : `didn’t answer: ${check.api.error}`}{check.api.woke ? " — it was asleep, so this included the wake-up" : ""}</span>
          {check.website && <span><Status value={check.website.ok ? "up" : "down"} /> Website {check.website.ok ? `answered in ${responseText(check.website.ms, "website")}${check.website.status_code ? ` (HTTP ${check.website.status_code})` : ""}` : `failed: ${check.website.error}`} · checked from {check.website.from}</span>}
        </div>
      )}
      <div className="adm-two">
        {data.monitors.map((m: any) => (
          <div key={m.id} className="adm-monitor">
            <div className="adm-row spread"><div><strong>{m.kind === "api" ? "API" : "Website"}</strong> <span className="adm-muted">{m.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span></div><Status value={STATUS_CLASS[m.status] || m.status} /></div>
            <p className="adm-big">{pct(m.uptime_30d)} <small>up · {every(m.interval_s)}</small></p>
            <p className="adm-muted">Last check {ago(m.last_check_at)} · {responseText(m.last_response_ms, m.kind)}</p>
            <div className="adm-days" role="img" aria-label={`${m.kind === "api" ? "API" : "Website"} uptime per day: ${m.daily.filter((d: any) => d.uptime != null).length} days with data`}>
              {m.daily.map((d: any) => <i key={d.day} className={dayClass(d.uptime)} title={`${new Date(d.day).toLocaleDateString([], { day: "numeric", month: "short" })}: ${d.uptime == null ? "no data (not checked yet)" : pct(d.uptime) + " up"}`} />)}
            </div>
            <table className="sr-only"><caption>Uptime per day</caption><tbody>{m.daily.map((d: any) => <tr key={d.day}><th>{d.day}</th><td>{d.uptime == null ? "no data" : pct(d.uptime)}</td></tr>)}</tbody></table>
            {m.incidents.length === 0 ? <p className="adm-fine">No problems in {data.days} days.</p> : (
              <ul className="adm-list">{m.incidents.slice(0, 5).map((x: any) => <li key={x.started_at}><span>Down {when(x.started_at)} for {duration(x.duration_s)}</span><small>{x.reason}</small></li>)}</ul>
            )}
          </div>
        ))}
      </div>
      <p className="adm-fine">Alerts go to the Citely inbox. The API is checked once a day because each check can wake the server; use Check now for an immediate look.</p>
    </section>
  );
}

function Server({ env }: { env: AdminEnv }) {
  const { data, error, reload } = useLoad(view.server(env), [env.id]);
  if (error) return <Problem error={error} retry={reload} />;
  if (!data) return <Loading />;
  const deps = Object.entries(data.dependencies || {}) as [string, any][];
  return (
    <div className="adm-stack">
      <UptimeCard env={env} />
      <NotificationsCard key={env.id} env={env} />
      <div className="adm-tiles">
        <Tile label="STATUS" value={<Status value={data.readiness === "ready" ? "ready" : data.readiness || "up"} />} note={`up ${duration(data.uptime_seconds)}`} />
        <Tile label="COLD STARTS" value={data.cold_starts_24h} note={`${data.cold_starts_7d} in 7 days · avg start ${data.average_startup_ms != null ? (data.average_startup_ms / 1000).toFixed(1) + " s" : "—"}`} />
        <Tile label="ERRORS (24 H)" value={data.errors_24h} note={`${data.requests_since_start.requests} requests since start`} />
        <Tile label="MEMORY PEAK" value={data.memory_peak_mb + " MB"} note={`Python ${data.python}`} />
      </div>
      <div className="adm-two">
        <section className="adm-card"><span className="adm-label">VERSION</span>
          <dl className="adm-facts"><dt>Image</dt><dd>{data.version}</dd><dt>Commit</dt><dd>{String(data.commit).slice(0, 7)}</dd>
            <dt>Revision</dt><dd>{data.revision || "—"}</dd><dt>Started</dt><dd>{when(data.started_at)}</dd></dl>
        </section>
        <section className="adm-card"><span className="adm-label">DEPENDENCIES</span>
          <dl className="adm-facts">{deps.map(([n, s]) => [<dt key={n + "t"}>{n}</dt>, <dd key={n + "d"}><Status value={s.state === "up" ? "ready" : s.state} /></dd>])}
            <dt>Country lookup</dt><dd>{data.country_lookup?.loaded ? <Status value="ready" /> : <span className="adm-error">{data.country_lookup?.error || "not loaded"}</span>}</dd></dl>
        </section>
      </div>
    </div>
  );
}

// ---- all environments ---------------------------------------------------------------

function AllEnvironments({ envs, onOpen }: { envs: AdminEnv[]; onOpen: (env: string) => void }) {
  return (
    <div className="adm-envs">
      {envs.map((env) => <EnvCard key={env.id} env={env} onOpen={() => onOpen(env.id)} />)}
    </div>
  );
}
function EnvCard({ env, onOpen }: { env: AdminEnv; onOpen: () => void }) {
  const signedIn = !!tokenFor(env.id);
  const overview = view.overview(env);
  const { data, error, reload } = useLoad<any>(signedIn ? overview : { key: `${env.id}:signed-out`, load: async () => null }, [env.id, signedIn]);
  useLiveRefresh(reload, signedIn);
  const days = (data?.per_day as any[]) || [], today = days[days.length - 1] || {};
  return (
    <section className="adm-card adm-env">
      <div className="adm-row spread"><div><span className="adm-label">{env.id.toUpperCase()}</span><h2>{env.name}</h2>{env.site && <a className="adm-muted" href={env.site} target="_blank" rel="noreferrer">{env.site.replace(/^https?:\/\//, "")}</a>}</div>
        <button className="adm-btn small" onClick={onOpen}>{signedIn ? "Open" : "Sign in"}</button></div>
      {!signedIn ? <p className="adm-muted">Not signed in to this environment.</p>
        : error ? <p className="adm-error">{error}</p>
        : !data ? <Loading />
        : <dl className="adm-facts">
            <dt>Users</dt><dd>{data.users.total}</dd><dt>Online now</dt><dd>{data.users.online_now}</dd>
            <dt>Pending review</dt><dd>{data.users.by_status.pending}</dd><dt>Today</dt><dd>{today.uploads || 0} uploads · {today.questions || 0} questions</dd>
            <dt>Errors today</dt><dd>{today.errors || 0}</dd></dl>}
    </section>
  );
}

// ---- the console ---------------------------------------------------------------

type EnvState = "checking" | "signin" | "ready" | "notadmin" | "unavailable" | "error";

export default function AdminApp() {
  // Sessions live in this browser's storage, which the prebuilt page can't
  // know: render the console only once mounted, so the first client render
  // matches the static HTML (a mismatch makes React rebuild the whole page,
  // theme included).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <Console /> : <div className="adm" aria-busy="true" />;
}

function Console() {
  const envs = useMemo(() => adminEnvs(), []);
  const [envId, setEnvId] = useState<string>(envs[0].id), [section, setSection] = useState<Section>("overview");
  // Each environment's state is kept separately, so switching back is instant.
  const [states, setStates] = useState<Record<string, EnvState>>({});
  const [problem, setProblem] = useState(""), [tick, setTick] = useState(0);
  const [googleCode, setGoogleCode] = useState<{ env: string; challenge: Challenge } | null>(null);
  const [finishing, setFinishing] = useState<string | null>(null);
  const [activityType, setActivityType] = useState("");
  const showNotices = () => { setActivityType("admin.notified"); setSection("activity"); };
  const env = envs.find((e) => e.id === envId) || envs[0];
  const all = envId === "all";
  // Confirmed as this environment's admin earlier in this tab: show it at once
  // (the check still runs, and a refusal still signs out or explains).
  const confirmed = (id: string) => { try { return !!tokenFor(id) && sessionStorage.getItem(`citely.admin.${id}.ok`) === "1"; } catch { return false; } };
  const state: EnvState = states[env.id] ?? (confirmed(env.id) ? "ready" : "checking");
  const setStateOf = useCallback((id: string, value: EnvState) => {
    try { value === "ready" ? sessionStorage.setItem(`citely.admin.${id}.ok`, "1") : sessionStorage.removeItem(`citely.admin.${id}.ok`); } catch { /* private browsing */ }
    setStates((all) => (all[id] === value ? all : { ...all, [id]: value }));
  }, []);
  const setState = useCallback((value: EnvState) => setStateOf(env.id, value), [env.id, setStateOf]);
  // A background request to another environment that failed, by environment:
  // shown on its tab, so a server that can't be reached is visible before switching.
  const [trouble, setTrouble] = useState<Record<string, string>>({});
  const noteTrouble = useCallback((id: string, message: string) => setTrouble((t) => ((t[id] || "") === message ? t : { ...t, [id]: message })), []);

  // #dev/users style links keep the place across reloads, and a typed or
  // linked address (or back/forward) moves to that place.
  useEffect(() => {
    const follow = () => {
      const [e, s] = location.hash.replace(/^#/, "").split("/");
      if (e && (e === "all" || envs.some((x) => x.id === e))) setEnvId(e);
      if (s && SECTIONS.some(([id]) => id === s)) setSection(s as Section);
    };
    follow();
    addEventListener("hashchange", follow);
    return () => removeEventListener("hashchange", follow);
  }, [envs]);
  useEffect(() => { history.replaceState(null, "", "#" + envId + (all ? "" : "/" + section)); }, [envId, section, all]);

  // Back from Google: drop its one-time code from the address (staying on
  // this page, so nothing navigates) and show that the sign-in is being finished (the server
  // exchanges Google's code and sends the sign-in code) instead of the form.
  useEffect(() => {
    const params = new URLSearchParams(location.search), stateParam = params.get("state") || "";
    if (!stateParam.startsWith("admin:")) return;
    const target = stateParam.split(":")[1];
    if (envs.some((e) => e.id === target)) setEnvId(target);
    if (params.get("error")) {
      setProblem(params.get("error") === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in didn't complete: " + params.get("error"));
      history.replaceState(null, "", location.pathname + "#" + target + "/overview");
      return;
    }
    if (!params.get("code")) return;
    setFinishing(target);
    googleCallback(params).then((r) => {
      history.replaceState(null, "", location.pathname + (r ? "#" + r.env.id + "/overview" : ""));
      setFinishing(null);
      if (!r) return;
      setEnvId(r.env.id);
      if (!r.step.done) setGoogleCode({ env: r.env.id, challenge: { ticket: r.step.ticket, sentTo: r.step.sentTo } });
      setTick((t) => t + 1);
    }).catch((e) => { setFinishing(null); setProblem(e.message); history.replaceState(null, "", location.pathname); });
  }, [envs]);

  // Loads what `s` shows first for another environment, into the shared
  // store, so switching there shows it straight away. Any /admin answer also
  // proves this browser holds that environment's admin session.
  const prefetch = useCallback((e: AdminEnv, s: Section, maxAgeMs: number) => {
    for (const v of SECTION_VIEWS[s](e)) {
      load(v.key, v.load, { maxAgeMs }).then(() => { noteTrouble(e.id, ""); if (tokenFor(e.id)) setStateOf(e.id, "ready"); },
        (err: AdminError) => noteTrouble(e.id, err.message));
    }
  }, [noteTrouble, setStateOf]);

  // Keep every signed-in environment's server awake while the console is in
  // use: each sleeps ~5 minutes after its last request and takes ~30 s to
  // start again. Every 3 minutes, only while this tab is visible and has had
  // input in the last 10 minutes (then they are left to sleep): the
  // environment on screen gets a health read, the others a refresh of the
  // section on screen, which keeps them awake and their data ready. On
  // opening, servers not signed in to are woken once too, so signing in to
  // one finds it up.
  const where = useRef({ envId, section });
  where.current = { envId, section };
  useEffect(() => {
    let first = true;
    const presence = whilePresent({
      run: () => {
        const { envId: current, section: s } = where.current;
        for (const e of envs) {
          const signed = !!tokenFor(e.id);
          if (e.id !== current && signed) prefetch(e, current === "all" ? "overview" : s, 0);
          // The one on screen is kept awake (on opening, its signed-in check
          // wakes it). One you're not signed in to elsewhere gets a single
          // wake-up when the console opens, not every few minutes: nobody is
          // using it, and the servers are paid by the second.
          else if (e.id === current ? !first || !signed : first)
            api.health(e, 90_000).then(() => noteTrouble(e.id, ""), (err: AdminError) => noteTrouble(e.id, err.message));
        }
        first = false;
      },
    });
    return () => presence.stop();
  }, [envs, prefetch, noteTrouble]);

  // A new section or environment on screen: get the same section ready in
  // the other signed-in environments (skipped where it was just loaded).
  useEffect(() => {
    const t = setTimeout(() => {
      for (const e of envs) if (e.id !== envId && tokenFor(e.id)) prefetch(e, all ? "overview" : section, FRESH_MS);
    }, 500);
    return () => clearTimeout(t);
  }, [envs, envId, section, all, prefetch]);

  // Is this environment signed in, and is the account its admin?
  useEffect(() => {
    if (all) return;
    let live = true;
    if (!tokenFor(env.id)) { setState("signin"); return; }
    if (!confirmed(env.id)) setState("checking");
    const overview = view.overview(env);   // shared with the Overview section's own request
    load(overview.key, overview.load, { maxAgeMs: FRESH_MS }).then(() => { if (live) setState("ready"); }).catch((e: AdminError) => {
      if (!live) return;
      if (e.status === 401) setState("signin");
      else if (e.status === 403) setState("notadmin");
      else if (e.status === 404) setState("unavailable");
      else if (e.status === null && confirmed(env.id)) { /* unreachable for now: keep what's shown; sections report their own errors */ }
      else { setState("error"); setProblem(e.message); }
    });
    return () => { live = false; };
  }, [env, all, tick, setState]);

  const pick = (id: string) => { setEnvId(id); setProblem(""); };
  const signOut = () => { signOutOf(env.id); setState("signin"); };

  return (
    <div className="adm">
      <header className="adm-top">
        <div className="adm-brand"><img src={asset("/branding/citely-04-app-tile.svg")} alt="" width="28" height="28" /><span>Citely <b>Admin</b></span></div>
        <nav className="adm-envtabs" aria-label="Environment">
          {envs.map((e) => <button key={e.id} className={envId === e.id ? "on" : ""} aria-current={envId === e.id ? "page" : undefined} onClick={() => pick(e.id)}>{e.name}{tokenFor(e.id) ? <i className={"adm-dot" + (trouble[e.id] ? " warn" : "")} aria-label={trouble[e.id] ? `signed in; last check failed: ${trouble[e.id]}` : "signed in"} title={trouble[e.id] || undefined} /> : null}</button>)}
          {envs.length > 1 && <button className={all ? "on" : ""} aria-current={all ? "page" : undefined} onClick={() => pick("all")}>All environments</button>}
        </nav>
        <div className="adm-top-end">
          {!all && state !== "signin" && !finishing && emailFor(env.id) && <AccountMenu env={env} email={emailFor(env.id)!} onSignOut={signOut} />}
          <ThemeButton />
        </div>
      </header>
      {all ? (
        <main className="adm-main wide">
          <div className="adm-head"><span className="adm-label">ADMIN</span><h1>All environments</h1><p className="adm-muted">Each is a separate server with its own database and accounts.</p></div>
          <AllEnvironments envs={envs} onOpen={(id) => pick(id)} />
        </main>
      ) : (
        <div className="adm-body">
          {state === "ready" && (
            <nav className="adm-nav" aria-label="Sections">
              {SECTIONS.map(([id, name]) => <button key={id} className={section === id ? "on" : ""} aria-current={section === id ? "page" : undefined} onClick={() => setSection(id)}>{name}</button>)}
            </nav>
          )}
          <main className="adm-main">
            {finishing ? (
              <section className="adm-signin" aria-busy="true">
                <span className="adm-label">ADMIN · {env.name.toUpperCase()}</span>
                <h1>Finishing Google sign-in…</h1>
                <p className="adm-muted" role="status">Checking your Google account with {env.name}&rsquo;s server. Your sign-in code is on its way.</p>
              </section>
            ) : (<>
            {state === "checking" && <Loading />}
            {state === "signin" && <SignInPanel key={env.id + (googleCode?.env === env.id ? googleCode.challenge.ticket : "")} env={env}
              initial={googleCode?.env === env.id ? googleCode.challenge : null} onDone={() => { setGoogleCode(null); setTick((t) => t + 1); }} />}
            {state === "notadmin" && <Problem error={`${emailFor(env.id) ? maskEmail(emailFor(env.id)!) : "This account"} isn't ${env.name}'s admin. Sign in with the Citely admin account.`} retry={signOut} />}
            {state === "unavailable" && <div className="adm-problem"><p><strong>{env.name}</strong> doesn&rsquo;t have the admin features yet. They arrive with its next release.</p></div>}
            {state === "error" && <Problem error={problem} retry={() => setTick((t) => t + 1)} />}
            {state === "ready" && (<>
              <div className="adm-head"><span className="adm-label">{env.name.toUpperCase()}{env.site ? " · " + env.site.replace(/^https?:\/\//, "") : ""}</span><h1>{SECTIONS.find(([id]) => id === section)?.[1]}</h1></div>
              {/* Keyed by environment: switching mounts the section afresh, so its
                  first paint is that environment's stored data, never a frame of the last one's. */}
              <Fragment key={env.id}>
              {section === "overview" && <Overview env={env} onNotices={showNotices} />}
              {section === "traffic" && <Traffic env={env} />}
              {section === "limits" && <Limits env={env} />}
              {section === "pending" && <Users env={env} pendingOnly onNotices={showNotices} />}
              {section === "users" && <Users env={env} />}
              {section === "activity" && <Activity env={env} type={activityType} setType={setActivityType} />}
              {section === "requests" && <Requests env={env} />}
              {section === "samples" && <Samples env={env} />}
              {section === "database" && <Database env={env} />}
              {section === "server" && <Server env={env} />}
              </Fragment>
            </>)}
            </>)}
            {problem && state !== "error" && <p className="adm-error" role="alert">{problem}</p>}
          </main>
        </div>
      )}
    </div>
  );
}
