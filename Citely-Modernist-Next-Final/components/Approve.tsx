"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { approveAccess, getApproval } from "@/services/api";
import { ensureAwake } from "@/lib/wake";

type State =
  | { step: "loading" }
  | { step: "ask"; email: string; account: boolean }
  | { step: "done"; email: string; newly: boolean; account: boolean }
  | { step: "already"; email: string }
  | { step: "error"; message: string };

// Opened from the "Review and approve" button in an access-request email.
// Shows who the link is for and approves only on a press, once: mail
// scanners open links on their own and must never approve anyone.
export function ApprovePage() {
  const token = useSearchParams().get("token") || "";
  const [state, setState] = useState<State>({ step: "loading" });
  const [waking, setWaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const pressed = useRef(false);

  useEffect(() => {
    if (!token) { setState({ step: "error", message: "This approval link is incomplete. Open it again from the email." }); return; }
    const c = new AbortController();
    ensureAwake({ signal: c.signal, onState: (s) => setWaking(s === "waking") })
      .then(() => getApproval(token))
      .then((r) => setState(r.approved ? { step: "already", email: r.email } : { step: "ask", email: r.email, account: !!r.account }))
      .catch((e) => { if (!c.signal.aborted) setState({ step: "error", message: e.message || "Could not open this link. Try again." }); })
      .finally(() => setWaking(false));
    return () => c.abort();
  }, [token]);

  async function approve() {
    if (pressed.current) return;
    pressed.current = true;
    setBusy(true);
    try {
      const r = await approveAccess(token);
      setState({ step: "done", email: r.email, newly: !!r.newly, account: !!r.account });
    } catch (e) {
      pressed.current = false;
      setBusy(false);
      setState({ step: "error", message: (e as Error).message || "Could not approve. Try again." });
    }
  }

  return (
    <section className="account-simple approve-page" aria-live="polite">
      {state.step === "loading" && (<><h1>Opening the request…</h1><p>{waking ? "The server is waking up. This takes about half a minute." : "One moment."}</p></>)}
      {state.step === "ask" && (<>
        <span className="eyebrow">{state.account ? "ACCOUNT REVIEW" : "ACCESS REQUEST"}</span>
        <h1>{state.account ? "Approve this account?" : "Approve access?"}</h1>
        {state.account
          ? <p>Let <strong>{state.email}</strong> start using Citely. They&rsquo;ll get an email saying they&rsquo;re approved.</p>
          : <p>Allow <strong>{state.email}</strong> to create a Citely account. They&rsquo;ll get an email inviting them to sign up.</p>}
        <button className="btn primary" onClick={approve} disabled={busy}>{busy ? "Approving…" : "Approve"}</button>
      </>)}
      {state.step === "done" && (<>
        <span className="eyebrow">APPROVED</span>
        <h1>{state.account ? `${state.email} is approved.` : `${state.email} can now sign up.`}</h1>
        <p>{!state.newly ? "They were already approved; no second email was sent."
          : state.account ? "We've emailed them that they can sign in." : "We've emailed them the sign-up link."}</p>
        <Link className="btn" href="/">Go to Citely</Link>
      </>)}
      {state.step === "already" && (<>
        <h1>Already approved</h1>
        <p><strong>{state.email}</strong> already has access. Nothing more to do.</p>
        <Link className="btn" href="/">Go to Citely</Link>
      </>)}
      {state.step === "error" && (<>
        <h1>This link can&rsquo;t be used</h1>
        <p>{state.message}</p>
        <Link className="btn" href="/">Go to Citely</Link>
      </>)}
    </section>
  );
}
