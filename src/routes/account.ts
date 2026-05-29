import { Hono } from 'hono';
import type { AccountConfigRecord, Env } from '../lib/types';
import { hashApiKey } from '../lib/kv';
import { authMiddleware, type AuthVariables } from '../lib/auth';
import { PACKS, type PackName } from '../lib/x402';
import { opsForUsd } from '../lib/models';

type Variables = AuthVariables;

const account = new Hono<{ Bindings: Env; Variables: Variables }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_CHARS = 254;

function accountConfigKey(accountId: string): string {
  return `account_config:${accountId}`;
}

export async function getAccountConfig(kv: KVNamespace, accountId: string): Promise<AccountConfigRecord | null> {
  return kv.get<AccountConfigRecord>(accountConfigKey(accountId), 'json');
}

// POST /v1/account — provision a new account, returns api_key
account.post('/', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const { success } = await c.env.ACCOUNT_RATE_LIMITER.limit({ key: ip });
  if (!success) {
    return c.json({ error: 'rate_limited', retryable: true, retry_after_ms: 3_600_000, hint: 'Per-IP account-creation throttle. Retry after the window.' }, 429);
  }

  const accountId = crypto.randomUUID();
  const apiKey = `bg_${crypto.randomUUID().replace(/-/g, '')}`;
  const keyHash = await hashApiKey(apiKey);

  await c.env.BUDGET_KV.put(`api:${keyHash}`, JSON.stringify({ account_id: accountId }));

  return c.json({ api_key: apiKey, account_id: accountId }, 201);
});

// GET /v1/account/balance — remaining governance-operation quota
account.get('/balance', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(accountId));
  const operations = await stub.getOperations();
  return c.json({ operations_remaining: operations });
});

// POST /v1/account/notification-email — set the address Gvnr emails when request_approval fires
account.post('/notification-email', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json<{ email?: unknown }>();

  if (typeof body.email !== 'string' || !body.email || body.email.length > MAX_EMAIL_CHARS || !EMAIL_RE.test(body.email)) {
    return c.json({ error: 'invalid_email', required: ['email (valid address, ≤254 chars)'] }, 400);
  }

  const existing = await getAccountConfig(c.env.BUDGET_KV, accountId);
  const next: AccountConfigRecord = { ...existing, notification_email: body.email };
  await c.env.BUDGET_KV.put(accountConfigKey(accountId), JSON.stringify(next));

  return c.json({ ok: true, notification_email: body.email });
});

// GET /v1/account/notification-email — read current address (or null)
account.get('/notification-email', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const cfg = await getAccountConfig(c.env.BUDGET_KV, accountId);
  return c.json({ notification_email: cfg?.notification_email ?? null });
});

// DELETE /v1/account/notification-email — clear the address (right-to-erasure)
account.delete('/notification-email', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const existing = await getAccountConfig(c.env.BUDGET_KV, accountId);
  if (!existing) return c.json({ ok: true });

  const next: AccountConfigRecord = { ...existing };
  delete next.notification_email;

  if (Object.keys(next).length === 0) {
    await c.env.BUDGET_KV.delete(accountConfigKey(accountId));
  } else {
    await c.env.BUDGET_KV.put(accountConfigKey(accountId), JSON.stringify(next));
  }
  return c.json({ ok: true });
});

// POST /v1/account/topup/:pack — x402-gated credit top-up
// x402 middleware (applied in index.ts) intercepts first: returns 402 if no payment,
// calls next() if payment is verified. By the time this handler runs, payment is settled.
account.post('/topup/:pack', authMiddleware, async (c) => {
  const packName = c.req.param('pack') as PackName;
  const pack = PACKS[packName];

  if (!pack) {
    return c.json({ error: 'invalid_pack', valid: Object.keys(PACKS) }, 400);
  }

  const accountId = c.get('accountId');
  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(accountId));
  const ops = opsForUsd(pack.amount_usd);
  const result = await stub.credit(ops);

  return c.json({ operations_remaining: result.operations_remaining, pack: packName, credited_ops: ops });
});

export default account;
