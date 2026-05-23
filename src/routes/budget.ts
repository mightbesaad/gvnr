import { Hono } from 'hono';
import type { Env } from '../lib/types';
import { authMiddleware, type AuthVariables } from '../lib/auth';

type Variables = AuthVariables;

const budget = new Hono<{ Bindings: Env; Variables: Variables }>();

budget.use('/*', authMiddleware);

// POST /v1/budget/clear — core clearance call
budget.post('/clear', async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json<{ agent_id: string; model: string; estimated_tokens: number }>();

  if (typeof body.agent_id !== 'string' || !body.agent_id || body.agent_id.length > 128 ||
      !body.model || typeof body.estimated_tokens !== 'number' ||
      !Number.isFinite(body.estimated_tokens) || body.estimated_tokens <= 0) {
    return c.json({ error: 'invalid_params', required: ['agent_id (string, max 128 chars)', 'model', 'estimated_tokens (finite int > 0; output tokens for chat models, input tokens for embedding/input-only models)'] }, 400);
  }

  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(accountId));
  const result = await stub.runClearance(body.agent_id, body.model, body.estimated_tokens);
  return c.json(result);
});

// POST /v1/budget/reconcile — apply actual usage from the LLM response,
// adjust the envelope and balance by the drift vs the original estimate.
budget.post('/reconcile', async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json<{
    agent_id: string;
    actual_input_tokens: number;
    actual_output_tokens: number;
  }>();

  if (typeof body.agent_id !== 'string' || !body.agent_id || body.agent_id.length > 128 ||
      typeof body.actual_input_tokens !== 'number' || !Number.isFinite(body.actual_input_tokens) || body.actual_input_tokens < 0 ||
      typeof body.actual_output_tokens !== 'number' || !Number.isFinite(body.actual_output_tokens) || body.actual_output_tokens < 0) {
    return c.json({ error: 'invalid_params', required: ['agent_id (string, max 128 chars)', 'actual_input_tokens (finite >= 0)', 'actual_output_tokens (finite >= 0)'] }, 400);
  }

  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(accountId));
  const result = await stub.applyReconciliation(body.agent_id, body.actual_input_tokens, body.actual_output_tokens);

  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(result);
});

export default budget;
