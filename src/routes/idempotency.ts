import { Hono } from 'hono';
import type { Env } from '../lib/types';
import { authMiddleware, type AuthVariables } from '../lib/auth';

type Variables = AuthVariables;

const idempot = new Hono<{ Bindings: Env; Variables: Variables }>();

idempot.use('/*', authMiddleware);

export const DEFAULT_TTL_SECONDS = 3600;          // 1 hour — covers typical retry windows
export const MAX_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — same horizon as tx-replay protection

// POST /v1/idempotency/check — check-and-set on a caller-supplied key, scoped to the account.
// Returns is_first_call=true and stores the key on first call; returns false on replays within TTL.
idempot.post('/check', async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json<{ key: string; ttl_seconds?: number }>();

  if (typeof body.key !== 'string' || !body.key || body.key.length > 256) {
    return c.json({ error: 'invalid_params', required: ['key (string, 1-256 chars)'] }, 400);
  }
  const ttl = body.ttl_seconds ?? DEFAULT_TTL_SECONDS;
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    return c.json({ error: 'invalid_params', required: ['ttl_seconds (1..2,592,000)'] }, 400);
  }

  const result = await checkIdempotency(c.env.BUDGET_KV, accountId, body.key, ttl);
  return c.json(result);
});

export async function checkIdempotency(
  kv: KVNamespace,
  accountId: string,
  key: string,
  ttlSeconds: number,
): Promise<{ is_first_call: boolean; ttl_remaining_seconds: number }> {
  const kvKey = `idempot:${accountId}:${key}`;
  const existing = await kv.get<{ stored_at: number }>(kvKey, 'json');

  if (existing) {
    const elapsedSeconds = Math.floor((Date.now() - existing.stored_at) / 1000);
    const remaining = Math.max(0, ttlSeconds - elapsedSeconds);
    return { is_first_call: false, ttl_remaining_seconds: remaining };
  }

  await kv.put(kvKey, JSON.stringify({ stored_at: Date.now() }), { expirationTtl: ttlSeconds });
  return { is_first_call: true, ttl_remaining_seconds: ttlSeconds };
}

export default idempot;
