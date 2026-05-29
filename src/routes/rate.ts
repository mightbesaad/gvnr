import { Hono } from 'hono';
import type { Env } from '../lib/types';
import { authMiddleware, type AuthVariables } from '../lib/auth';

type Variables = AuthVariables;

const rate = new Hono<{ Bindings: Env; Variables: Variables }>();

rate.use('/*', authMiddleware);

// PUT /v1/rate/envelope — create or update a per-(agent, provider, model) rate envelope
rate.put('/envelope', async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json<{
    agent_id: string;
    provider: string;
    model: string;
    requests_per_minute: number;
  }>();

  if (typeof body.agent_id !== 'string' || !body.agent_id || body.agent_id.length > 128 ||
      typeof body.provider !== 'string' || !body.provider || body.provider.length > 64 ||
      typeof body.model !== 'string' || !body.model || body.model.length > 128 ||
      typeof body.requests_per_minute !== 'number' || !Number.isFinite(body.requests_per_minute) ||
      !Number.isInteger(body.requests_per_minute) || body.requests_per_minute <= 0 ||
      body.requests_per_minute > 1_000_000) {
    return c.json({
      error: 'invalid_params',
      required: ['agent_id (string, max 128)', 'provider (string, max 64)', 'model (string, max 128)', 'requests_per_minute (positive integer, max 1_000_000)'],
    }, 400);
  }

  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(accountId));
  await stub.setRateEnvelope(body.agent_id, body.provider, body.model, body.requests_per_minute);

  return c.json({
    success: true,
    agent_id: body.agent_id,
    provider: body.provider,
    model: body.model,
    requests_per_minute: body.requests_per_minute,
  });
});

// GET /v1/rate/envelope/:agent_id/:provider/:model — read current envelope state
rate.get('/envelope/:agent_id/:provider/:model', async (c) => {
  const accountId = c.get('accountId');
  const agent_id = decodeURIComponent(c.req.param('agent_id'));
  const provider = decodeURIComponent(c.req.param('provider'));
  const model = decodeURIComponent(c.req.param('model'));

  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(accountId));
  const env = await stub.getRateEnvelope(agent_id, provider, model);
  if (!env) return c.json({ error: 'not_found', retryable: false, hint: 'No rate envelope for this (agent, provider, model). Create one via PUT /v1/rate/envelope.' }, 404);

  return c.json({
    agent_id,
    provider: env.provider,
    model: env.model,
    requests_per_minute: env.requests_per_minute,
    requests_in_window: env.requests_in_window,
    window_start: env.window_start,
  });
});

// DELETE /v1/rate/envelope/:agent_id/:provider/:model — remove envelope
rate.delete('/envelope/:agent_id/:provider/:model', async (c) => {
  const accountId = c.get('accountId');
  const agent_id = decodeURIComponent(c.req.param('agent_id'));
  const provider = decodeURIComponent(c.req.param('provider'));
  const model = decodeURIComponent(c.req.param('model'));

  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(accountId));
  const existed = await stub.deleteRateEnvelope(agent_id, provider, model);
  if (!existed) return c.json({ error: 'not_found', retryable: false, hint: 'No rate envelope to delete for this (agent, provider, model).' }, 404);

  return c.json({ success: true, agent_id, provider, model });
});

// POST /v1/rate/check — runtime rate check; always returns 200, allowed flag in body
rate.post('/check', async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json<{ agent_id: string; provider: string; model: string }>();

  if (typeof body.agent_id !== 'string' || !body.agent_id || body.agent_id.length > 128 ||
      typeof body.provider !== 'string' || !body.provider ||
      typeof body.model !== 'string' || !body.model) {
    return c.json({ error: 'invalid_params', required: ['agent_id', 'provider', 'model'] }, 400);
  }

  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(accountId));
  const result = await stub.checkRate(body.agent_id, body.provider, body.model);
  return c.json(result);
});

export default rate;
