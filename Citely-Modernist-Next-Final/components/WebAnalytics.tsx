"use client";
// Cloudflare Web Analytics: page views and visits without cookies or any
// account data. Loaded once per page load, in the browser, so a visitor
// never wakes the API. Pages whose address can carry a one-time code or
// token (sign-in return, password reset, email links) are never counted, and
// neither is the admin console.
import { useEffect } from "react";
import { usePathname } from "next/navigation";

const TOKEN = process.env.NEXT_PUBLIC_CF_BEACON_TOKEN || "";
const NEVER = ["/auth/callback", "/reset-password", "/verify-email", "/approve", "/admin"];

export const countsPage = (path: string) => {
  const p = path.replace(/\/+$/, "") || "/";
  return !NEVER.some((n) => p === n || p.startsWith(n + "/"));
};

export function WebAnalytics() {
  const path = usePathname();
  useEffect(() => {
    if (!/^[a-f0-9]{32}$/.test(TOKEN) || !countsPage(path)) return;
    if (document.querySelector("script[data-cf-beacon]")) return;
    const s = document.createElement("script");
    s.defer = true;
    s.src = "https://static.cloudflareinsights.com/beacon.min.js";
    s.dataset.cfBeacon = JSON.stringify({ token: TOKEN });
    document.head.appendChild(s);
  }, [path]);
  return null;
}
