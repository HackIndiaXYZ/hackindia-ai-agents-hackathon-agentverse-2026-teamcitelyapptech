"use client";

// Uses the existing approved policy configuration; does not change consent rules.
// Inherits the application shell and its theme. Do not add a second global header.
import Link from "next/link";
import { siteConfig } from "@/lib/config";

export default function PrivacyPage() {
  const sections = siteConfig.privacySections;
  const version = siteConfig.privacyVersion;
  const effectiveDate = siteConfig.privacyEffectiveDate;
  const pending = !sections.length || /REPLACE_|pending|to be supplied/i.test(
    [version, effectiveDate, ...sections.map(s => s.heading)].join(" ")
  );
  return (
    <article className="citely-policy" id="policy-top" aria-labelledby="policy-title">
      <div className="policy-inner">
        <div className="policy-topline">
          <Link href="/" className="policy-back">← Back to Citely</Link>
          <span>YOUR INFORMATION / YOUR CONTEXT</span>
        </div>
        <header className="policy-hero">
          <p className="policy-eyebrow">CITELY / PRIVACY</p>
          <h1 id="policy-title">Privacy,<br /><em>in plain sight.</em></h1>
          <p className="policy-intro">Read the privacy policy that applies to your use of Citely.</p>
          <div className="policy-meta">
            <div><span>DOCUMENT</span><strong>Privacy policy</strong></div>
            <div><span>EFFECTIVE DATE</span><strong>{pending ? "Pending publication" : effectiveDate}</strong></div>
            <div><span>VERSION</span><strong>{/REPLACE_/i.test(version) ? "Pending publication" : version}</strong></div>
            <button type="button" onClick={() => window.print()}>Print policy ↗</button>
          </div>
        </header>
        {pending && <p className="policy-notice" role="status">The privacy policy is awaiting publication. The text below is a placeholder, not a finalized policy.</p>}
        <div className="policy-layout">
          <nav className="policy-index" aria-label="Privacy policy sections">
            <h2>On this page</h2>
            <ol>{sections.map((section, i) => <li key={i}>
              <a href={`#policy-section-${i + 1}`}><span>{String(i + 1).padStart(2, "0")}</span>{section.heading}</a>
            </li>)}</ol>
          </nav>
          <div className="policy-reading">
            {sections.map((section, i) => <section id={`policy-section-${i + 1}`} key={i} aria-labelledby={`policy-heading-${i + 1}`} tabIndex={-1}>
              <span className="policy-number">{String(i + 1).padStart(2, "0")} / POLICY</span>
              <h2 id={`policy-heading-${i + 1}`}>{section.heading}</h2>
              <p>{section.body}</p>
            </section>)}
            {!sections.length && <p>The published policy will appear here when available.</p>}
            <div className="policy-end"><span>END OF POLICY</span><a href="#policy-top">Back to top ↑</a></div>
          </div>
        </div>
        <footer className="policy-footer"><span>CITELY — GROUNDED ANSWERS, CITED.</span><Link href="/">Return to website ↗</Link></footer>
      </div>
      <style jsx>{`
        .citely-policy{--p-bg:#f3f2ed;--p-text:#20211e;--p-muted:#595b53;--p-line:#cbcbbf;--p-accent:#b9311e;--p-soft:#e8e7de;background:var(--p-bg);color:var(--p-text);font-family:var(--font-dm-sans),'DM Sans',Arial,sans-serif;min-height:100vh;font-size:1rem;line-height:1.7;background-image:linear-gradient(to right,transparent calc(100% - 1px),#8888880b 1px);background-size:120px 100%}
        :global(html[data-theme="dark"]) .citely-policy,:global(body[data-mode="dark"]) .citely-policy{--p-bg:#1e1f1c;--p-text:#f2f1e9;--p-muted:#bdbeb3;--p-line:#45473e;--p-accent:#ff6249;--p-soft:#292b25}
        @media(prefers-color-scheme:dark){:global(html:not([data-theme])) .citely-policy{--p-bg:#1e1f1c;--p-text:#f2f1e9;--p-muted:#bdbeb3;--p-line:#45473e;--p-accent:#ff6249;--p-soft:#292b25}}
        .policy-inner{width:100%;margin:0;padding:0 clamp(1.25rem,4vw,5rem)}
        .policy-topline{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:28px 0;border-bottom:1px solid var(--p-line)}
        .policy-topline>span,.policy-eyebrow,.policy-number,.policy-meta div>span,.policy-end>span,.policy-footer>span{font-size:.875rem;letter-spacing:.075em;font-weight:600}
        .policy-topline>span{color:var(--p-muted)}
        .citely-policy :global(a){color:inherit;text-decoration:none;text-underline-offset:5px}
        .citely-policy :global(a:hover){text-decoration:underline}
        .citely-policy :global(a:focus-visible),button:focus-visible,section:focus-visible{outline:3px solid var(--p-accent);outline-offset:5px}
        .policy-hero{padding-top:54px}
        .policy-eyebrow{color:var(--p-accent);margin:0 0 22px}
        h1{font-family:var(--font-archivo),Archivo,Arial,sans-serif;font-size:clamp(2.25rem,4.5vw,4rem);line-height:1.02;letter-spacing:-.055em;font-weight:800;margin:0;overflow-wrap:break-word}
        h1 em{color:var(--p-accent);font-style:normal}
        .policy-intro{max-width:52ch;font-size:1.25rem;color:var(--p-muted);margin:28px 0 40px;line-height:1.6}
        .policy-meta{display:flex;flex-wrap:wrap;align-items:center;gap:24px 40px;border-top:6px solid var(--p-accent);border-bottom:1px solid var(--p-line);padding:24px 0}
        .policy-meta div{display:grid;gap:5px}.policy-meta div>span{color:var(--p-muted)}.policy-meta strong{font-size:1rem;font-weight:500;overflow-wrap:anywhere}
        button{background:var(--p-soft);border:1px solid var(--p-line);color:var(--p-text);font:inherit;font-weight:600;padding:11px 18px;cursor:pointer;min-height:44px;margin-left:auto}
        button:hover{border-color:var(--p-accent)}
        .policy-notice{padding:18px 22px;background:var(--p-soft);border-left:4px solid var(--p-accent);margin:28px 0 0}
        .policy-layout{display:grid;grid-template-columns:clamp(220px,18vw,340px) minmax(0,1fr);gap:clamp(40px,6vw,120px);padding:56px 0 72px}
        .policy-index{position:sticky;top:28px;align-self:start}.policy-index h2{font-size:1rem;font-weight:700;margin:0 0 16px}.policy-index ol{list-style:none;padding:0;margin:0;border-top:1px solid var(--p-line)}
        .policy-index li{border-bottom:1px solid var(--p-line)}.policy-index a{display:flex;gap:12px;padding:14px 0;font-size:1rem;line-height:1.5;overflow-wrap:anywhere}.policy-index a span{color:var(--p-accent);font-size:.875rem;padding-top:2px}
        .policy-reading{width:100%;min-width:0}.policy-reading section{display:grid;grid-template-columns:minmax(210px,.38fr) minmax(420px,1fr);column-gap:clamp(32px,5vw,96px);scroll-margin-top:100px;padding:0 0 42px;margin-bottom:40px;border-bottom:1px solid var(--p-line)}
        .policy-number{color:var(--p-accent);grid-column:1}.policy-reading h2{grid-column:1;font-family:var(--font-archivo),Archivo,Arial,sans-serif;font-size:clamp(1.5rem,2.5vw,2.25rem);line-height:1.25;letter-spacing:-.025em;margin:12px 0 20px;overflow-wrap:anywhere}.policy-reading p{grid-column:2;grid-row:1/span 2;font-size:1.125rem;line-height:1.8;margin:0;max-width:92ch;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--p-text)}
        .policy-end,.policy-footer{display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}.policy-end>span{color:var(--p-muted)}.policy-end a{font-size:1rem}
        .policy-footer{border-top:1px solid var(--p-line);padding:24px 0 36px}.policy-footer>span{color:var(--p-muted)}
        @media(max-width:980px){.policy-reading section{grid-template-columns:1fr}.policy-reading p{grid-column:1;grid-row:auto}.policy-layout{gap:40px}}
        @media(max-width:720px){.policy-inner{padding-inline:20px}.policy-topline>span{display:none}.policy-hero{padding-top:36px}.policy-meta{gap:20px;width:100%}.policy-meta>div{flex:1 1 135px}button{margin:0}.policy-layout{grid-template-columns:1fr;gap:36px;padding-top:36px}.policy-index{position:static}.policy-reading p{font-size:1rem;line-height:1.8}.policy-intro{font-size:1.125rem}.policy-footer{align-items:flex-start;flex-direction:column}}
        @media print{.citely-policy{--p-bg:white!important;--p-text:black!important;--p-muted:#444!important;--p-line:#aaa!important;--p-accent:#222!important;background:white!important;color:black!important}.policy-topline,.policy-index,button,.policy-end,.policy-footer{display:none}.policy-inner{padding:0;max-width:none}.policy-hero{padding:0}h1{font-size:36pt}.policy-intro{font-size:12pt}.policy-meta{border-top:2px solid black}.policy-layout{display:block;padding-top:24px}.policy-reading{max-width:none}.policy-reading section{margin-bottom:18px;padding-bottom:18px}.policy-reading h2{break-after:avoid}.policy-reading p{font-size:11pt;orphans:3;widows:3}}
      `}</style>
    </article>
  );
}
