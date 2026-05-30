import type { ApprovalRecord } from './approval';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM_ADDRESS = 'Gvnr <admin@gvnr.dev>';

export type EmailDispatchStatus = 'sent' | 'skipped_no_key' | 'failed';

export interface EmailDispatchResult {
  status: EmailDispatchStatus;
  error?: string;
  message_id?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildEmail(approval: ApprovalRecord, approvalUrl: string): { subject: string; text: string; html: string } {
  const expiresMinutes = Math.max(1, Math.round((approval.expires_at - Date.now()) / 60_000));
  const subject = `Approval requested: ${approval.agent_id}`;

  const text = [
    `Agent "${approval.agent_id}" is requesting your approval.`,
    '',
    `Action: ${approval.action_summary}`,
    `Expires in: ~${expiresMinutes} minutes`,
    '',
    `Approve or deny: ${approvalUrl}`,
    '',
    '— Gvnr · https://gvnr.dev',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e5e5e5;padding:32px 16px;margin:0">
  <div style="max-width:480px;margin:0 auto;background:#111;border:1px solid #1f1f1f;border-radius:12px;padding:24px">
    <h1 style="font-size:1.1rem;font-weight:600;margin:0 0 14px;color:#e5e5e5">Approval requested</h1>
    <p style="font-size:0.92rem;color:#bbb;margin:0 0 8px">Agent <code style="color:#a78bfa;font-family:monospace">${escapeHtml(approval.agent_id)}</code> is requesting your approval.</p>
    <p style="font-size:0.92rem;color:#bbb;margin:14px 0 6px"><strong style="color:#e5e5e5">Action</strong></p>
    <p style="font-size:0.92rem;color:#ccc;background:#0f0f0f;border:1px solid #1f1f1f;border-radius:6px;padding:10px 12px;margin:0 0 14px">${escapeHtml(approval.action_summary)}</p>
    <p style="font-size:0.82rem;color:#888;margin:0 0 20px">Expires in ~${expiresMinutes} minutes.</p>
    <p style="margin:0 0 20px"><a href="${approvalUrl}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:500;font-size:0.95rem">Open approval page</a></p>
    <p style="font-size:0.74rem;color:#666;margin:0">If the button does not work, copy this link: <span style="color:#888;word-break:break-all">${approvalUrl}</span></p>
  </div>
  <p style="text-align:center;font-size:0.72rem;color:#555;margin:24px 0 0">— Gvnr · <a href="https://gvnr.dev" style="color:#666">gvnr.dev</a></p>
</body></html>`;

  return { subject, text, html };
}

export type TelegramDispatchStatus = 'sent' | 'skipped_no_config' | 'failed';

// Fire a plain-text Telegram alert for ops/money-critical events (e.g. a top-up that settled
// on-chain but failed to credit). No-ops gracefully when the bot token / chat id are not
// configured, mirroring the approval-email pattern. Best-effort: never throws.
export async function sendTelegramAlert(
  env: { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string },
  text: string,
): Promise<TelegramDispatchStatus> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return 'skipped_no_config';
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

// Plain-text ops/money-critical email alert (e.g. settled-but-not-credited top-up). Sent from
// the same verified FROM_ADDRESS as approval mail. No-ops when the Resend key or recipient are
// unset; best-effort, never throws.
export async function sendOpsEmailAlert(
  apiKey: string | undefined,
  to: string | undefined,
  subject: string,
  text: string,
): Promise<EmailDispatchStatus> {
  if (!apiKey || !to) return 'skipped_no_key';
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, text }),
    });
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

export async function sendApprovalEmail(
  apiKey: string | undefined,
  to: string,
  approval: ApprovalRecord,
  approvalUrl: string,
): Promise<EmailDispatchResult> {
  if (!apiKey) {
    return { status: 'skipped_no_key' };
  }

  const { subject, text, html } = buildEmail(approval, approvalUrl);

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [to],
        subject,
        text,
        html,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { status: 'failed', error: `resend_${res.status}: ${body.slice(0, 200)}` };
    }

    const data = await res.json<{ id?: string }>().catch(() => ({} as { id?: string }));
    return { status: 'sent', message_id: data.id };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : 'unknown_error' };
  }
}
