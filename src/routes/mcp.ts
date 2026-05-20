import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { Context } from 'hono';
import type { Env } from '../lib/types';
import { getAccount } from '../lib/kv';
import { nextDailyReset } from '../lib/models';

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

  const server = new McpServer({ name: 'budget-governor', version: '1.2.0' });

  server.registerTool(
    'budget_clear',
    {
      description: 'Check if an agent is authorized to spend tokens and deduct the estimated cost from its envelope.',
      inputSchema: {
        agent_id: z.string().max(128).describe('The agent identifier'),
        model: z.string().describe('Model being called (e.g. claude-sonnet-4-6, gpt-4o)'),
        estimated_tokens: z.number().int().finite().positive().describe('Estimated output tokens for the request'),
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
    },
    async ({ agent_id, provider, model }) => {
      const result = await stub.checkRate(agent_id, provider, model);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
}
