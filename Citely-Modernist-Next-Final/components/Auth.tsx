"use client";
import { useCallback, useEffect, useState, useRef, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import Editorial from "./Editorial";
import { adapter, landingFor, needsCode, type CodeChallenge, type Session } from "@/lib/adapter";
import { ApiError, getMe, SIGNIN_NOTICE_KEY } from "@/services/api";
import { asset } from "@/config";
import { ensureAwake, markServerUnknown, wakingMessage, WakeCancelledError } from "@/lib/wake";
import { ThemeButton, useSession } from "./Shell";
import { Turnstile, TURNSTILE_SITE_KEY } from "./Turnstile";
import { passwordChecks, passwordStrength } from "@/lib/password-rules.mjs";

const RETRY_AFTER_WAKE =
  "The server took too long to respond. It is ready now — please try again.";
const isTransient = (e: unknown) => e instanceof ApiError && e.isTransient;
const isCancelled = (e: unknown) =>
  e instanceof WakeCancelledError || (e instanceof ApiError && e.isCancelled);

/** Starts waking the backend when the page opens, so it is usually ready by
 *  the time the form is submitted. `wait()` resolves once it is ready. */
function useWake() {
  const [waking, setWaking] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => {
    const c = new AbortController();
    ctrl.current = c;
    ensureAwake({ signal: c.signal, onState: (s) => setWaking(s === "waking") })
      .catch(() => {})
      .finally(() => {
        if (!c.signal.aborted) setWaking(false);
      });
    return () => c.abort();
  }, []);
  const wait = useCallback(async () => {
    const c = ctrl.current;
    try {
      await ensureAwake({ signal: c?.signal, onState: (s) => setWaking(s === "waking") });
    } finally {
      if (!c?.signal.aborted) setWaking(false);
    }
  }, []);
  return { waking, wait };
}

function WakingStatus({ waking }: { waking: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!waking) return;
    const started = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => clearInterval(id);
  }, [waking]);
  return waking ? (
    <div className="auth-result" role="status">
      {wakingMessage(elapsed)}
    </div>
  ) : null;
}
export function PasswordField({
  label = "Password",
  value,
  onChange,
  id = "password",
  confirm = false,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  id?: string;
  confirm?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-input">
        <input
          id={id}
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          minLength={confirm ? 12 : 1}
          maxLength={128}
          autoComplete={confirm ? "new-password" : "current-password"}
        />
        <button
          type="button"
          aria-label={(show ? "Hide " : "Show ") + label.toLowerCase()}
          aria-pressed={show}
          onClick={() => setShow(!show)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
            <circle cx="12" cy="12" r="3" />
            {show && <path d="m3 3 18 18" />}
          </svg>
        </button>
      </div>
    </div>
  );
}
/** Live checklist under a new password. The server applies the same rules
 *  (and also rejects the most common passwords). */
export function PasswordChecklist({ password, email = "" }: { password: string; email?: string }) {
  if (!password) return null;
  const checks = passwordChecks(password, email), strength = passwordStrength(password, email);
  return (
    <div className="password-checklist" aria-live="polite">
      <div className={`password-meter ${strength}`}><span /><b>{strength === "strong" ? "Strong" : strength === "fair" ? "Good" : "Too weak"}</b></div>
      <ul>
        {checks.map((c) => (
          <li key={c.id} className={c.ok ? "ok" : ""}>{c.ok ? "✓" : "•"} {c.label}</li>
        ))}
      </ul>
    </div>
  );
}

export function EmailField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor="email">Email address</label>
      <input
        id="email"
        type="email"
        required
        autoComplete="email"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="you@company.com"
        maxLength={254}
      />
    </div>
  );
}
function ErrorMessage({ error }: { error: string }) {
  return error ? (
    <div className="auth-result" role="alert">
      {error}
    </div>
  ) : null;
}
/** "Check your inbox": the code emailed to an approved account at sign-in.
 *  Trusting the browser skips this step there for 30 days. */
