"use client";
import { useEffect, useRef } from "react";

// Cloudflare Turnstile: a privacy-friendly human check, usually invisible.
// Shown only when NEXT_PUBLIC_TURNSTILE_SITE_KEY is set; the server enforces
// it only when its TURNSTILE_SECRET_KEY is set.
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";

type Api = { render: (el: HTMLElement, opts: Record<string, unknown>) => string; reset: (id: string) => void; remove: (id: string) => void };
declare global { interface Window { turnstile?: Api } }

let loading: Promise<Api> | null = null;
function load(): Promise<Api> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return (loading ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(Error("Turnstile unavailable")));
    s.onerror = () => { loading = null; reject(Error("Couldn't load the human check. Check your connection and reload.")); };
    document.head.appendChild(s);
  }));
}

/** Renders the check and reports its token ("" when it expires or is reset).
 *  Bump `resetKey` after a submit: a token can be used only once. */
export function Turnstile({ onToken, resetKey, onError }: { onToken: (t: string) => void; resetKey: number; onError?: (m: string) => void }) {
  const host = useRef<HTMLDivElement>(null), widget = useRef<string | null>(null);
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !host.current) return;
    let cancelled = false;
    load().then(api => {
      if (cancelled || !host.current) return;
      if (widget.current) api.remove(widget.current);
      widget.current = api.render(host.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
        callback: (t: string) => onToken(t),
        "expired-callback": () => onToken(""),
        "error-callback": () => { onToken(""); onError?.("The human check failed. Please try again."); },
      });
    }).catch(e => onError?.((e as Error).message));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);
  if (!TURNSTILE_SITE_KEY) return null;
  return <div className="turnstile-slot" ref={host} data-testid="turnstile" />;
}
