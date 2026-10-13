"use client";
import { useEffect } from "react";
import { asset } from "@/config";
import { RequireAuth, useSession } from "@/components/Shell";
import { siteConfig } from "@/lib/config";
export default function Page() {
 const {session} = useSession();
 useEffect(() => { if(session?.acceptedPrivacyVersion === siteConfig.privacyVersion) location.replace(asset('/studio.html')); },[session]);
 return <RequireAuth><div className="status-page">Opening your workspace…</div></RequireAuth>;
}
