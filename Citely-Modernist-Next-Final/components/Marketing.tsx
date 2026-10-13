"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Brand } from "./Brand";
import { asset, siteConfig } from "@/lib/config";
import { FAQ_CONTENT } from '@/lib/faq';
import { PRODUCT_DEFINITION } from '@/lib/seo-data.mjs';

// The product film (34 MB). Dev's host (Cloudflare Pages) refuses files over
// 25 MB, so the dev site plays production's copy; elsewhere it's local.
const FILM_URL = process.env.NEXT_PUBLIC_FILM_URL || asset("/citely-product-demo.mp4");
export const WORKFLOW_STAGES = [
  {
    name: "Collect the context.",
    description:
      "Bring your document into Citely. Start with the source you want to understand.",
    label: "ONE DOCUMENT. A CLEARER PICTURE.",
    title: (
      <>
        The connection is
        <br />
        the interesting part.
      </>
    ),
    items: [
      "Upload your document",
      "Wait for indexing",
      "Start a conversation",
    ],
    end: "↳ Ready for your question",
  },
  {
    name: "Follow the source.",
    description:
      "Read the answer and inspect its cited excerpts. Keep the evidence close to the question.",
    label: "EVERY ANSWER HAS A TRAIL.",
    title: (
      <>
        A claim.
        <br />
        And where it came from.
      </>
    ),
    items: [
      "Read the answer",
      "Select an inline citation",
      "Inspect the source excerpt",
    ],
    end: "↳ Evidence in view",
  },
  {
    name: "Keep the thinking.",
    description:
      "Return to your documents and saved conversations when the next question comes along.",
    label: "MAKE THE INSIGHT YOURS.",
    title: (
      <>
        Good thinking
        <br />
        deserves a place to stay.
      </>
    ),
    items: ["Return to Home", "Find your document", "Resume its conversation"],
    end: "↳ Ready for the next question",
  },
];
export function Film() {
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    const player = video.current;
    if (!player) return;
    // Initialize once; later native volume changes and the Mute button stay
    // under the visitor's control, including on pause/resume and loops.
    player.defaultMuted = false;
    player.muted = false;
    player.volume = 1;
    setMuted(false);
  }, []);
  const sync = () => {
    const v = video.current;
    if (v) setMuted(v.muted || v.volume === 0);
  };
  return (
    <section className="film-section" id="film" aria-labelledby="film-title">
      <div className="film-heading reveal">
        <div>
          <span className="tiny-label">CITELY, IN 82 SECONDS</span>
          <h2 id="film-title">See the thinking come together.</h2>
        </div>
        <p id="film-description">
          From a folder of files to an answer you can trace.
          <br />
          Voiceover, music, and on-screen captions.
        </p>
      </div>
      <div className="film-player reveal">
        <video
          key="receipts-82s-manual-sound"
          ref={video}
          controls
          loop
          playsInline
          preload="metadata"
          poster={asset("/citely-demo-poster.jpg")}
          aria-label="Citely product demo with voiceover and captions"
          aria-describedby="film-description"
          onVolumeChange={sync}
        >
          <source src={FILM_URL} type="video/mp4" />
          <track
            default
            kind="captions"
            src={asset("/citely-captions.vtt")}
            srcLang="en"
            label="English"
          />
          Your browser does not support embedded video.
        </video>
      </div>
      <div className="film-foot">
        <span>82 SEC / PRODUCT PREVIEW</span>
        <button
          className="film-audio"
          aria-pressed={muted}
          aria-label={muted ? "Unmute demo video" : "Mute demo video"}
          onClick={() => {
            const v = video.current;
            if (!v) return;
            if (v.muted || v.volume === 0) {
              v.muted = false;
              if (v.volume === 0) v.volume = 1;
            } else v.muted = true;
            sync();
          }}
        >
          {muted ? "Unmute" : "Mute"}
        </button>
        <a href={FILM_URL} download>
          Download the film ↓
        </a>
        <a href={asset("/try-demo/")}>Request demo access ↗</a>
      </div>
      <details className="film-transcript">
        <summary>
          Read the video transcript <span>+</span>
        </summary>
        <div>
          <p>Your files have a lot to say. Meet Citely, knowledge with receipts.</p>
          <p>Ask anything about your documents. Every answer comes with its sources.
            Click a citation and see the exact passage it came from.</p>
          <p>And every citation opens inside the original file. Word, Excel,
            PowerPoint, or PDF. The source is right there.</p>
          <p>Bring related files together and ask across all of them.
            Highlight what matters. Save your thinking for the next good question.</p>
          <p>Less searching, more knowing. Citely, grounded answers, cited.</p>
        </div>
      </details>
    </section>
  );
}
export { ProductDemo } from "./ProductDemo";
export function Workflow() {
  const [activeStage, setActiveStage] = useState(0);
  const s = WORKFLOW_STAGES[activeStage];
  return (
    <section className="workflow-section" id="workflow">
      <div className="section-label reveal">
        <span>02 / A BETTER WAY THROUGH</span>
        <span>YOUR THINKING, CONNECTED.</span>
      </div>
      <div className="workflow-grid">
        <div className="workflow-intro reveal">
          <h2>
            From a pile of files
            <br />
            to a point of view.
          </h2>
          <p>
            Bring the context. Follow the connections.
            <br />
            Make something worth keeping.
          </p>
          <p>{PRODUCT_DEFINITION}</p>
          <a className="text-link" href="#product">
            Take it for a spin <span>↗</span>
          </a>
        </div>
        <div
          className="workflow-stages"
          role="tablist"
          aria-label="Workflow stages"
        >
          {WORKFLOW_STAGES.map((x, i) => (
            <button
              key={x.name}
              id={"stage-" + i}
              role="tab"
              aria-selected={i === activeStage}
              aria-controls="workflow-panel"
              aria-expanded={i === activeStage}
              className={"stage " + (i === activeStage ? "active" : "")}
              onClick={() => setActiveStage(i)}
              onKeyDown={(e) => {
                if (
                  e.key === "ArrowDown" ||
                  e.key === "ArrowRight" ||
                  e.key === "ArrowUp" ||
                  e.key === "ArrowLeft"
                ) {
                  e.preventDefault();
                  const n =
                    (i +
                      (e.key === "ArrowUp" || e.key === "ArrowLeft" ? 2 : 1)) %
                    3;
                  setActiveStage(n);
                  document.getElementById("stage-" + n)?.focus();
                }
              }}
            >
              <span className="stage-number">0{i + 1}</span>
              <span>
                <strong>{x.name}</strong>
                <span className="stage-description">{x.description}</span>
              </span>
              <b>↗</b>
            </button>
          ))}
        </div>
      </div>
      <div
        className="workflow-display reveal"
        id="workflow-panel"
        role="tabpanel"
        aria-labelledby={"stage-" + activeStage}
        aria-live="polite"
      >
        <span className="display-index">0{activeStage + 1}</span>
        <div>
          <span className="tiny-label">{s.label}</span>
          <h3>{s.title}</h3>
        </div>
        <div className="workflow-example" key={activeStage}>
          {s.items.map((x) => (
            <span key={x}>{x}</span>
          ))}
          <strong>{s.end}</strong>
        </div>
      </div>
    </section>
  );
}
export function FAQ() {
  return (
    <section className="faq-section" id="faq">
      <div className="faq-intro reveal">
        <span className="tiny-label">03 / A FEW GOOD QUESTIONS</span>
        <h2>Glad you asked.</h2>
        <p>The essentials, before you jump in.</p>
      </div>
      <div className="faq-list reveal">
        {FAQ_CONTENT.map((x, i) => (
          <details key={x.q} open={i === 0}>
            <summary>
              {x.q}
              <span>+</span>
            </summary>
            <p>{x.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
export function Footer() {
  const InstagramIcon=()=> <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>;
  const XIcon=()=> <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4l14 16M19 4L5 20"/></svg>;
  return (
    <footer className="site-footer">
      <Link className="wordmark" href="/" aria-label="Citely home">
        <Brand decorative />
      </Link>
      <span>GROUNDED ANSWERS, CITED.</span>
      <div style={{flexWrap:'wrap'}}>
        <Link href="/privacy">Privacy</Link>
        <Link href="/how-it-works/">How it works</Link>
        <Link href="/features/document-chat/">Document chat</Link>
        <Link href="/features/source-citations/">Source citations</Link>
        <Link href="/documentation/">Documentation</Link>
        <Link href="/about/">About</Link>
        <a className="social-link" href="https://www.instagram.com/citely.example/" target="_blank" rel="noopener noreferrer"><InstagramIcon/><span>Instagram</span><i>↗</i></a>
        <a className="social-link" href="https://x.com/citely-example" target="_blank" rel="noopener noreferrer" aria-label="Citely on X (Twitter)"><XIcon/><span>Twitter</span><i>↗</i></a>
      </div>
      <small>© 2026 Citely. All rights reserved. · {siteConfig.licenseText}</small>
    </footer>
  );
}