export function CodeStep({ challenge, onDone, onCancel }: {
  challenge: CodeChallenge; onDone: (session: Session) => void; onCancel: () => void;
}) {
  const [ticket, setTicket] = useState(challenge.ticket),
    [sentTo, setSentTo] = useState(challenge.sentTo),
    [code, setCode] = useState(""),
    [trust, setTrust] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [cooldown, setCooldown] = useState(60);
  const inFlight = useRef(false);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try { await action(); }
    catch (err) { setError((err as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => onDone(await adapter.enterCode(ticket, code, trust)));
  };
  const resend = () => run(async () => {
    const next = await adapter.resendLoginCode(ticket);
    setTicket(next.ticket);
    setSentTo(next.sent_to);
    setCode("");
    setCooldown(60);
  });
  return (
    <div className="code-step">
      <span className="tiny-label form-eyebrow">CONFIRM IT&rsquo;S YOU.</span>
      <h2>Check your inbox.</h2>
      <p className="auth-subtitle">Enter the 6-digit code we sent to <strong>{sentTo}</strong>.</p>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <div className="field">
            <label htmlFor="login-code">Sign-in code</label>
            <input id="login-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
          </div>
          <label className="trust-check">
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
            <span>Trust this browser for 30 days</span>
          </label>
          <p className="notice">Don&rsquo;t tick this on a shared or public computer. No email yet? Check your spam folder.</p>
          <button type="submit" className="btn primary submit-button" disabled={code.length !== 6}>
            {busy ? "Please wait…" : "Verify and sign in"} <span>↗</span>
          </button>
        </fieldset>
      </form>
      <ErrorMessage error={error} />
      <button className="switch-mode" disabled={busy || cooldown > 0} onClick={resend} aria-live="polite">
        {cooldown ? "Resend in " + cooldown + "s" : "Resend code"}
      </button>
      <button className="switch-mode" disabled={busy} onClick={onCancel}>Use a different account</button>
    </div>
  );
}

// A quick, on-the-page hint for the most common personal mailboxes; the
// server decides with the full list (APP/auth/lists/personal_domains.txt).
const PERSONAL_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com",
  "yahoo.co.in", "yahoo.co.uk", "ymail.com", "rocketmail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
  "pm.me", "rediffmail.com", "zoho.com", "zohomail.in", "gmx.com", "mail.com", "yandex.com", "tutanota.com"]);
const looksPersonal = (email: string) => PERSONAL_DOMAINS.has(email.trim().toLowerCase().split("@")[1] || "");

