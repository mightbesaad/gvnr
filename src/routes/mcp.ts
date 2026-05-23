import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { Context } from 'hono';
import type { Env } from '../lib/types';
import { getAccount } from '../lib/kv';
import { nextDailyReset } from '../lib/models';
import { checkIdempotency, DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS } from './idempotency';
import { requestApproval, checkApproval } from './approval';
import {
  DEFAULT_APPROVAL_TTL_SECONDS,
  MAX_APPROVAL_TTL_SECONDS,
  MIN_APPROVAL_TTL_SECONDS,
  MAX_ACTION_SUMMARY_CHARS,
  MAX_AGENT_ID_CHARS,
} from '../lib/approval';

export async function mcpHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const apiKey =
    c.req.query('api_key') ||
    c.req.header('Authorization')?.slice(7);

  if (!apiKey) {
    return c.json({ error: 'missing_api_key' }, 401);
  }

  const account = await getAccount(c.env.BUDGET_KV, apiKey);
  if (!account) {
    return c.json({ error: 'invalid_api_key' }, 401);
  }

  const accountId = account.account_id;
  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(accountId));

  const server = new McpServer({ name: 'gvnr', version: '1.5.0' });

  const origin = new URL(c.req.url).origin;

  server.registerTool(
    'budget_clear',
    {
      description: 'Check if an agent is authorized to spend tokens and deduct the estimated cost from its envelope. For chat models pass output tokens; for embedding models (text-embedding-3-*, gemini-embedding-*) pass input tokens since those are billed input-only.',
      inputSchema: {
        agent_id: z.string().max(128).describe('The agent identifier'),
        model: z.string().describe('Model being called (e.g. claude-sonnet-4-6, gpt-4o, text-embedding-3-small)'),
        estimated_tokens: z.number().int().finite().positive().describe('Tokens to be billed — output tokens for chat models, input tokens for input-only models (embeddings)'),
      },
      annotations: {
        title: 'Clear budget for a planned LLM call',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ agent_id, model, estimated_tokens }) => {
      const result = await stub.runClearance(agent_id, model, estimated_tokens);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'set_envelope',
    {
      description: 'Create or update a spend envelope for an agent.',
      inputSchema: {
        agent_id: z.string().max(128).describe('The agent identifier'),
        limit_usd: z.number().finite().positive().max(1_000_000).describe('Spend limit in USD'),
        window: z.enum(['daily', 'session']).default('daily').describe('Reset window: daily (UTC midnight) or session (never resets)'),
      },
      annotations: {
        title: 'Set spend envelope for an agent',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ agent_id, limit_usd, window }) => {
      const existing = await stub.getEnvelope(agent_id);
      await stub.setEnvelope(agent_id, {
        limit_usd,
        spent_usd: existing?.spent_usd ?? 0,
        window,
        reset_at: existing?.reset_at ?? nextDailyReset(),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, agent_id, limit_usd, window }) }] };
    },
  );

  server.registerTool(
    'get_balance',
    {
      description: 'Get the current credit balance for this account.',
      inputSchema: {},
      annotations: {
        title: 'Get account credit balance',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const balance = await stub.getBalance();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ balance_usd: balance }) }] };
    },
  );

  server.registerTool(
    'reconcile',
    {
      description: 'Reconcile a previous budget_clear with actual usage from the LLM response. Applies the drift (actual minus estimated cost) to the agent envelope and account balance.',
      inputSchema: {
        agent_id: z.string().max(128).describe('The agent identifier'),
        actual_input_tokens: z.number().int().finite().nonnegative().describe('Actual input tokens reported by the LLM provider'),
        actual_output_tokens: z.number().int().finite().nonnegative().describe('Actual output tokens reported by the LLM provider'),
      },
      annotations: {
        title: 'Reconcile a clearance with actual usage',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ agent_id, actual_input_tokens, actual_output_tokens }) => {
      const result = await stub.applyReconciliation(agent_id, actual_input_tokens, actual_output_tokens);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'set_rate_envelope',
    {
      description: 'Create or update a rate-limit envelope for an (agent, provider, model) triple. Each envelope tracks requests per fixed 60-second window.',
      inputSchema: {
        agent_id: z.string().max(128).describe('The agent identifier'),
        provider: z.string().max(64).describe('Provider name, e.g. anthropic, openai, bedrock'),
        model: z.string().max(128).describe('Model identifier, e.g. claude-sonnet-4-6, gpt-4o'),
        requests_per_minute: z.number().int().finite().positive().max(1_000_000).describe('Allowed requests per 60-second window'),
      },
      annotations: {
        title: 'Set rate envelope for (agent, provider, model)',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ agent_id, provider, model, requests_per_minute }) => {
      await stub.setRateEnvelope(agent_id, provider, model, requests_per_minute);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, agent_id, provider, model, requests_per_minute }) }] };
    },
  );

  server.registerTool(
    'rate_check',
    {
      description: 'Check whether an agent is allowed to make a call against the rate envelope for the given (provider, model). Increments the counter on allow.',
      inputSchema: {
        agent_id: z.string().max(128).describe('The agent identifier'),
        provider: z.string().max(64).describe('Provider name, e.g. anthropic, openai'),
        model: z.string().max(128).describe('Model identifier, e.g. claude-sonnet-4-6'),
      },
      annotations: {
        title: 'Check rate limit (increments counter on allow)',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ agent_id, provider, model }) => {
      const result = await stub.checkRate(agent_id, provider, model);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'idempotency_check',
    {
      description: 'Dedupe retries on a caller-supplied key. Returns is_first_call=true the first time a key is seen, false on subsequent calls within TTL. Use to prevent double-charges, double-emails, or double-side-effects from agent retry loops.',
      inputSchema: {
        key: z.string().min(1).max(256).describe('Idempotency key — unique per logical operation'),
        ttl_seconds: z.number().int().finite().positive().max(MAX_TTL_SECONDS).optional().describe('Time-to-live in seconds (default 3600, max 30 days)'),
      },
      annotations: {
        title: 'Reserve an idempotency key',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ key, ttl_seconds }) => {
      const result = await checkIdempotency(c.env.BUDGET_KV, accountId, key, ttl_seconds ?? DEFAULT_TTL_SECONDS);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'request_approval',
    {
      description: 'Request human approval for an agent action. Returns immediately with an approval_id and approval_url; the human approves or denies on a web page, and the agent polls check_approval to learn the decision. Notifies the account holder via the configured channel (V1: email only; telegram/sms accepted in schema but rejected with channel_not_implemented). NOT idempotent — retries create duplicate approvals; gate with idempotency_check if needed.',
      inputSchema: {
        agent_id: z.string().min(1).max(MAX_AGENT_ID_CHARS).describe('Agent identifier requesting approval'),
        action_summary: z.string().min(1).max(MAX_ACTION_SUMMARY_CHARS).describe('Human-readable description of the action awaiting approval (≤280 chars)'),
        ttl_seconds: z.number().int().finite().min(MIN_APPROVAL_TTL_SECONDS).max(MAX_APPROVAL_TTL_SECONDS).optional().describe(`Time the approver has to decide (default ${DEFAULT_APPROVAL_TTL_SECONDS}s, max 7 days)`),
        channels: z.array(z.enum(['email', 'telegram', 'sms'])).optional().describe('Notification channels (default ["email"]; telegram/sms accepted for forward-compat but not yet delivered)'),
      },
      annotations: {
        title: 'Request human approval for an action',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ agent_id, action_summary, ttl_seconds, channels }) => {
      const result = await requestApproval(c.env, accountId, origin, { agent_id, action_summary, ttl_seconds, channels });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.body) }] };
    },
  );

  server.registerTool(
    'check_approval',
    {
      description: 'Poll the status of a pending approval. Returns decision: "pending" while the human has not decided, "approved" or "denied" once they have, or "timeout" if expires_at has passed without a decision.',
      inputSchema: {
        approval_id: z.string().min(1).max(64).describe('approval_id returned by request_approval'),
      },
      annotations: {
        title: 'Check the status of an approval request',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ approval_id }) => {
      const result = await checkApproval(c.env, accountId, approval_id);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.body) }] };
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
}
