import { Hono } from 'hono';
import type { Env } from '../lib/types';
import { authMiddleware, type AuthVariables } from '../lib/auth';
import { getAccountConfig } from './account';
import {
  createApproval,
  readApproval,
  DEFAULT_APPROVAL_TTL_SECONDS,
  MAX_APPROVAL_TTL_SECONDS,
  MIN_APPROVAL_TTL_SECONDS,
  MAX_ACTION_SUMMARY_CHARS,
  MAX_AGENT_ID_CHARS,
  type ApprovalRecord,
} from '../lib/approval';
import { sendApprovalEmail, type EmailDispatchStatus } from '../lib/notify';

type Variables = AuthVariables;

const approval = new Hono<{ Bindings: Env; Variables: Variables }>();

approval.use('/*', authMiddleware);

const VALID_CHANNELS = new Set(['email', 'telegram', 'sms']);
const IMPLEMENTED_CHANNELS_V1 = new Set(['email']);

export interface RequestApprovalResult {
  approval_id: string;
  approval_url: string;
  expires_at: number;
  notification: {
    email: EmailDispatchStatus | 'no_address';
    error?: string;
  };
}

export interface CheckApprovalResult {
  approval_id: string;
  decision: ApprovalRecord['decision'];
  agent_id: string;
  action_summary: string;
  created_at: number;
  expires_at: number;
  responder?: string;
  decided_at?: number;
}

export async function requestApproval(
  env: Env,
  accountId: string,
  origin: string,
  params: {
    agent_id: string;
    action_summary: string;
    ttl_seconds?: number;
    channels?: string[];
  },
): Promise<{ status: 200 | 400; body: RequestApprovalResult | { error: string; hint?: string; valid_channels?: string[] } }> {
  if (typeof params.agent_id !== 'string' || !params.agent_id || params.agent_id.length > MAX_AGENT_ID_CHARS) {
    return { status: 400, body: { error: 'invalid_agent_id' } };
  }
  if (typeof params.action_summary !== 'string' || !params.action_summary || params.action_summary.length > MAX_ACTION_SUMMARY_CHARS) {
    return { status: 400, body: { error: 'invalid_action_summary', hint: `1..${MAX_ACTION_SUMMARY_CHARS} chars` } };
  }

  const ttl = params.ttl_seconds ?? DEFAULT_APPROVAL_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < MIN_APPROVAL_TTL_SECONDS || ttl > MAX_APPROVAL_TTL_SECONDS) {
    return { status: 400, body: { error: 'invalid_ttl_seconds', hint: `${MIN_APPROVAL_TTL_SECONDS}..${MAX_APPROVAL_TTL_SECONDS}` } };
  }

  const channels = params.channels ?? ['email'];
  if (!Array.isArray(channels) || channels.length === 0 || channels.some((c) => !VALID_CHANNELS.has(c))) {
    return { status: 400, body: { error: 'invalid_channels', valid_channels: Array.from(VALID_CHANNELS) } };
  }
  // V1 ships email only. Reject calls that ask for unimplemented channels so a caller
  // sees a clear 400 instead of a silently orphaned approval that no human is notified about.
  if (channels.some((c) => !IMPLEMENTED_CHANNELS_V1.has(c))) {
    return {
      status: 400,
      body: {
        error: 'channel_not_implemented',
        valid_channels: Array.from(IMPLEMENTED_CHANNELS_V1),
        hint: 'telegram and sms are reserved in the schema for forward-compat but not yet delivered',
      },
    };
  }

  const cfg = await getAccountConfig(env.BUDGET_KV, accountId);
  if (!cfg?.notification_email) {
    return {
      status: 400,
      body: {
        error: 'notification_email_unset',
        hint: 'POST /v1/account/notification-email with { "email": "..." } first',
      },
    };
  }

  const created = await createApproval(env.BUDGET_KV, accountId, {
    agent_id: params.agent_id,
    action_summary: params.action_summary,
    ttl_seconds: ttl,
    channels,
  });

  const approval_url = `${origin}/approve/${created.approval_id}`;

  let notification: RequestApprovalResult['notification'] = { email: 'no_address' };
  if (channels.includes('email')) {
    const dispatch = await sendApprovalEmail(env.RESEND_API_KEY, cfg.notification_email, created.record, approval_url);
    notification = { email: dispatch.status, error: dispatch.error };
  }

  return {
    status: 200,
    body: {
      approval_id: created.approval_id,
      approval_url,
      expires_at: created.expires_at,
      notification,
    },
  };
}

export async function checkApproval(
  env: Env,
  accountId: string,
  approvalId: string,
): Promise<{ status: 200 | 404; body: CheckApprovalResult | { error: string } }> {
  const record = await readApproval(env.BUDGET_KV, approvalId);
  if (!record || record.account_id !== accountId) {
    return { status: 404, body: { error: 'approval_not_found' } };
  }
  return {
    status: 200,
    body: {
      approval_id: approvalId,
      decision: record.decision,
      agent_id: record.agent_id,
      action_summary: record.action_summary,
      created_at: record.created_at,
      expires_at: record.expires_at,
      responder: record.responder,
      decided_at: record.decided_at,
    },
  };
}

approval.post('/request', async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json<{
    agent_id?: string;
    action_summary?: string;
    ttl_seconds?: number;
    channels?: string[];
  }>();
  const origin = new URL(c.req.url).origin;
  const result = await requestApproval(c.env, accountId, origin, {
    agent_id: body.agent_id ?? '',
    action_summary: body.action_summary ?? '',
    ttl_seconds: body.ttl_seconds,
    channels: body.channels,
  });
  return c.json(result.body, result.status);
});

approval.get('/check/:id', async (c) => {
  const accountId = c.get('accountId');
  const id = c.req.param('id');
  const result = await checkApproval(c.env, accountId, id);
  return c.json(result.body, result.status);
});

export default approval;
