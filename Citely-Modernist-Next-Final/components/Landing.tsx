"use client";
import { useEffect } from "react";
import { asset } from "@/lib/config";
import { Film, ProductDemo, Workflow, FAQ, Footer } from "./Marketing";
import { MarketingHeader } from "./Shell";
export default function Landing() {
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("visible");
            observer.unobserve(e.target);
          }
        }),
      { threshold: 0.08 },
    );
    document.querySelectorAll(".reveal").forEach((e) => observer.observe(e));
    document.documentElement.classList.add("js-ready");
    return () => {
      observer.disconnect();
      document.documentElement.classList.remove("js-ready");
    };
  }, []);
  return (
    <>
      <MarketingHeader />
      <section className="hero" id="top">
        <div className="hero-topline">
          <span>
            <i></i> BETA · KNOWLEDGE, WITH RECEIPTS.
          </span>
          <span>MADE FOR PEOPLE WHO ASK BETTER QUESTIONS.</span>
        </div>
        <div className="hero-heading">
          <h1>
            <span className="line">
              <span>The answer.</span>
            </span>
            <span className="line evidence-line">
              <span>
                And the <em>evidence.</em>
                <sup>[1]</sup>
              </span>
            </span>
          </h1>
          <div className="hero-bottom">
            <p>
              Your files have a lot to say.
              <br />
              Ask Citely. Get clear answers, follow every source,
              <br className="desktop-break" /> and keep your thinking in one
              place.
            </p>
            <div className="hero-ctas">
              <a className="btn primary" href={asset("/signin/") + "?mode=signup"}>
                Sign up <span>↗</span>
              </a>
              <a className="btn outline" href={asset("/try-demo/")}>
                Request demo <span>↗</span>
              </a>
              <a className="text-link" href="#film">
                Watch the demo <span>▷</span>
              </a>
            </div>
          </div>
        </div>
        <div className="hero-divider">
          <span>LESS SEARCHING. MORE KNOWING.</span>
          <span className="scroll-cue">
            SCROLL TO CONNECT THE DOTS <b>↓</b>
          </span>
        </div>
      </section>
      <Film />
      <section className="product-section" id="product">
        <div className="section-label reveal">
          <span>01 / FOLLOW THE EVIDENCE</span>
          <span>FROM QUESTION TO SOURCE.</span>
        </div>
        <ProductDemo />
      </section>
      <div className="moving-line" aria-hidden="true">
        <div>
          <span>READ BETWEEN THE FILES.</span>
          <i>↗</i>
          <span>THINK BEYOND THE TAB.</span>
          <i>↗</i>
          <span>READ BETWEEN THE FILES.</span>
          <i>↗</i>
          <span>THINK BEYOND THE TAB.</span>
          <i>↗</i>
        </div>
      </div>
      <Workflow />
      <section className="manifesto">
        <div className="manifesto-copy reveal">
          <span className="tiny-label">FOR THE WORK THAT NEEDS AN ANSWER.</span>
          <h2>
            Less “where was that?”
            <br />
            More <em>“here’s why.”</em>
          </h2>
          <p>
            For the finance review, the research project, the next big decision.
            <br />A workspace that keeps your answers close to their evidence.
          </p>
          <a className="btn light" href={asset("/try-demo/")}>
            Request demo access <span>↗</span>
          </a>
        </div>
        <div className="manifesto-side" aria-hidden="true">
          <span>[</span>
          <div className="rotating-word">
            <b>Sources.</b>
            <b>Answers.</b>
            <b>Clarity.</b>
          </div>
          <span>]</span>
        </div>
        <span className="manifesto-watermark" aria-hidden="true">
          cited.
        </span>
      </section>
      <FAQ />
      <section className="closing">
        <div className="reveal">
          <span className="tiny-label">
            YOUR NEXT GOOD QUESTION STARTS HERE.
          </span>
          <h2>
            Bring your files.
            <br />
            <em>Find your clarity.</em>
          </h2>
          <div className="closing-ctas">
            <a className="btn primary" href={asset("/signin/") + "?mode=signup"}>
              Sign up <span>↗</span>
            </a>
            <a className="btn outline" href={asset("/try-demo/")}>
              Request demo <span>↗</span>
            </a>
          </div>
        </div>
        <a
          className="closing-arrow"
          href={asset("/try-demo/")}
          aria-label="Try demo"
        >
          ↗
        </a>
      </section>
      <Footer />
    </>
  );
}
