export type ApprovalDecision = 'pending' | 'approved' | 'denied' | 'timeout';

export interface ApprovalRecord {
  account_id: string;
  agent_id: string;
  action_summary: string;
  created_at: number;
  expires_at: number;
  channels: string[];
  decision: ApprovalDecision;
  responder?: string;
  decided_at?: number;
}

export const DEFAULT_APPROVAL_TTL_SECONDS = 600;          // 10 minutes — typical human attention span
export const MAX_APPROVAL_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days — covers async/email-only approvers
export const MIN_APPROVAL_TTL_SECONDS = 1;                // anything shorter is pointless; permitted for short polling tests
export const MAX_ACTION_SUMMARY_CHARS = 280;
export const MAX_AGENT_ID_CHARS = 128;

// Keep the KV record around past the human deadline so check_approval can still
// return decision="timeout" rather than 404. KV minimum TTL is 60s.
const STORAGE_GRACE_SECONDS = 24 * 60 * 60; // 1 day
const KV_MIN_TTL_SECONDS = 60;

function kvStorageTtl(ttlSeconds: number): number {
  return Math.max(KV_MIN_TTL_SECONDS, ttlSeconds + STORAGE_GRACE_SECONDS);
}

export interface CreateApprovalParams {
  agent_id: string;
  action_summary: string;
  ttl_seconds: number;
  channels: string[];
}

export interface ApprovalCreateResult {
  approval_id: string;
  expires_at: number;
  record: ApprovalRecord;
}

function approvalKey(approvalId: string): string {
  return `approval:${approvalId}`;
}

function generateApprovalId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function createApproval(
  kv: KVNamespace,
  accountId: string,
  params: CreateApprovalParams,
): Promise<ApprovalCreateResult> {
  const approval_id = generateApprovalId();
  const now = Date.now();
  const expires_at = now + params.ttl_seconds * 1000;

  const record: ApprovalRecord = {
    account_id: accountId,
    agent_id: params.agent_id,
    action_summary: params.action_summary,
    created_at: now,
    expires_at,
    channels: params.channels,
    decision: 'pending',
  };

  await kv.put(approvalKey(approval_id), JSON.stringify(record), {
    expirationTtl: kvStorageTtl(params.ttl_seconds),
  });

  return { approval_id, expires_at, record };
}

export async function readApproval(
  kv: KVNamespace,
  approvalId: string,
): Promise<ApprovalRecord | null> {
  const record = await kv.get<ApprovalRecord>(approvalKey(approvalId), 'json');
  if (!record) return null;

  // Compute timeout on read — KV TTL handles eventual deletion, but we want
  // immediate timeout status the moment expires_at passes.
  if (record.decision === 'pending' && Date.now() > record.expires_at) {
    return { ...record, decision: 'timeout' };
  }
  return record;
}

export interface DecideResult {
  ok: boolean;
  reason?: 'not_found' | 'already_decided' | 'expired';
  record?: ApprovalRecord;
}

export async function decideApproval(
  kv: KVNamespace,
  approvalId: string,
  decision: 'approved' | 'denied',
  responder?: string,
): Promise<DecideResult> {
  const existing = await kv.get<ApprovalRecord>(approvalKey(approvalId), 'json');
  if (!existing) return { ok: false, reason: 'not_found' };

  if (existing.decision !== 'pending') {
    return { ok: false, reason: 'already_decided', record: existing };
  }
  if (Date.now() > existing.expires_at) {
    return { ok: false, reason: 'expired', record: { ...existing, decision: 'timeout' } };
  }

  const decidedAt = Date.now();
  const updated: ApprovalRecord = {
    ...existing,
    decision,
    decided_at: decidedAt,
    responder,
  };

  const remainingSeconds = Math.max(0, Math.ceil((existing.expires_at - Date.now()) / 1000));
  await kv.put(approvalKey(approvalId), JSON.stringify(updated), {
    expirationTtl: kvStorageTtl(remainingSeconds),
  });

  return { ok: true, record: updated };
}
