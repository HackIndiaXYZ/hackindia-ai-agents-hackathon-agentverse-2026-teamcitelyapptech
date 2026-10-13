"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
import Link from "next/link";
import { Brand } from "./Brand";
import { usePathname, useRouter } from "next/navigation";
import { adapter, type Session } from "@/lib/adapter";
import { whilePresent } from "@/lib/presence.mjs";
import { siteConfig } from "@/lib/config";
import { WebAnalytics } from "./WebAnalytics";
const Context = createContext<{
  session: Session | null;
  loading: boolean;
  setSession: (s: Session | null) => void;
  connection: string;
}>({
  session: null,
  loading: true,
  setSession: () => {},
  connection: "checking",
});
export const useSession = () => useContext(Context);
export function Logo() {
  return (
    <Link className="wordmark" href="/" aria-label="Citely home">
      <Brand decorative />
    </Link>
  );
}
export function Connectivity() {
  const { connection } = useSession();
  return (
    <span className="connectivity" role="status" title="Backend connectivity">
      ● {connection}
    </span>
  );
}
export function ThemeButton() {
  const [theme, setTheme] = useState("light");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme || "light");
  }, []);
  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("citely-modernist-mode", next);
    } catch {}
  };
  return (
    <button
      className="mode-switch"
      onClick={toggle}
      aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
      aria-pressed={theme === "dark"}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2" />
      </svg>
    </button>
  );
}
export function MarketingHeader() {
  const path = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [path]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  return (
    <header className="site-header marketing-header">
      <Logo />
      <nav aria-label="Main navigation">
        <Link href="/#product">Product</Link>
        <Link href="/#workflow">How it works</Link>
        <Link href="/#faq">Questions</Link>
        <details className="learn-menu" ref={menu}>
          <summary>Learn <span aria-hidden="true">⌄</span></summary>
          <div className="learn-menu-links" onClick={() => { if (menu.current) menu.current.open = false; }}>
            <Link href="/how-it-works/">How Citely works</Link>
            <Link href="/features/document-chat/">Document chat</Link>
            <Link href="/features/source-citations/">Source citations</Link>
            <Link href="/documentation/">Documentation</Link>
            <Link href="/about/">About Citely</Link>
          </div>
        </details>
      </nav>
      <div className="nav-actions">
        <ThemeButton />
        <Link className="btn outline small nav-request" href="/try-demo/">Request demo <span>↗</span></Link>
        <Link className="btn primary small" href="/signin/?mode=signup">Sign up <span>↗</span></Link>
      </div>
    </header>
  );
}
const ADMIN_SITE = process.env.NEXT_PUBLIC_ADMIN_SITE === "true";
export function Shell({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [connection, setConnection] = useState("checking"),
    [theme, setTheme] = useState("light"),
    [error, setError] = useState("");
  const path = usePathname();
  const normalizedPath = path.replace(/\/$/, '');
  const marketingPage = ['/try-demo', '/privacy', '/how-it-works', '/features/document-chat', '/features/source-citations', '/about'].includes(normalizedPath) || normalizedPath === '/documentation' || normalizedPath.startsWith('/documentation/');
  // The admin console (admin.citely.example, or /admin locally) runs its own
  // sessions per environment: no site header, no session read, no wake checks.
  const adminPage = ADMIN_SITE || normalizedPath === '/admin' || normalizedPath.startsWith('/admin/');
  const publicPage = path === "/" || marketingPage || adminPage;
  const hasOwnHeader = path === "/" || ["/signin", "/verify-email", "/forgot-password", "/reset-password", "/auth/callback", "/home", "/workbench", "/review"].includes(path.replace(/\/$/, ""));
  const router = useRouter();
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme || "light");
    // Public sample interactions never hydrate a real account or wake the API.
    // Keep protected routes loading until their own session read completes.
    setLoading(true);
    if (publicPage) return;
    let active = true;
    adapter.session()
      .then(value => { if (active) setSession(value); })
      .catch(() => { if (active) setSession(null); })
      .finally(() => { if (active) setLoading(false); });
    const check = () =>
      adapter
        .connectivity((s) => {
          if (active) setConnection(s);
        })
        .catch(() => {
          if (active) setConnection("offline");
        });
    const presence = whilePresent({
      run: check,
      intervalMs: 60_000,
      waitForInput: false,
    });
    return () => {
      active = false;
      presence.stop();
    };
  }, [publicPage]);
  const toggle = () => {
    const t = theme === "light" ? "dark" : "light";
    setTheme(t);
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("citely-modernist-mode", t);
    } catch {}
  };
  const signOut = async () => {
    try {
      await adapter.signOut();
      setSession(null);
      router.push("/signin");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (adminPage) return <>{children}</>;
  return (
    <Context.Provider value={{ session, loading, setSession, connection }}>
      <WebAnalytics />
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {marketingPage && <MarketingHeader />}
      {!hasOwnHeader && !marketingPage && <header className="site-header">
        <Logo />
        <nav aria-label="Main navigation">
          <Link href="/#product">Product</Link>
          <Link href="/#workflow">How it works</Link>
          <Link href="/home">Home</Link>
        </nav>
        <div className="nav-actions">
          <Connectivity />
          <button
            className="mode-switch"
            onClick={toggle}
            aria-label={
              "Switch to " + (theme === "light" ? "dark" : "light") + " mode"
            }
            aria-pressed={theme === "dark"}
          >
            {theme === "light" ? "☼" : "☾"}
          </button>
          {session ? (
            <button onClick={signOut}>Sign out</button>
          ) : null}
          {!session && (
            <>
              <Link className="btn outline small nav-request" href="/try-demo/">
                Request demo <span>↗</span>
              </Link>
              <Link className="btn primary small" href="/signin/?mode=signup">
                Sign up <span>↗</span>
              </Link>
            </>
          )}
        </div>
      </header>}
      {error && <p role="alert">{error}</p>}
      <main id="main-content" tabIndex={-1}>
        {children}
      </main>
      {session &&
        !publicPage &&
        session.acceptedPrivacyVersion !== siteConfig.privacyVersion && (
          <Consent onSignOut={signOut} />
        )}
    </Context.Provider>
  );
}
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!loading && !session) router.replace("/signin");
  }, [loading, session, router]);
  return loading ? (
    <div className="status-page" role="status">
      Loading your workspace…
    </div>
  ) : session ? (
    <>{children}</>
  ) : (
    <div className="status-page">Redirecting to sign in…</div>
  );
}
function Consent({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const { setSession } = useSession();
  const ref = useRef<HTMLDialogElement>(null),
    scroll = useRef<HTMLDivElement>(null);
  const [read, setRead] = useState(false),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
    const el = scroll.current;
    const check = () => {
      if (el && el.scrollHeight - el.clientHeight <= 2) setRead(true);
    };
    check();
    const obs = new ResizeObserver(check);
    if (el) obs.observe(el);
    return () => obs.disconnect();
  }, []);
  const accept = async () => {
    setBusy(true);
    try {
      setSession(await adapter.acceptPrivacy(siteConfig.privacyVersion));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={ref}
      className="consent-modal"
      aria-labelledby="consent-title"
      onCancel={(e) => e.preventDefault()}
    >
      <h2 id="consent-title">Your privacy, before we begin.</h2>
      <div
        className="policy-scroll"
        ref={scroll}
        tabIndex={0}
        onScroll={(e) => {
          const t = e.currentTarget;
          if (t.scrollHeight - t.scrollTop - t.clientHeight < 4) setRead(true);
        }}
      >
        {siteConfig.privacySections.map((s) => (
          <section key={s.heading}>
            <h3>{s.heading}</h3>
            <p>{s.body}</p>
          </section>
        ))}
      </div>
      <Link target="_blank" href="/privacy">
        Read the full policy ↗
      </Link>
      <label className="consent-check">
        <input
          type="checkbox"
          checked={checked}
          disabled={!read || busy}
          onChange={(e) => setChecked(e.target.checked)}
        />{" "}
        I have read and agree to the privacy policy.
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="inline-actions">
        <button
          className="btn primary"
          disabled={
            !checked ||
            busy ||
            siteConfig.privacyVersion === "REPLACE_WITH_CURRENT_POLICY_VERSION"
          }
          onClick={accept}
        >
          {busy ? "Saving…" : "I agree"}
        </button>
        <button disabled={busy} onClick={onSignOut}>
          Sign out instead
        </button>
      </div>
    </dialog>
  );
}
