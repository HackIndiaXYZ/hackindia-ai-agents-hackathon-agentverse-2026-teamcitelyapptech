import { asset } from "@/lib/config";
import { Logo } from "./Shell";
export default function Editorial() {
  return (
    <aside className="auth-editorial">
      <Logo />
      <div className="auth-story">
        <span className="tiny-label">A LITTLE CONTEXT. A LOT OF CLARITY.</span>
        <h1>
          Your next
          <br />
          good question
          <br />
          starts <em>here.</em>
          <sup>[1]</sup>
        </h1>
        <div className="auth-evidence">
          <span>01 / SOURCE</span>
          <div className="evidence-lines" aria-hidden="true">
            <i></i>
            <i></i>
            <i></i>
            <i></i>
          </div>
          <p>
            “Good decisions begin
            <br />
            with something you can <mark>point to.</mark>”
          </p>
          <span>
            02 / UNDERSTANDING <b>↗</b>
          </span>
        </div>
      </div>
      <div className="auth-editorial-foot">
        <span>GROUNDED ANSWERS, CITED.</span>
        <a href={asset("/")}>Back to website ↗</a>
      </div>
      <div className="auth-running-type" aria-hidden="true">
        source. answer. clarity.
      </div>
    </aside>
  );
}
