"use client";

import { useEffect, useRef, useState } from "react";
import { asset } from "@/config";

export function ProductDemo() {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("keydown", close); previous?.focus(); };
  }, [open]);
  return <div className="product-demo product-demo-entry" data-testid="sample-demo">
    <div><span className="tiny-label">INTERACTIVE PRODUCT TOUR</span><h2>Explore the complete Citely workflow.</h2><p>Move from the file library into a document conversation, inspect exact citations, save evidence and return home—all with prepared sample data.</p></div>
    <button className="btn primary product-demo-open" onClick={() => setOpen(true)}>Open full demo <span>↗</span></button>
    <p className="product-demo-note">Full-page guided demo · No account required</p>
    {open && <div className="demo-disclaimer-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="demo-disclaimer" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="demo-disclaimer-title" aria-describedby="demo-disclaimer-copy">
        <button className="demo-disclaimer-close" onClick={() => setOpen(false)} aria-label="Close demo notice">×</button>
        <span className="tiny-label">BEFORE YOU ENTER</span><h2 id="demo-disclaimer-title">A guided sample, built to explore.</h2>
        <div id="demo-disclaimer-copy"><p>This demonstration uses synthetic documents, prepared questions and simulated responses.</p><p>It does not upload your files, contact Citely’s API, call an AI model or save activity to a Citely account. Its answers are examples and should not be treated as factual or professional advice.</p></div>
        <div className="demo-disclaimer-actions"><a className="btn primary" href={asset("/demo.html")} onClick={() => setOpen(false)}>Continue to full demo <span>→</span></a><button className="btn" onClick={() => setOpen(false)}>Go back</button></div>
      </div>
    </div>}
  </div>;
}
