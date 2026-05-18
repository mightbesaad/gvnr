import { Hono } from 'hono';
import type { Env } from '../lib/types';
import { authMiddleware, type AuthVariables } from '../lib/auth';
import { nextDailyReset, roundUsd } from '../lib/models';

type Variables = AuthVariables;

const envelope = new Hono<{ Bindings: Env; Variables: Variables }>();

envelope.use('/*', authMiddleware);

// PUT /v1/budget/envelope — create or update an agent's budget envelope
envelope.put('/', async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json<{ agent_id: string; limit_usd: number; window?: 'daily' | 'session' }>();

  const window = body.window ?? 'daily';

  if (typeof body.agent_id !== 'string' || !body.agent_id || body.agent_id.length > 128) {
    return c.json({ error: 'invalid_params', detail: 'agent_id must be a non-empty string, max 128 chars' }, 400);
  }
  if (typeof body.limit_usd !== 'number' || !Number.isFinite(body.limit_usd) || body.limit_usd <= 0 || body.limit_usd > 1_000_000) {
    return c.json({ error: 'invalid_params', required: ['agent_id', 'limit_usd'] }, 400);
  }
  if (window !== 'daily' && window !== 'session') {
    return c.json({ error: 'invalid_params', detail: 'window must be "daily" or "session"' }, 400);
  }
  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(accountId));
  const existing = await stub.getEnvelope(body.agent_id);

  await stub.setEnvelope(body.agent_id, {
    limit_usd: body.limit_usd,
    spent_usd: existing?.spent_usd ?? 0,
    window,
    reset_at: existing?.reset_at ?? nextDailyReset(),
  });

  return c.json({ success: true, agent_id: body.agent_id, limit_usd: body.limit_usd, window });
});

// GET /v1/budget/envelope/:agent_id — read envelope state
envelope.get('/:agent_id', async (c) => {
  const accountId = c.get('accountId');
  const agentId = c.req.param('agent_id');
  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(accountId));
  const env = await stub.getEnvelope(agentId);

  if (!env) {
    return c.json({ error: 'not_found' }, 404);
  }

  return c.json({
    agent_id: agentId,
    limit_usd: env.limit_usd,
    spent_usd: env.spent_usd,
    remaining_usd: roundUsd(Math.max(0, env.limit_usd - env.spent_usd)),
    window: env.window,
    reset_at: env.reset_at,
  });
});

// DELETE /v1/budget/envelope/:agent_id — remove an agent's envelope
envelope.delete('/:agent_id', async (c) => {
  const accountId = c.get('accountId');
  const agentId = c.req.param('agent_id');
  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(accountId));
  const deleted = await stub.deleteEnvelope(agentId);

  if (!deleted) {
    return c.json({ error: 'not_found' }, 404);
  }

  return c.json({ success: true, agent_id: agentId });
});

export default envelope;