export function SignIn() {
  const query = useSearchParams(),
    router = useRouter();
  const { setSession } = useSession();
  // "signup" is for people whose access was approved (the approval email
  // links here); everyone else requests access from the demo page.
  const [mode, setMode] = useState<"signin" | "signup">(query.get("mode") === "signup" ? "signup" : "signin"),
    [email, setEmail] = useState(query.get("email") || ""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [captcha, setCaptcha] = useState(""),
    [captchaReset, setCaptchaReset] = useState(0),
    [challenge, setChallenge] = useState<CodeChallenge | null>(null);
  const signup = mode === "signup";
  const [suspended, setSuspended] = useState(query.get("reason") === "suspended");
  // Signed out by a suspension while in the workspace: the note says why.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(SIGNIN_NOTICE_KEY) === "suspended") setSuspended(true);
      sessionStorage.removeItem(SIGNIN_NOTICE_KEY);
    } catch { /* private browsing */ }
  }, []);
  const arrive = (session: Session) => { setSession(session); router.push(landingFor(session)); };
  const wake = useWake();
  // `busy` disables the form only after React re-renders; a second Enter
  // press can land before that. The ref blocks it synchronously.
  const inFlight = useRef(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await wake.wait();
      if (signup) {
        if (TURNSTILE_SITE_KEY && !captcha) throw Error("Please complete the human check.");
        try {
          await adapter.signUp(email, password, captcha);
        } catch (err) {
          // Never repeated automatically: a second attempt could send another
          // verification email. Wait for the server, then let the user decide.
          if (!isTransient(err)) throw err;
          markServerUnknown();
          await wake.wait();
          throw Error(RETRY_AFTER_WAKE);
        } finally {
          // A human-check token works once; get a fresh one for any retry.
          setCaptcha("");
          setCaptchaReset((n) => n + 1);
        }
        router.push("/verify-email?email=" + encodeURIComponent(email.trim()));
        return;
      }
      let result;
      try {
        result = await adapter.signIn(email, password);
      } catch (err) {
        // Logging in again has no side effect beyond (at most) a fresh code,
        // so one retry after the server is confirmed ready is safe.
        if (!isTransient(err)) throw err;
        markServerUnknown();
        await wake.wait();
        result = await adapter.signIn(email, password);
      }
      if (needsCode(result)) setChallenge(result);
      else arrive(result);
    } catch (err) {
      if (!isCancelled(err)) setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const switchMode = (next: "signin" | "signup") => {
    setMode(next);
    setError("");
    router.replace(next === "signup" ? "/signin/?mode=signup" : "/signin/");
  };
  const oauth = async (provider: "google" | "github") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      // The provider hands back a single-use code. It must be exchanged
      // against a server that is already up: a timeout there cannot be retried.
      await wake.wait();
      const url = await adapter.oauthStart(provider);
      const target = new URL(url, window.location.origin);
      if (!["http:", "https:"].includes(target.protocol))
        throw Error("Invalid authentication redirect.");
      window.location.assign(target.href);
    } catch (err) {
      if (!isCancelled(err)) setError((err as Error).message);
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="auth-page">
      <div className="auth-shell">
        <Editorial />
        <section className="auth-main">
          <div className="auth-top">
            <Link href="/" className="back-link">← Back to Citely</Link>
            <ThemeButton />
          </div>
          <div className="auth-form-wrap">
            {challenge ? (
              <CodeStep challenge={challenge} onDone={arrive} onCancel={() => { setChallenge(null); setPassword(""); }} />
            ) : (<>
            <span className="tiny-label form-eyebrow">
              {signup ? "NEW TO CITELY." : "EXISTING MEMBERS."}
            </span>
            <h2>
              {signup ? "Create your account." : "Back to better thinking."}
            </h2>
            <p className="auth-subtitle">
              {signup
                ? "Create your account. We review new accounts and email you as soon as you’re in."
                : "Sign in to your Citely account."}
            </p>
            {signup && (
              <p className="auth-policy">
                <strong>Personal email</strong> (Gmail, Outlook, iCloud…)? Continue with Google or GitHub.{" "}
                <strong>Work email?</strong> Create an account with your email and a password below.
              </p>
            )}
            {suspended && !signup && (
              <p className="auth-result" role="alert">
                This account is suspended. If you think this is a mistake, contact hello@citely.example.
              </p>
            )}
            <div className="provider-buttons">
              <button
                className="provider"
                disabled={busy}
                onClick={() => oauth("github")}
              >
                <svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.8-1.33-3.8-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.62 1.22 3.26.94.1-.73.39-1.22.71-1.5-2.5-.29-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.01-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.08 1.15a10.65 10.65 0 0 1 5.6 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.55.23 2.7.12 2.98.72.78 1.16 1.78 1.16 3.01 0 4.32-2.63 5.27-5.14 5.55.4.35.76 1.03.76 2.08v3.1c0 .3.2.65.78.54A11.2 11.2 0 0 0 12 .8Z"></path>
                </svg>
                Continue with GitHub
              </button>
              <button
                className="provider"
                disabled={busy}
                onClick={() => oauth("google")}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path
                    d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.89-1.74 2.98-4.3 2.98-7.36Z"
                    fill={"var(--provider-4285F4)"}
                  ></path>
                  <path
                    d="M12 22c2.7 0 4.96-.89 6.62-2.41l-3.24-2.51c-.89.6-2.03.96-3.38.96-2.6 0-4.81-1.76-5.6-4.12H3.05v2.59A10 10 0 0 0 12 22Z"
                    fill={"var(--provider-34A853)"}
                  ></path>
                  <path
                    d="M6.4 13.92a6 6 0 0 1 0-3.84V7.49H3.05a10 10 0 0 0 0 9.02l3.35-2.59Z"
                    fill={"var(--provider-FBBC05)"}
                  ></path>
                  <path
                    d="M12 5.96c1.47 0 2.79.51 3.82 1.51l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.95 5.49l3.35 2.59C7.19 7.72 9.4 5.96 12 5.96Z"
                    fill={"var(--provider-EA4335)"}
                  ></path>
                </svg>
                Continue with Google
              </button>
            </div>
            <div className="auth-divider">
              <span>{signup ? "or sign up with a work email" : "or continue with email"}</span>
            </div>
            <form onSubmit={submit}>
              <fieldset disabled={busy}>
                <EmailField value={email} onChange={setEmail} />
                {signup && looksPersonal(email) && (
                  <p className="auth-hint" role="status">
                    That&rsquo;s a personal address: please use <strong>Continue with Google</strong> or <strong>GitHub</strong> above.
                    Email and password sign-up is for work addresses.
                  </p>
                )}
                <PasswordField
                  value={password}
                  onChange={setPassword}
                  confirm={signup}
                />
                {signup ? (
                  <>
                    <PasswordChecklist password={password} email={email} />
                    <Turnstile onToken={setCaptcha} resetKey={captchaReset} onError={setError} />
                  </>
                ) : (
                  <Link className="forgot" href="/forgot-password">
                    Forgot password?
                  </Link>
                )}
                <button
                  className="btn primary submit-button"
                  type="submit"
                  disabled={signup && (looksPersonal(email) || passwordStrength(password, email) === "weak" || (!!TURNSTILE_SITE_KEY && !captcha))}
                >
                  {busy
                    ? wake.waking
                      ? "Waking up the server…"
                      : "Please wait…"
                    : signup
                      ? "Create account"
                      : "Log in"}
                  <span>↗</span>
                </button>
              </fieldset>
            </form>
            <WakingStatus waking={wake.waking} />
            <ErrorMessage error={error} />
            {signup ? (
              <button className="switch-mode" disabled={busy} onClick={() => switchMode("signin")}>
                Already have an account? Log in
              </button>
            ) : (
              <>
                <button className="switch-mode" disabled={busy} onClick={() => switchMode("signup")}>
                  New here? Create an account
                </button>
                <Link className="switch-mode" href="/try-demo/">Prefer a guided look? Request demo access ↗</Link>
              </>
            )}
            </>)}
          </div>
          <footer className="auth-foot">
            <span>Citely · Grounded answers, cited.</span>
            <Link href="/#faq">Have a question? ↗</Link>
          </footer>
        </section>
      </div>
    </div>
  );
}
export function AccountPage({
  kind,
}: {
  kind: "verify" | "forgot" | "reset" | "callback";
}) {
  const query = useSearchParams(),
    router = useRouter(),
    { setSession } = useSession();
  const [email, setEmail] = useState(query.get("email") || ""),
    [code, setCode] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [sent, setSent] = useState(false),
    [sentNote, setSentNote] = useState(""),
    [cooldown, setCooldown] = useState(kind === "verify" ? 60 : 0);
  const token = query.get("token");
  const started = useRef(false);
  const wake = useWake();
  const inFlight = useRef(false);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  const [challenge, setChallenge] = useState<CodeChallenge | null>(null);
  const arrive = (s: Session) => { setSession(s); router.replace(landingFor(s)); };
  useEffect(() => {
    if (kind !== "callback" || started.current) return;
    started.current = true;
    // Deliberately not cancelled on cleanup: the provider's code is single-use,
    // so this exchange must run to completion exactly once. Waiting for the
    // server first means it is never spent against a backend that is starting.
    const params = new URLSearchParams(query.toString());
    ensureAwake()
      .then(() => adapter.oauthCallback(params))
      .then((result) => {
        if (needsCode(result)) { setChallenge(result); return; }
        setSession(result);
        router.replace(landingFor(result));
      })
      .catch((e) => setError(e.message));
  }, [kind, query, router, setSession]);
  /** Runs an action that must not be repeated automatically (it sends an
   *  email, consumes a code or a reset token). On a transient failure it waits
   *  until the server is ready and asks the user to resubmit. */
  const once = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await wake.wait();
      try {
        await action();
      } catch (err) {
        if (!isTransient(err)) throw err;
        markServerUnknown();
        await wake.wait();
        throw Error(RETRY_AFTER_WAKE);
      }
    } catch (err) {
      if (!isCancelled(err)) setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (kind === "reset" && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    return once(async () => {
      if (kind === "verify") {
        const session = await adapter.verifyEmail(email, code);
        setSession(session);
        router.push(landingFor(session));
      }
      if (kind === "forgot") {
        const answer = await adapter.forgotPassword(email);
        // Work accounts are reset by the admin; the server says so.
        setSentNote(answer?.admin_reset ? answer.detail : "");
        setSent(true);
      }
      if (kind === "reset") {
        await adapter.resetPassword(email, token!, password);
        router.push("/signin");
      }
    });
  };
  const resend = () =>
    once(async () => {
      await adapter.resendCode(email);
      setCooldown(60);
    });
  if (kind === "callback" && challenge)
    return (
      <section className="account-simple">
        <CodeStep challenge={challenge} onDone={arrive} onCancel={() => router.replace("/signin")} />
      </section>
    );
  if (kind === "callback")
    return (
      <section className="account-simple" role="status">
        <h1>{error ? "Could not sign you in." : "Signing you in…"}</h1>
        {!error && <WakingStatus waking={wake.waking} />}
        <ErrorMessage error={error} />
        {error && <Link href="/signin">Back to sign in</Link>}
      </section>
    );
  if (kind === "reset" && (!query.get("email") || !token))
    return (
      <section className="account-simple">
        <h1>This link is invalid.</h1>
        <Link className="btn primary" href="/forgot-password">
          Request a new link
        </Link>
      </section>
    );
  return (
    <section className="account-simple">
      <span className="tiny-label form-eyebrow">YOUR SPACE TO THINK.</span>
      <h1>
        {kind === "verify"
          ? "Check your inbox."
          : kind === "forgot"
            ? "Let’s get you back in."
            : "A fresh start."}
      </h1>
      <p className="auth-subtitle">
        {kind === "verify"
          ? `Enter the 6-digit code sent to ${email || "your email address"}.`
          : kind === "forgot"
            ? "Enter your email to request a password reset."
            : "Choose a new password for your account."}
      </p>
      {sent ? (
        <div role="status" className="auth-result">
          {sentNote || "If an account can receive a reset email, instructions will arrive shortly. Check your inbox and spam folder."}
        </div>
      ) : (
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            {(kind === "forgot" ||
              (kind === "verify" && !query.get("email"))) && (
              <EmailField value={email} onChange={setEmail} />
            )}{" "}
            {kind === "verify" && (
              <>
                <div className="field">
                  <label htmlFor="code">Verification code</label>
                  <input
                    id="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                  />
                </div>
                <p className="notice">No email yet? Check your spam folder.</p>
              </>
            )}
            {kind === "reset" && (
              <>
                <PasswordField
                  label="New password"
                  value={password}
                  onChange={setPassword}
                  confirm
                />
                <PasswordChecklist password={password} email={email} />
                <PasswordField
                  id="confirm-password"
                  label="Confirm password"
                  value={confirm}
                  onChange={setConfirm}
                  confirm
                />
              </>
            )}
            <button type="submit" className="btn primary submit-button">
              {busy
                ? wake.waking
                  ? "Waking up the server…"
                  : "Please wait…"
                : kind === "verify"
                  ? "Verify and continue"
                  : kind === "forgot"
                    ? "Send reset link"
                    : "Reset password"}
            </button>
          </fieldset>
        </form>
      )}
      {kind === "verify" && (
        <button
          className="switch-mode"
          disabled={busy || cooldown > 0}
          onClick={resend}
          aria-live="polite"
        >
          {cooldown ? "Resend in " + cooldown + "s" : "Resend code"}
        </button>
      )}
      <WakingStatus waking={wake.waking} />
      <ErrorMessage error={error} />
      <Link className="switch-mode" href="/signin">
        Back to sign in
      </Link>
    </section>
  );
}


