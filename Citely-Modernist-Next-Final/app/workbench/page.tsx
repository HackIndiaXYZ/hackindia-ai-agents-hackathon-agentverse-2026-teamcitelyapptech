"use client";
import { useEffect } from "react";
import { asset } from "@/config";
export default function Page() { useEffect(() => { const q = new URLSearchParams(location.search); const id = q.get("document") || q.get("document_id"); if (id) q.set("desk", id); location.replace(asset("/studio.html") + (q.size ? "?" + q : "")); }, []); return <div className="status-page">Opening your workspace…</div>; }
