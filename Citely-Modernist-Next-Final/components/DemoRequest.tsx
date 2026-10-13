"use client";
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Footer } from './Marketing';
import { ApiError, request } from '@/services/api';
import { ensureAwake } from '@/lib/wake';

export function DemoRequest() {
  const preview = process.env.NEXT_PUBLIC_DEMO_PREVIEW === 'true';
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const inFlight = useRef(false);
  const result = useRef<HTMLHeadingElement>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = Object.fromEntries(['name','email','phone','comment'].map(key => [key, String(data.get(key) || '').trim()]));
    if (Object.values(payload).some(value => !value)) { setError('Please complete all four fields.'); return; }
    if (!/^[+\d ().-]+$/.test(payload.phone) || payload.phone.replace(/\D/g, '').length < 7) { setError('Please enter a valid phone number, including your country code.'); return; }
    inFlight.current = true; setBusy(true); setError('');
    const signal = (controller.current = new AbortController()).signal;
    try {
      if (!preview) {
        await ensureAwake({signal, onState: state => setConnecting(state === 'waking')});
        await request('/demo-requests', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),timeout:60000,skipAuthRedirect:true,signal});
      }
      setSent(true);
      requestAnimationFrame(() => result.current?.focus());
    } catch (e) {
      if (signal.aborted) return;
      // A refusal of the details themselves (e.g. a temporary email address) says why;
      // anything else is a delivery problem worth retrying.
      setError(e instanceof ApiError && e.status === 400 ? e.detail
        : 'We could not confirm your request. Your details are still here. Please try again shortly.');
    } finally { inFlight.current = false; if (!signal.aborted) { setBusy(false); setConnecting(false); } }
  }
  return <><section className="demo-request">
    <div className="section-label"><span>CITELY / EARLY ACCESS</span><span>KNOWLEDGE, WITH RECEIPTS.</span></div>
    <div className="demo-request-grid">
      <div className="demo-request-story">
        <span className="tiny-label form-eyebrow">A LITTLE CONTEXT. A BETTER DEMO.</span>
        <h1>Your next<br/>good question<br/>starts <em>here.</em><sup aria-hidden="true">[1]</sup></h1>
        <p>Tell us what you’re working on.<br/>We’ll review your request to try Citely.</p>
        <div className="demo-request-note"><span className="tiny-label">ACCESS, WITH INTENTION.</span><p>We’re opening Citely to a small group of people. Demo access is by approval, so we can learn from the way you work.</p></div>
      </div>
      <div className="demo-request-form auth-form-wrap">
        {sent ? <div className="demo-request-success" role="status">
          <span className="tiny-label form-eyebrow">{preview ? 'PREVIEW COMPLETE' : 'REQUEST RECEIVED'}</span>
          <h2 ref={result} tabIndex={-1}>{preview ? 'That’s the first step.' : 'Thanks for the context.'}</h2>
          <p className="auth-subtitle">{preview ? 'This is a preview. No personal details were saved or emailed.' : 'Your demo request has been sent for review. Access is not automatic; we’ll contact you at the email you provided.'}</p>
          <Link className="btn primary" href="/">Back to Citely <span>↗</span></Link>
          {preview && <button className="text-link demo-preview-reset" onClick={() => setSent(false)}>Preview the form again</button>}
        </div> : <>
          <h2>Try Citely.</h2><p className="auth-subtitle">Your files. Your questions. A little about you.</p>
          {preview && <p className="demo-preview-notice">Preview only · This form will not send or save your details.</p>}
          <form onSubmit={submit}>
            <fieldset disabled={busy}>
              <div className="field"><label htmlFor="demo-name">Full name</label><input id="demo-name" name="name" autoComplete="name" placeholder="Your name" required maxLength={100}/></div>
              <div className="field"><label htmlFor="demo-email">Email address</label><input id="demo-email" name="email" type="email" autoComplete="email" placeholder="you@company.com" required maxLength={254}/></div>
              <div className="field"><label htmlFor="demo-phone">Phone number</label><input id="demo-phone" name="phone" type="tel" autoComplete="tel" placeholder="Include country code" required maxLength={40}/></div>
              <div className="field"><label htmlFor="demo-comment">Why would you like to try Citely?</label><textarea id="demo-comment" name="comment" placeholder="Tell us about your documents and what you’d like to do with them." rows={4} required maxLength={2000}/></div>
              <p className="demo-request-privacy">We’ll use these details to review and respond to your demo request. <Link href="/privacy/">Privacy policy ↗</Link></p>
              {error && <p className="auth-result" role="alert">{error}</p>}
              <button className="btn primary submit-button" type="submit">{busy ? connecting ? 'Connecting to Citely…' : 'Sending request…' : 'Request demo access'}<span>↗</span></button>
            </fieldset>
          </form>
        </>}
      </div>
    </div>
  </section><Footer /></>;
}
