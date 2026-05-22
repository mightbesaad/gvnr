import { Hono } from 'hono';
import type { Env } from '../lib/types';
import { decideApproval, readApproval, type ApprovalRecord } from '../lib/approval';

const approve = new Hono<{ Bindings: Env }>();

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} — Gvnr</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#e5e5e5;padding:32px 18px;min-height:100vh;display:flex;align-items:flex-start;justify-content:center}
.card{background:#111;border:1px solid #1f1f1f;border-radius:14px;padding:24px;max-width:420px;width:100%}
h1{font-size:1.2rem;font-weight:600;letter-spacing:-0.01em;margin-bottom:14px}
.row{font-size:0.85rem;color:#888;margin-bottom:6px}
.row strong{color:#e5e5e5;font-weight:600}
.agent{font-family:"SF Mono","Fira Code",monospace;color:#a78bfa}
.action{background:#0f0f0f;border:1px solid #1f1f1f;border-radius:8px;padding:12px 14px;font-size:0.92rem;color:#ccc;margin:8px 0 18px;line-height:1.5}
.expires{font-size:0.8rem;color:#888;margin-bottom:20px}
form{display:block;margin:0}
form + form{margin-top:10px}
button{width:100%;padding:13px 16px;border:none;border-radius:9px;font-size:0.95rem;font-weight:600;cursor:pointer;font-family:inherit;transition:opacity 0.15s}
button:hover{opacity:0.88}
.approve{background:#16a34a;color:#fff}
.deny{background:#1a1a1a;color:#e5e5e5;border:1px solid #2a2a2a}
.state{padding:18px 16px;border-radius:9px;font-size:0.9rem;text-align:center;font-weight:500}
.state-approved{background:#0a2a14;color:#86efac;border:1px solid #14532d}
.state-denied{background:#2a0a0a;color:#fca5a5;border:1px solid #532d2d}
.state-timeout{background:#2a1a0a;color:#fcd34d;border:1px solid #533a14}
.state-notfound{background:#1a1a1a;color:#a8a8a8;border:1px solid #2a2a2a}
.foot{font-size:0.72rem;color:#555;margin-top:22px;text-align:center}
.foot a{color:#777;text-decoration:none}
</style>
</head>
<body>${body}</body></html>`;
}

function renderPending(record: ApprovalRecord, approvalId: string): string {
  const expiresMin = Math.max(1, Math.round((record.expires_at - Date.now()) / 60_000));
  return pageShell(`Approve action?`, `
<div class="card">
  <h1>Approve agent action?</h1>
  <div class="row"><strong>Agent</strong> · <span class="agent">${escapeHtml(record.agent_id)}</span></div>
  <div class="action">${escapeHtml(record.action_summary)}</div>
  <div class="expires">Expires in ~${expiresMin} min</div>
  <form method="POST" action="/approve/${encodeURIComponent(approvalId)}/decide">
    <input type="hidden" name="decision" value="approved">
    <button type="submit" class="approve">Approve</button>
  </form>
  <form method="POST" action="/approve/${encodeURIComponent(approvalId)}/decide">
    <input type="hidden" name="decision" value="denied">
    <button type="submit" class="deny">Deny</button>
  </form>
  <div class="foot">— <a href="https://gvnr.dev">Gvnr</a></div>
</div>`);
}

function renderTerminal(record: ApprovalRecord): string {
  const label =
    record.decision === 'approved' ? 'Approved' :
    record.decision === 'denied' ? 'Denied' :
    record.decision === 'timeout' ? 'Expired before decision' :
    'Pending';
  const cls =
    record.decision === 'approved' ? 'state-approved' :
    record.decision === 'denied' ? 'state-denied' :
    'state-timeout';

  return pageShell(label, `
<div class="card">
  <h1>${label}</h1>
  <div class="row"><strong>Agent</strong> · <span class="agent">${escapeHtml(record.agent_id)}</span></div>
  <div class="action">${escapeHtml(record.action_summary)}</div>
  <div class="state ${cls}">${label}${record.decided_at ? ` · ${new Date(record.decided_at).toUTCString()}` : ''}</div>
  <div class="foot">— <a href="https://gvnr.dev">Gvnr</a></div>
</div>`);
}

function renderNotFound(): string {
  return pageShell('Not found', `
<div class="card">
  <h1>Approval not found</h1>
  <div class="state state-notfound">This approval link is invalid or has expired.</div>
  <div class="foot">— <a href="https://gvnr.dev">Gvnr</a></div>
</div>`);
}

approve.get('/:id', async (c) => {
  c.header('Content-Security-Policy', PAGE_CSP);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', 'no-store');
  const id = c.req.param('id');
  const record = await readApproval(c.env.BUDGET_KV, id);
  if (!record) return c.html(renderNotFound(), 404);
  if (record.decision === 'pending') return c.html(renderPending(record, id));
  return c.html(renderTerminal(record));
});

approve.post('/:id/decide', async (c) => {
  c.header('Content-Security-Policy', PAGE_CSP);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', 'no-store');
  const id = c.req.param('id');

  let decision: string | undefined;
  const contentType = c.req.header('Content-Type') ?? '';
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const raw = form.get('decision');
    decision = typeof raw === 'string' ? raw : undefined;
  } else if (contentType.includes('application/json')) {
    const body = await c.req.json<{ decision?: string }>().catch(() => ({} as { decision?: string }));
    decision = body.decision;
  }

  if (decision !== 'approved' && decision !== 'denied') {
    return c.html(pageShell('Invalid request', `
<div class="card">
  <h1>Invalid decision</h1>
  <div class="state state-notfound">Expected "approved" or "denied".</div>
  <div class="foot">— <a href="https://gvnr.dev">Gvnr</a></div>
</div>`), 400);
  }

  const responder = c.req.header('CF-Connecting-IP')
    ? `ip:${await hashShort(c.req.header('CF-Connecting-IP')!)}`
    : 'anonymous';

  const result = await decideApproval(c.env.BUDGET_KV, id, decision, responder);

  if (!result.ok) {
    if (result.reason === 'not_found') {
      return c.html(renderNotFound(), 404);
    }
    if (result.record) {
      return c.html(renderTerminal(result.record));
    }
    return c.html(renderNotFound(), 404);
  }

  return c.html(renderTerminal(result.record!));
});

async function hashShort(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const arr = Array.from(new Uint8Array(buf)).slice(0, 6);
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default approve;