/** Where a signed-in account waits while it is reviewed, or learns it wasn't
 *  approved. An approved account is sent on to the workspace. */
export function ReviewStatus() {
  const router = useRouter();
  const [state, setState] = useState<{ status: string; email: string } | null>(null),
    [error, setError] = useState(""),
    [checking, setChecking] = useState(false);
  const { waking, wait } = useWake();
  const check = useCallback(async () => {
    setChecking(true);
    setError("");
    try {
      await wait();
      const me = await getMe();
      if (me.status === "approved") { router.replace("/home"); return; }
      setState({ status: me.status, email: me.email });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { router.replace("/signin"); return; }
      if (!isCancelled(err)) setError((err as Error).message);
    } finally { setChecking(false); }
  }, [router, wait]);
  useEffect(() => { void check(); }, [check]);
  const signOut = async () => { await adapter.signOut(); router.replace("/signin"); };
  const declined = state?.status === "declined";
  return (
    <section className="account-simple review-page" aria-live="polite">
      {!state && !error && (<><h1>Checking your account…</h1><WakingStatus waking={waking} /></>)}
      {state && (<>
        <span className="tiny-label form-eyebrow">{declined ? "YOUR ACCOUNT." : "ALMOST THERE."}</span>
        <h1>{declined ? "Your account wasn’t approved this time." : "Your account is under review."}</h1>
        <p className="auth-subtitle">
          {declined
            ? <>Citely is in a limited preview, and we&rsquo;re opening it step by step. You can still explore the interactive demo. Think this was a mistake? Write to <a href="mailto:hello@citely.example">hello@citely.example</a>.</>
            : <>We&rsquo;ll email you at <strong>{state.email}</strong> as soon as it&rsquo;s approved. Until then, try the interactive demo with sample files.</>}
        </p>
        <a className="btn primary submit-button" href={asset("/demo.html")}>Try the demo <span>↗</span></a>
        {!declined && <button className="switch-mode" onClick={check} disabled={checking}>{checking ? "Checking…" : "Check again"}</button>}
        <button className="switch-mode" onClick={signOut}>Sign out</button>
      </>)}
      <ErrorMessage error={error} />
    </section>
  );
}
