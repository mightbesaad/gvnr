import { Hono } from 'hono';
import type { Env } from '../lib/types';

const b2b = new Hono<{ Bindings: Env }>();

b2b.get('/', (c) => {
  c.header('X-Frame-Options', 'DENY');
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  c.header('X-Content-Type-Options', 'nosniff');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gvnr for businesses</title>
  <meta name="description" content="Direct B2B adoption of the Gvnr substrate — five primitives over REST and MCP, per-account isolation, SEPA EUR invoice arrangements via email. Single-region, solo-maintained, no SLA today.">
  <meta name="robots" content="index, follow">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 48px 24px; min-height: 100vh; line-height: 1.55; }
    .container { max-width: 720px; margin: 0 auto; }
    h1 { font-size: 1.8rem; font-weight: 700; letter-spacing: -0.025em; margin-bottom: 8px; background: linear-gradient(180deg,#fff,#bababa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .sub { color: #888; font-size: 0.92rem; margin-bottom: 44px; line-height: 1.6; }
    h2 { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #555; margin-bottom: 16px; }
    section { margin-bottom: 44px; }
    p { font-size: 0.92rem; color: #aaa; line-height: 1.75; margin-bottom: 14px; }
    ul { font-size: 0.92rem; color: #aaa; line-height: 1.75; padding-left: 20px; margin-bottom: 14px; }
    li { margin-bottom: 8px; }
    li strong { color: #e5e5e5; font-weight: 500; }
    strong { color: #e5e5e5; font-weight: 500; }
    a { color: #a78bfa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { font-family: "SF Mono", "Fira Code", monospace; font-size: 0.82em; color: #a78bfa; background: #131318; border: 1px solid #22222a; border-radius: 4px; padding: 1px 5px; }
    .posture { background: #0d0d0d; border: 1px solid #1a1a1a; border-left: 3px solid #a78bfa; border-radius: 4px; padding: 14px 16px; margin-bottom: 14px; font-size: 0.88rem; color: #bbb; line-height: 1.7; }
    .roadmap-item { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; font-size: 0.9rem; color: #aaa; line-height: 1.6; }
    .roadmap-item .pill { display: inline-block; font-family: "SF Mono","Fira Code",monospace; font-size: 0.66rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #777; background: #131318; border: 1px solid #22222a; border-radius: 3px; padding: 2px 7px; flex-shrink: 0; }
    .contact-block { background: #0d0d0d; border: 1px solid #1a1a1a; border-radius: 6px; padding: 18px 20px; }
    .contact-block a { color: #c4b5fd; }
    footer { border-top: 1px solid #1a1a1a; margin-top: 48px; padding-top: 24px; }
    .footer-row { display: flex; gap: 18px; flex-wrap: wrap; font-size: 0.78rem; color: #666; line-height: 1.8; }
    .footer-row a { color: #777; text-decoration: none; }
    .footer-row a:hover { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Gvnr for businesses</h1>
    <p class="sub">Direct adoption of the substrate &mdash; arranged by email, billed by invoice. No outbound sales. Maintainer reads every message at <a href="mailto:admin@gvnr.dev">admin@gvnr.dev</a>.</p>

    <section>
      <h2>What's available today</h2>
      <p>Five MCP primitives, live at <a href="https://gvnr.dev/mcp">https://gvnr.dev/mcp</a> and as REST under <code>https://gvnr.dev/v1/*</code>:</p>
      <ul>
        <li><strong>Spend caps</strong> &mdash; pre-call estimates against per-agent envelopes; deny before the LLM request is sent.</li>
        <li><strong>Rate coordination</strong> &mdash; per-(agent, provider, model) RPM windows; share one provider quota across many agents.</li>
        <li><strong>Idempotency</strong> &mdash; dedupe retries on a caller-supplied key; prevent double-charges and double-side-effects from agent retry loops.</li>
        <li><strong>Post-call reconciliation</strong> &mdash; apply the drift between estimated and actual cost after the LLM responds; keep envelopes honest as model pricing shifts.</li>
        <li><strong>Human approval bridge</strong> &mdash; pause an agent for a human decision via a mobile-friendly URL; resume on approve, halt on deny or timeout.</li>
      </ul>
      <p>Per-account isolation: API keys map to independent Durable Object instances; no cross-account state.</p>
      <div class="posture"><strong>Honest posture:</strong> single Cloudflare region (auto edge), solo-maintained, no SLA today. The substrate has been continuously online since 2026-05-18 with 9 MCP tools and 98+ passing tests, but operational guarantees are not contractual until an SLA tier exists.</div>
      <p><strong>Billing for direct B2B adoption:</strong> SEPA EUR invoicing is arranged manually by email &mdash; mail <a href="mailto:admin@gvnr.dev">admin@gvnr.dev</a> with expected monthly volume and a billing contact, and you receive an invoice payable into a Luxembourg IBAN. There is no productized invoice flow today. For self-serve, the same substrate is reachable via the x402 USDC packs on the <a href="/">homepage</a>.</p>
    </section>

    <section>
      <h2>Coming soon</h2>
      <p>Each item below is on the roadmap but does <em>not</em> have a committed ship date. Asking for one tends to move it up.</p>
      <div class="roadmap-item"><span class="pill">P1</span><span><strong>TypeScript SDK</strong> &mdash; one-import client over the REST surface; removes the per-agent integration tax. No date.</span></div>
      <div class="roadmap-item"><span class="pill">P2</span><span><strong>R1 reliability hardening</strong> &mdash; multi-region durable-object snapshots, Workers-Free compatible. Scoped, deferred under x402-first focus. No date.</span></div>
      <div class="roadmap-item"><span class="pill">P2</span><span><strong>Trace Store</strong> &mdash; introspection layer (which agent burned the rate limit between 14:00 and 15:00). Gated on first paying customer ask. No date.</span></div>
      <div class="roadmap-item"><span class="pill">P3</span><span><strong>SLA tier</strong> &mdash; gated on a customer who needs and will pay for one. Not on internal aspiration. No date.</span></div>
    </section>

    <section>
      <h2>How to talk to us</h2>
      <div class="contact-block">
        <p>Direct contact &mdash; the maintainer reads and replies:</p>
        <p><a href="mailto:admin@gvnr.dev">admin@gvnr.dev</a></p>
        <p>Bug reports, feature requests, public issues:</p>
        <p><a href="https://github.com/mightbesaad/gvnr/issues" target="_blank" rel="noopener">github.com/mightbesaad/gvnr/issues</a></p>
      </div>
    </section>

    <footer>
      <div class="footer-row">
        <a href="/">Home</a>
        <span>·</span>
        <a href="/tos">Terms &amp; Privacy</a>
        <span>·</span>
        <a href="https://github.com/mightbesaad/gvnr" target="_blank" rel="noopener">GitHub</a>
        <span>·</span>
        <a href="mailto:admin@gvnr.dev">admin@gvnr.dev</a>
      </div>
    </footer>
  </div>
</body>
</html>`;
  return c.html(html);
});

export default b2b;
