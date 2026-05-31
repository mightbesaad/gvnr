import { Hono } from 'hono';
import type { Env } from '../lib/types';
import { REPO_URL, REPO_ISSUES_URL } from '../lib/links';

const tos = new Hono<{ Bindings: Env }>();

tos.get('/', (c) => {
  c.header('X-Frame-Options', 'DENY');
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  c.header('X-Content-Type-Options', 'nosniff');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms &amp; Privacy — Gvnr</title>
  <meta name="description" content="Terms of service, refund policy, and privacy notice for Gvnr — the x402-paying AI agent substrate at gvnr.dev.">
  <meta property="og:title" content="Terms &amp; Privacy — Gvnr">
  <meta property="og:description" content="Terms of service, refund policy, and privacy notice for Gvnr.">
  <meta property="og:url" content="https://gvnr.dev/tos">
  <meta property="og:type" content="website">
  <meta name="robots" content="index, follow">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 48px 24px; min-height: 100vh; }
    .container { max-width: 640px; margin: 0 auto; }
    h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 6px; }
    .sub { color: #888; font-size: 0.85rem; margin-bottom: 48px; }
    h2 { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #555; margin-bottom: 14px; }
    section { margin-bottom: 40px; }
    p { font-size: 0.9rem; color: #aaa; line-height: 1.75; margin-bottom: 12px; }
    ul, ol { font-size: 0.9rem; color: #aaa; line-height: 1.75; padding-left: 20px; margin-bottom: 12px; }
    li { margin-bottom: 6px; }
    strong { color: #e5e5e5; font-weight: 500; }
    a { color: #a78bfa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { font-family: "SF Mono", "Fira Code", monospace; font-size: 0.8em; color: #a78bfa; }
    footer { border-top: 1px solid #1a1a1a; margin-top: 48px; padding-top: 24px; }
    .footer-row { display: flex; gap: 20px; flex-wrap: wrap; font-size: 0.78rem; color: #666; line-height: 1.8; }
    .footer-row a { color: #777; text-decoration: none; }
    .footer-row a:hover { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Terms &amp; Privacy</h1>
    <p class="sub">Gvnr &mdash; Effective May 2026</p>

    <section>
      <h2>Terms of Service</h2>
      <p><strong>1. Service.</strong> Gvnr provides API endpoints and an MCP server for controlling AI agent spend. The service is provided "as is" without warranties of any kind. Use at your own risk.</p>
      <p><strong>2. Accounts.</strong> Accounts are provisioned via <code>POST /v1/account</code>. You receive a random API key. You are solely responsible for keeping it secure. There is no account recovery — if you lose your API key, those credits are lost.</p>
      <p><strong>3. Governance ops.</strong> Governance operations are purchased pay-as-you-go via USDC on Base mainnet — any amount, credited at a fixed rate per dollar. Ops do not expire. A top-up credits the account it is paid for; ops are not transferable between accounts.</p>
      <p><strong>4. Acceptable use.</strong> You may not use the service to:</p>
      <ul>
        <li>Circumvent or abuse spend limits on behalf of other users</li>
        <li>Access accounts that are not yours</li>
        <li>Send automated requests at volumes that degrade service for others</li>
      </ul>
      <p><strong>5. Limitation of liability.</strong> To the maximum extent permitted by law, Gvnr and its operator are not liable for any direct, indirect, incidental, or consequential damages arising from your use of the service, including lost credits, runaway agent costs, or service downtime.</p>
      <p><strong>6. Changes.</strong> These terms may be updated at any time. Continued use of the service after changes constitutes acceptance.</p>
    </section>

    <section>
      <h2>Refund Policy</h2>
      <p>USDC transfers on the Base blockchain are irreversible on-chain. <strong>Credits are non-refundable once purchased.</strong></p>
      <p>If you experience a verifiable service error — for example, a payment that reached our receiver address but was not credited to your account due to a fault on our end — open an issue on <a href="${REPO_ISSUES_URL}" target="_blank" rel="noopener">GitHub</a> with your transaction hash and API key. We will review and credit your account at our discretion.</p>
      <p>We do not issue refunds for unused credits, incorrectly sized packs, or costs incurred by your agents.</p>
      <p><strong>Overpayments.</strong> If you send more USDC than the pack price (for example, rounding from an exchange withdrawal, or sending $20 to a $19 pack), your account is credited with the pack's nominal amount only. Excess is logged for manual review and is not auto-refunded; contact support via GitHub Issues with your transaction hash if you need the overpayment reviewed.</p>
    </section>

    <section>
      <h2>Privacy</h2>
      <p>We store the following in Cloudflare KV:</p>
      <ul>
        <li><strong>API keys</strong> — randomly generated tokens (<code>bg_</code> + 32 hex chars) returned to you once. Only a SHA-256 hash is stored — the plaintext key is never persisted.</li>
        <li><strong>Account UUIDs</strong> — random identifiers linked to your API key.</li>
        <li><strong>Credit balance</strong> — USD amount and timestamp of last update.</li>
        <li><strong>Spend envelopes</strong> — per-agent budget limits and current spend totals you configure.</li>
        <li><strong>Transaction hashes</strong> — stored for 30 days to prevent payment replay, then automatically deleted.</li>
      </ul>
      <p>We do not collect email addresses, names, wallet addresses (beyond what is publicly visible on-chain), or browsing behavior.</p>
      <p>Cloudflare handles request routing and may log IP addresses and request metadata per their <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener">privacy policy</a>.</p>
    </section>

    <section>
      <h2>Support</h2>
      <p>For questions, issues, or payment disputes: <a href="${REPO_ISSUES_URL}" target="_blank" rel="noopener">GitHub Issues</a></p>
    </section>

    <footer>
      <div class="footer-row">
        <a href="/">Home</a>
        <span>·</span>
        <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>
        <span>·</span>
        <a href="${REPO_ISSUES_URL}" target="_blank" rel="noopener">Support</a>
      </div>
    </footer>
  </div>
</body>
</html>`;
  return c.html(html);
});

export default tos;
