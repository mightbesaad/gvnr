import { Hono } from 'hono';
import type { Env } from './lib/types';
import { buildX402Middleware } from './lib/x402';
import { mcpHandler } from './routes/mcp';
import accountRoutes from './routes/account';
import envelopeRoutes from './routes/envelope';
import budgetRoutes from './routes/budget';
import rateRoutes from './routes/rate';
import idempotencyRoutes from './routes/idempotency';
import approvalRoutes from './routes/approval';
import approveRoutes from './routes/approve';
import payRoutes from './routes/pay';
import tosRoutes from './routes/tos';
import b2bRoutes from './routes/b2b';
import { getAccount } from './lib/kv';
import { renderPriceTable } from './lib/models';
export { AccountState } from './lib/account-do';

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof SyntaxError) {
    return c.json({ error: 'invalid_json' }, 400);
  }
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
});

app.get('/health', (c) => c.json({ ok: true }));

app.get('/robots.txt', (c) => {
  return c.text(
    'User-agent: GPTBot\nAllow: /\nDisallow: /v1/\nDisallow: /admin/\n\n' +
    'User-agent: ClaudeBot\nAllow: /\nDisallow: /v1/\nDisallow: /admin/\n\n' +
    'User-agent: PerplexityBot\nAllow: /\nDisallow: /v1/\nDisallow: /admin/\n\n' +
    'User-agent: *\nDisallow: /v1/\nDisallow: /admin/\n\nSitemap: https://gvnr.dev/sitemap.xml\n',
  );
});

app.get('/.well-known/api-catalog', (c) => {
  c.header('Content-Type', 'application/linkset+json');
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json({
    linkset: [{
      anchor: 'https://gvnr.dev',
      'service-desc': [{ href: 'https://gvnr.dev/openapi.json', type: 'application/openapi+json' }],
      'service-doc':  [{ href: 'https://gvnr.dev' }],
      status:         [{ href: 'https://gvnr.dev/health' }],
    }],
  });
});

app.get('/.well-known/oauth-protected-resource', (c) => {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json({
    resource: 'https://gvnr.dev',
    bearer_methods_supported: ['header', 'query'],
    resource_documentation: 'https://gvnr.dev/openapi.json',
  });
});

app.get('/.well-known/agent-skills/index.json', (c) => {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json({
    $schema: 'https://cloudflare.github.io/agent-skills-discovery-rfc/schema/v0.2.0/index.schema.json',
    skills: [
      {
        name: 'budget_clear',
        type: 'mcp',
        description: 'Check if an agent is authorized to spend tokens and deduct the estimated cost from its envelope. For chat models pass output tokens; for embedding/input-only models pass input tokens.',
        url: 'https://gvnr.dev/mcp',
        sha256: '65c73571b38c2a921d342f91535a28353f4e1e87756829f4a16d7850c783c5f1',
      },
      {
        name: 'set_envelope',
        type: 'mcp',
        description: 'Create or update a spend envelope (daily or session cap in USD) for an agent.',
        url: 'https://gvnr.dev/mcp',
        sha256: '6629227e6c6782cebd05af3f2ecbd1f986df5c5dea91cb755fc77118b143902a',
      },
      {
        name: 'get_balance',
        type: 'mcp',
        description: 'Get the remaining governance-operation quota for this account (one budget_clear = one op).',
        url: 'https://gvnr.dev/mcp',
        sha256: '5f0e5e27eb2d2e1dd303892eb46edea7e6987524284e5f646e739300e9bc355f',
      },
      {
        name: 'reconcile',
        type: 'mcp',
        description: 'Reconcile a previous budget_clear with actual usage from the LLM response. Applies the drift (actual minus estimated cost) to the agent envelope (the spend cap). The governance-operation quota is not affected.',
        url: 'https://gvnr.dev/mcp',
        sha256: '0fabe12e7ca5a969b3726e6fa1943e911e91b85a7580fc6bd1ec30720ef5d62e',
      },
      {
        name: 'set_rate_envelope',
        type: 'mcp',
        description: 'Create or update a rate-limit envelope for an (agent, provider, model) triple. Each envelope tracks requests per fixed 60-second window.',
        url: 'https://gvnr.dev/mcp',
        sha256: '4afa0b3437c801e4aa6f0c96882525be73bf7ad3cbdeb11151dbc8553c8d6585',
      },
      {
        name: 'rate_check',
        type: 'mcp',
        description: 'Check whether an agent is allowed to make a call against the rate envelope for the given (provider, model). Increments the counter on allow.',
        url: 'https://gvnr.dev/mcp',
        sha256: 'f9a2bd5e4d21c3e278efee3a439df65be1d08854ee2d90ddcb15092ecf67fc83',
      },
      {
        name: 'idempotency_check',
        type: 'mcp',
        description: 'Dedupe retries on a caller-supplied key. Returns is_first_call=true the first time a key is seen, false on subsequent calls within TTL. Use to prevent double-charges, double-emails, or double-side-effects from agent retry loops.',
        url: 'https://gvnr.dev/mcp',
        sha256: 'edfe3444996affb1e29d86d7ac7768d33d15251e7c58c505dc1469738999a589',
      },
      {
        name: 'request_approval',
        type: 'mcp',
        description: 'Request human approval for an agent action. Returns immediately with an approval_id and approval_url; the human approves or denies on a web page, and the agent polls check_approval to learn the decision.',
        url: 'https://gvnr.dev/mcp',
        sha256: '0b8fee267e6ff967f5300545caf00309549819cdfec86d8a3f8d13e9904bc1e7',
      },
      {
        name: 'check_approval',
        type: 'mcp',
        description: 'Poll the status of a pending approval. Returns decision: pending, approved, denied, or timeout once the deadline passes.',
        url: 'https://gvnr.dev/mcp',
        sha256: '9d4adacf9c2c4f1d96a5f3e0aa8a72e1d75b9c529a694703d87d40caa6a41ff5',
      },
    ],
  });
});

app.get('/sitemap.xml', (c) => {
  c.header('Content-Type', 'application/xml');
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://gvnr.dev/</loc></url>
  <url><loc>https://gvnr.dev/b2b</loc></url>
  <url><loc>https://gvnr.dev/tos</loc></url>
  <url><loc>https://gvnr.dev/pay/starter</loc></url>
  <url><loc>https://gvnr.dev/pay/growth</loc></url>
  <url><loc>https://gvnr.dev/pay/studio</loc></url>
</urlset>`);
});

app.get('/.well-known/mcp.json', (c) => {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json({
    name: 'Gvnr',
    description: 'x402-paying AI agent substrate: spend caps, rate limits, idempotency, reconciliation, approval bridges. One MCP endpoint, one credit pool, settled via x402 (USDC on Base).',
    version: '1.5.2',
    url: 'https://gvnr.dev/mcp',
    transport: ['streamable-http'],
    authentication: {
      type: 'bearer',
      description: 'API key obtained from POST https://gvnr.dev/v1/account',
    },
    tools: [
      {
        name: 'budget_clear',
        description: 'Check if an agent is authorized to spend tokens and deduct the estimated cost',
        annotations: { title: 'Clear budget for a planned LLM call', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      {
        name: 'set_envelope',
        description: 'Create or update a spend envelope for an agent',
        annotations: { title: 'Set spend envelope for an agent', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: 'get_balance',
        description: 'Get the remaining governance-operation quota for this account',
        annotations: { title: 'Get governance-operation quota', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: 'reconcile',
        description: 'Reconcile a prior budget_clear with actual usage; applies the drift to the agent envelope (spend cap)',
        annotations: { title: 'Reconcile a clearance with actual usage', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      {
        name: 'set_rate_envelope',
        description: 'Create or update a rate-limit envelope per (agent, provider, model)',
        annotations: { title: 'Set rate envelope for (agent, provider, model)', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: 'rate_check',
        description: 'Check whether an agent is allowed to make a call against the rate envelope; increments the counter on allow',
        annotations: { title: 'Check rate limit (increments counter on allow)', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      {
        name: 'idempotency_check',
        description: 'Dedupe retries on a caller-supplied key; returns is_first_call=true on first call, false on replays within TTL',
        annotations: { title: 'Reserve an idempotency key', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: 'request_approval',
        description: 'Request human approval for an agent action; returns approval_id + approval_url, agent polls check_approval for the decision',
        annotations: { title: 'Request human approval for an action', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      {
        name: 'check_approval',
        description: 'Poll the status of a pending approval (pending / approved / denied / timeout)',
        annotations: { title: 'Check the status of an approval request', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
    ],
  });
});

app.get('/openapi.json', (c) => {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json({
    openapi: '3.1.0',
    info: { title: 'Gvnr', version: '1.5.2', description: 'AI agent substrate — spend caps, rate limits, idempotency, post-call reconciliation, and human approval bridges.' },
    servers: [{ url: 'https://gvnr.dev' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key from POST /v1/account' },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string', description: 'Stable machine-readable error code (e.g. "invalid_params", "rate_limited", "not_found")' },
            required: { type: 'array', items: { type: 'string' }, description: 'Names/descriptors of required fields when error is "invalid_params"' },
            hint: { type: 'string', description: 'Human-readable guidance for resolving the error' },
            detail: { type: 'string', description: 'Additional context for the error' },
            valid: { type: 'array', items: { type: 'string' }, description: 'Allowed values when input was rejected as out-of-set' },
            valid_channels: { type: 'array', items: { type: 'string' }, description: 'Allowed notification channels (for approval requests)' },
            retry_after: { type: 'string', description: 'Soft retry hint (e.g. "next_minute", "next_hour")' },
            limit: { type: 'string', description: 'Description of the limit that was hit' },
          },
        },
      },
    },
    paths: {
      '/v1/account': {
        post: {
          summary: 'Provision account',
          responses: {
            '201': {
              description: 'Account created — returns api_key (use as Bearer token) and account_id',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['api_key', 'account_id'],
                properties: {
                  api_key: { type: 'string', description: 'Bearer token for subsequent requests; format `bg_...`' },
                  account_id: { type: 'string', description: 'Stable account identifier' },
                },
              } } },
            },
            '429': {
              description: 'Rate limited (account provisioning is per-IP capped)',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/v1/account/balance': {
        get: {
          summary: 'Get governance-operation quota',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Remaining governance operations on the account',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['operations_remaining'],
                properties: { operations_remaining: { type: 'integer', description: 'Governance operations remaining (one budget_clear = one op)' } },
              } } },
            },
            default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/v1/account/topup-verify/{pack}': {
        post: {
          summary: 'Verify on-chain USDC payment and credit account',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'pack', in: 'path', required: true, schema: { type: 'string', enum: ['starter', 'growth', 'studio'] } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { tx_hash: { type: 'string', description: 'Base mainnet USDC transaction hash (0x-prefixed, 64 hex chars)' } }, required: ['tx_hash'] } } } },
          responses: {
            '200': {
              description: 'Credits applied (or already_credited=true if tx was previously verified)',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['operations_remaining', 'pack'],
                properties: {
                  operations_remaining: { type: 'integer', description: 'Governance operations remaining after credit' },
                  pack: { type: 'string', enum: ['starter', 'growth', 'studio'] },
                  credited_ops: { type: 'integer', description: 'Governance operations granted by this pack' },
                  already_credited: { type: 'boolean', description: 'True if this tx_hash was previously verified (idempotent replay)' },
                },
              } } },
            },
            default: { description: 'Error (invalid_pack, invalid_tx_hash, misconfigured_network, on-chain verification failure)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/v1/budget/clear': {
        post: {
          summary: 'Clearance call — approve or deny agent spend',
          security: [{ bearerAuth: [] }],
          requestBody: { content: { 'application/json': { schema: {
            type: 'object',
            required: ['agent_id', 'model', 'estimated_tokens'],
            properties: {
              agent_id: { type: 'string', maxLength: 128, description: 'Agent identifier (must have a spend envelope set via PUT /v1/budget/envelope)' },
              model: { type: 'string', description: 'Provider model identifier (e.g. claude-sonnet-4-6, gpt-4o, text-embedding-3-small)' },
              estimated_tokens: { type: 'integer', minimum: 1, description: 'Output tokens for chat models, input tokens for embedding/input-only models' },
            },
          } } } },
          responses: {
            '200': {
              description: 'Clearance result — always 200; check `approved` field',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['approved', 'remaining_usd'],
                properties: {
                  approved: { type: 'boolean', description: 'True if the call is authorized; false if denied' },
                  remaining_usd: { type: 'number', description: 'USD remaining on the agent envelope after this clearance (0 if denied for no_credits/no_envelope)' },
                  operations_remaining: { type: 'integer', description: 'Governance operations remaining after this clearance (present when approved=true)' },
                  reason: { type: 'string', enum: ['no_credits', 'no_envelope', 'envelope_exceeded'], description: 'Present only when approved=false. no_credits = governance quota exhausted' },
                },
              } } },
            },
            default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/v1/budget/reconcile': {
        post: {
          summary: 'Reconcile a prior clearance with actual LLM usage; applies drift to the agent envelope (spend cap)',
          security: [{ bearerAuth: [] }],
          requestBody: { content: { 'application/json': { schema: {
            type: 'object',
            required: ['agent_id', 'actual_input_tokens', 'actual_output_tokens'],
            properties: {
              agent_id: { type: 'string', maxLength: 128 },
              actual_input_tokens: { type: 'integer', minimum: 0, description: 'Actual input tokens reported by the provider' },
              actual_output_tokens: { type: 'integer', minimum: 0, description: 'Actual output tokens reported by the provider' },
            },
          } } } },
          responses: {
            '200': {
              description: 'Drift applied — the agent envelope (spend cap) corrected by (actual − estimated). warning="drift_exceeds_2x_threshold" when actual cost was >2× the estimate',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['ok', 'drift_usd', 'remaining_usd', 'operations_remaining'],
                properties: {
                  ok: { type: 'boolean', description: 'Always true on 200; false outcomes return 400' },
                  drift_usd: { type: 'number', description: 'Signed: positive if actual > estimated, negative if actual < estimated. Adjusts the spend cap only' },
                  remaining_usd: { type: 'number', description: 'USD remaining on the agent envelope after drift applied' },
                  operations_remaining: { type: 'integer', description: 'Governance operations remaining (unchanged by reconcile)' },
                  warning: { type: 'string', enum: ['drift_exceeds_2x_threshold'] },
                },
              } } },
            },
            default: { description: 'Error (no_envelope, no_pending_clearance, invalid_params)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/v1/rate/envelope': {
        put: {
          summary: 'Create or update a rate-limit envelope per (agent, provider, model)',
          security: [{ bearerAuth: [] }],
          requestBody: { content: { 'application/json': { schema: {
            type: 'object',
            required: ['agent_id', 'provider', 'model', 'requests_per_minute'],
            properties: {
              agent_id: { type: 'string', maxLength: 128 },
              provider: { type: 'string', maxLength: 64, description: 'Informational, e.g. "anthropic", "openai", "bedrock"' },
              model: { type: 'string', maxLength: 128, description: 'Model identifier, e.g. "claude-sonnet-4-6"' },
              requests_per_minute: { type: 'integer', minimum: 1, maximum: 1000000, description: 'Cap per fixed 60-second window (not sliding)' },
            },
          } } } },
          responses: {
            '200': {
              description: 'Envelope created or updated',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['success', 'agent_id', 'provider', 'model', 'requests_per_minute'],
                properties: {
                  success: { type: 'boolean', enum: [true] },
                  agent_id: { type: 'string' },
                  provider: { type: 'string' },
                  model: { type: 'string' },
                  requests_per_minute: { type: 'integer' },
                },
              } } },
            },
            default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/v1/rate/envelope/{agent_id}/{provider}/{model}': {
        get: {
          summary: 'Read current rate envelope state',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'agent_id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'provider', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'model', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'Current rate envelope record with live window state',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['agent_id', 'provider', 'model', 'requests_per_minute', 'requests_in_window', 'window_start'],
                properties: {
                  agent_id: { type: 'string' },
                  provider: { type: 'string' },
                  model: { type: 'string' },
                  requests_per_minute: { type: 'integer' },
                  requests_in_window: { type: 'integer', description: 'Count consumed in the current 60s window' },
                  window_start: { type: 'integer', description: 'Unix ms when the current window opened' },
                },
              } } },
            },
            '404': { description: 'Envelope not found for this triple', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        delete: {
          summary: 'Delete a rate envelope',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'agent_id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'provider', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'model', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'Envelope deleted',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['success', 'agent_id', 'provider', 'model'],
                properties: {
                  success: { type: 'boolean', enum: [true] },
                  agent_id: { type: 'string' },
                  provider: { type: 'string' },
                  model: { type: 'string' },
                },
              } } },
            },
            '404': { description: 'Envelope not found for this triple', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/v1/rate/check': {
        post: {
          summary: 'Runtime rate check — returns allowed=true with remaining count, or allowed=false with retry_after_ms',
          security: [{ bearerAuth: [] }],
          requestBody: { content: { 'application/json': { schema: {
            type: 'object',
            required: ['agent_id', 'provider', 'model'],
            properties: {
              agent_id: { type: 'string', maxLength: 128 },
              provider: { type: 'string' },
              model: { type: 'string' },
            },
          } } } },
          responses: {
            '200': {
              description: 'Rate check result — always 200; check `allowed` field. On allow, the counter is incremented as a side effect',
              content: { 'application/json': { schema: {
                oneOf: [
                  {
                    type: 'object',
                    required: ['allowed', 'requests_remaining_this_minute'],
                    properties: {
                      allowed: { type: 'boolean', enum: [true] },
                      requests_remaining_this_minute: { type: 'integer', description: 'Capacity left after counting this request' },
                    },
                  },
                  {
                    type: 'object',
                    required: ['allowed', 'reason'],
                    properties: {
                      allowed: { type: 'boolean', enum: [false] },
                      reason: { type: 'string', enum: ['no_rate_envelope', 'rate_exceeded'] },
                      retry_after_ms: { type: 'integer', description: 'Present only when reason="rate_exceeded"; ms until window resets' },
                    },
                  },
                ],
              } } },
            },
            default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/v1/idempotency/check': {
        post: {
          summary: 'Dedupe retries on a caller-supplied key — first call stores it, subsequent calls within TTL return is_first_call=false',
          security: [{ bearerAuth: [] }],
          requestBody: { content: { 'application/json': { schema: {
            type: 'object',
            required: ['key'],
            properties: {
              key: { type: 'string', minLength: 1, maxLength: 256, description: 'Account-scoped idempotency key' },
              ttl_seconds: { type: 'integer', minimum: 1, maximum: 2592000, description: 'TTL for the key (default 3600, max 30 days)' },
            },
          } } } },
          responses: {
            '200': {
              description: 'Check-and-set result',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['is_first_call', 'ttl_remaining_seconds'],
                properties: {
                  is_first_call: { type: 'boolean', description: 'True on first observation of this key within TTL; false on replay' },
                  ttl_remaining_seconds: { type: 'integer', description: 'Seconds left before this key expires from the dedup store' },
                },
              } } },
            },
            default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/v1/account/notification-email': {
        get: {
          summary: 'Get the configured notification email (used by request_approval)',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Returns the configured email (null if unset)',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['notification_email'],
                properties: {
                  notification_email: { type: ['string', 'null'], format: 'email' },
                },
              } } },
            },
            default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          summary: 'Set the email Gvnr notifies when request_approval fires',
          security: [{ bearerAuth: [] }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string', format: 'email' } }, required: ['email'] } } } },
          responses: {
            '200': {
              description: 'Email stored',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['ok', 'notification_email'],
                properties: {
                  ok: { type: 'boolean', enum: [true] },
                  notification_email: { type: 'string', format: 'email' },
                },
              } } },
            },
            default: { description: 'Error (invalid_email)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        delete: {
          summary: 'Clear the configured notification email (right-to-erasure)',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Email cleared (or was already unset — idempotent)',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['ok'],
                properties: { ok: { type: 'boolean', enum: [true] } },
              } } },
            },
            default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/v1/approval/request': {
        post: {
          summary: 'Create an approval request — returns approval_id, approval_url, expires_at',
          security: [{ bearerAuth: [] }],
          requestBody: { content: { 'application/json': { schema: {
            type: 'object',
            required: ['agent_id', 'action_summary'],
            properties: {
              agent_id: { type: 'string', maxLength: 128 },
              action_summary: { type: 'string', maxLength: 280, description: 'Human-readable description of what needs approval' },
              ttl_seconds: { type: 'integer', minimum: 1, maximum: 604800, description: 'How long the approver has to decide (default 600s, max 7 days)' },
              channels: { type: 'array', items: { type: 'string', enum: ['email', 'telegram', 'sms'] }, description: 'Notification channels (default ["email"]; telegram/sms accepted in schema but rejected with channel_not_implemented in V1)' },
            },
          } } } },
          responses: {
            '200': {
              description: 'Approval created; notification dispatched per channel',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['approval_id', 'approval_url', 'expires_at', 'notification'],
                properties: {
                  approval_id: { type: 'string', description: 'Opaque ID; pass to GET /v1/approval/check/{approval_id} to poll' },
                  approval_url: { type: 'string', format: 'uri', description: 'Mobile-first approval page URL to send to the human' },
                  expires_at: { type: 'integer', description: 'Unix ms when the approval window closes' },
                  notification: {
                    type: 'object',
                    required: ['email'],
                    properties: {
                      email: { type: 'string', description: 'Dispatch status: "sent" | "no_address" | "skipped_no_key" | "failed"' },
                      error: { type: 'string', description: 'Failure detail when status="failed"' },
                    },
                  },
                },
              } } },
            },
            '429': { description: 'Rate limited (30 request_approval calls per minute per account)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            default: { description: 'Error (invalid_agent_id, invalid_action_summary, invalid_ttl_seconds, invalid_channels, channel_not_implemented, notification_email_unset)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/v1/approval/check/{approval_id}': {
        get: {
          summary: 'Poll the status of an approval request',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'approval_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Current approval state',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['approval_id', 'decision', 'agent_id', 'action_summary', 'created_at', 'expires_at'],
                properties: {
                  approval_id: { type: 'string' },
                  decision: { type: 'string', enum: ['pending', 'approved', 'denied', 'timeout'] },
                  agent_id: { type: 'string' },
                  action_summary: { type: 'string' },
                  created_at: { type: 'integer', description: 'Unix ms' },
                  expires_at: { type: 'integer', description: 'Unix ms' },
                  responder: { type: 'string', description: 'Present when decision is approved or denied' },
                  decided_at: { type: 'integer', description: 'Unix ms when the human decided (approved/denied only)' },
                },
              } } },
            },
            '404': { description: 'approval_not_found (wrong account, wrong id, or storage TTL elapsed past grace window)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/approve/{approval_id}': {
        get: {
          summary: 'Human-facing approval page (mobile-first single-page UI)',
          parameters: [{ name: 'approval_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'HTML approval UI' } },
        },
      },
      '/approve/{approval_id}/decide': {
        post: {
          summary: 'Submit an approval decision (form POST from the approval page)',
          parameters: [{ name: 'approval_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { decision: { type: 'string', enum: ['approved', 'denied'] } }, required: ['decision'] } } } },
          responses: { '200': { description: 'HTML confirmation page' } },
        },
      },
      '/v1/account/topup/{pack}': {
        post: {
          summary: 'x402-gated machine credit top-up — pays on-chain via the x402 protocol and credits the account in one round-trip',
          description: 'Returns 402 Payment Required with x402 headers if no payment is present. Pair with an x402 client (e.g. x402-fetch from Coinbase) which signs payment and re-requests automatically.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'pack', in: 'path', required: true, schema: { type: 'string', enum: ['starter', 'growth', 'studio'] } }],
          responses: {
            '200': {
              description: 'Payment verified, credits applied',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['operations_remaining', 'pack'],
                properties: {
                  operations_remaining: { type: 'integer', description: 'Governance operations remaining after credit' },
                  pack: { type: 'string', enum: ['starter', 'growth', 'studio'] },
                  credited_ops: { type: 'integer', description: 'Governance operations granted by this pack' },
                },
              } } },
            },
            '402': { description: 'Payment Required — x402 headers contain the payment instructions (network, asset, amount, payto address)' },
            default: { description: 'Error (invalid_pack, misconfigured_network)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/v1/budget/envelope': {
        put: {
          summary: 'Create or update agent spend envelope',
          security: [{ bearerAuth: [] }],
          requestBody: { content: { 'application/json': { schema: {
            type: 'object',
            required: ['agent_id', 'limit_usd'],
            properties: {
              agent_id: { type: 'string', maxLength: 128 },
              limit_usd: { type: 'number', minimum: 0.000001, maximum: 1000000, description: 'Spend cap in USD over the window' },
              window: { type: 'string', enum: ['daily', 'session'], description: 'daily=resets at UTC midnight; session=never resets (caller-managed). Default: daily' },
            },
          } } } },
          responses: {
            '200': {
              description: 'Envelope created or updated (running spent_usd and reset_at preserved on update)',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['success', 'agent_id', 'limit_usd', 'window'],
                properties: {
                  success: { type: 'boolean', enum: [true] },
                  agent_id: { type: 'string' },
                  limit_usd: { type: 'number' },
                  window: { type: 'string', enum: ['daily', 'session'] },
                },
              } } },
            },
            default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/v1/budget/envelope/{agent_id}': {
        get: {
          summary: 'Read envelope state',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'agent_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Current envelope record',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['agent_id', 'limit_usd', 'spent_usd', 'remaining_usd', 'window', 'reset_at'],
                properties: {
                  agent_id: { type: 'string' },
                  limit_usd: { type: 'number' },
                  spent_usd: { type: 'number', description: 'Cumulative spend in the current window' },
                  remaining_usd: { type: 'number', description: 'Always max(0, limit − spent)' },
                  window: { type: 'string', enum: ['daily', 'session'] },
                  reset_at: { type: 'integer', description: 'Unix ms when the daily window next resets (informational for session)' },
                },
              } } },
            },
            '404': { description: 'Envelope not found for this agent_id', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        delete: {
          summary: 'Delete an agent envelope',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'agent_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Envelope deleted',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['success', 'agent_id'],
                properties: {
                  success: { type: 'boolean', enum: [true] },
                  agent_id: { type: 'string' },
                },
              } } },
            },
            '404': { description: 'Envelope not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/v1/packs/{pack}/info': {
        get: {
          summary: 'Get pack details and payment info',
          parameters: [{ name: 'pack', in: 'path', required: true, schema: { type: 'string', enum: ['starter', 'growth', 'studio'] } }],
          responses: {
            '200': {
              description: 'Pack pricing + receiving wallet for direct USDC send',
              content: { 'application/json': { schema: {
                type: 'object',
                required: ['pack', 'amount_usd', 'description', 'network_name', 'chain_id', 'usdc_contract', 'usdc_amount_raw', 'payto_address'],
                properties: {
                  pack: { type: 'string', enum: ['starter', 'growth', 'studio'] },
                  amount_usd: { type: 'number' },
                  description: { type: 'string' },
                  network_name: { type: 'string', description: 'Human-readable chain name (e.g. "Base mainnet")' },
                  chain_id: { type: 'integer', description: 'EVM chain ID (8453 for Base, 84532 for Base Sepolia)' },
                  usdc_contract: { type: 'string', description: 'USDC contract address on this chain' },
                  usdc_amount_raw: { type: 'string', description: 'Amount in USDC base units (string to preserve precision)' },
                  payto_address: { type: 'string', description: 'Address to send USDC to; pair with POST /v1/account/topup-verify/{pack}' },
                },
              } } },
            },
            default: { description: 'Error (invalid_pack, misconfigured_network)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/mcp': {
        post: {
          summary: 'MCP server endpoint (Streamable HTTP)',
          security: [{ bearerAuth: [] }],
          description: 'Pass api_key as query param or Authorization: Bearer header. Body and response are JSON-RPC 2.0 envelopes per the MCP spec (tools/list, tools/call, etc.); shapes are opaque to this OpenAPI definition.',
          responses: {
            '200': { description: 'MCP JSON-RPC response', content: { 'application/json': { schema: { type: 'object', description: 'JSON-RPC 2.0 envelope; see modelcontextprotocol.io for shape' } } } },
            default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
    },
  });
});

app.get('/favicon.ico', (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="6" fill="#111"/>
    <text x="16" y="22" font-family="system-ui,sans-serif" font-size="18"
      font-weight="600" fill="#a78bfa" text-anchor="middle">G</text>
  </svg>`;
  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=86400');
  return c.body(svg);
});

app.get('/', (c) => {
  const network = c.env.X402_NETWORK === 'eip155:8453' ? 'Base mainnet' : 'Base Sepolia (testnet)';
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Link', '</openapi.json>; rel="describedby", </.well-known/mcp.json>; rel="mcp"');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gvnr — AI agent substrate</title>
  <meta name="description" content="AI agent substrate — spend caps, rate limits, idempotency, post-call reconciliation, and human approval bridges. One MCP endpoint, one credit pool.">
  <meta property="og:title" content="Gvnr">
  <meta property="og:description" content="AI agent substrate — spend caps, rate limits, idempotency, post-call reconciliation, and human approval bridges. One MCP endpoint, one credit pool.">
  <meta property="og:url" content="https://gvnr.dev">
  <meta property="og:type" content="website">
  <meta name="robots" content="index, follow">
  <link rel="describedby" href="/openapi.json">
  <link rel="mcp" href="/.well-known/mcp.json">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 56px 28px 64px; min-height: 100vh; counter-reset: section; line-height: 1.55; }
    .container { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 2.6rem; font-weight: 700; letter-spacing: -0.035em; margin-bottom: 12px; line-height: 1.05; background: linear-gradient(180deg,#fff,#bababa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .tagline { color: #cfcfcf; font-size: 1.15rem; margin-bottom: 14px; line-height: 1.4; font-weight: 400; }
    .value-prop { color: #999; font-size: 0.92rem; margin-bottom: 24px; line-height: 1.6; }
    .header-row { display: flex; align-items: center; justify-content: flex-start; gap: 14px; margin-bottom: 0; flex-wrap: wrap; }
    .status { display: flex; align-items: center; gap: 10px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; flex-shrink: 0; box-shadow: 0 0 8px rgba(34,197,94,0.5); }
    .status-text { font-size: 0.88rem; color: #aaa; }
    .status-text strong { color: #e5e5e5; }
    .cta-btn { display: inline-block; background: #4f46e5; color: #fff; text-decoration: none; padding: 10px 22px; border-radius: 8px; font-size: 0.92rem; font-weight: 500; white-space: nowrap; transition: all 0.15s; box-shadow: 0 4px 14px rgba(79,70,229,0.25); }
    .cta-btn:hover { opacity: 0.92; transform: translateY(-1px); box-shadow: 0 6px 18px rgba(79,70,229,0.35); }
    section { margin-bottom: 56px; }
    h2 { font-size: 1.35rem; font-weight: 600; letter-spacing: -0.015em; color: #e5e5e5; margin-bottom: 18px; display: flex; align-items: baseline; gap: 12px; }
    h2::before { counter-increment: section; content: "[" counter(section, decimal-leading-zero) "]"; color: #555; font-family: "SF Mono","Fira Code",monospace; font-size: 0.78rem; font-weight: 500; letter-spacing: 0.04em; }
    .tools { display: flex; flex-direction: column; gap: 10px; }
    .tool { background: #111; border: 1px solid #1f1f1f; border-radius: 8px; padding: 14px 16px; }
    .tool-name { font-family: "SF Mono", "Fira Code", monospace; font-size: 0.85rem; color: #a78bfa; margin-bottom: 4px; }
    .tool-desc { font-size: 0.85rem; color: #888; }
    pre { background: #111; border: 1px solid #1f1f1f; border-radius: 8px; padding: 16px; font-family: "SF Mono", "Fira Code", monospace; font-size: 0.8rem; color: #ccc; white-space: pre-wrap; word-break: break-all; line-height: 1.6; }
    .network-badge { display: inline-block; padding: 3px 10px; border-radius: 4px; font-size: 0.78rem; font-family: monospace; background: #1a1a2e; color: #818cf8; border: 1px solid #2a2a4a; }
    .packs { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .pack { display: block; background: #111; border: 1px solid #1f1f1f; border-radius: 8px; padding: 16px 18px; text-decoration: none; color: inherit; flex: 1; min-width: 150px; transition: border-color 0.15s; }
    .pack:hover { border-color: #4f46e5; }
    .pack-name { font-family: "SF Mono", "Fira Code", monospace; font-size: 0.85rem; color: #a78bfa; margin-bottom: 4px; }
    .pack-price { font-size: 1.25rem; font-weight: 700; color: #e5e5e5; margin-bottom: 4px; }
    .pack-detail { font-size: 0.82rem; color: #888; }
    .key-row { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
    .key-input { flex: 1; background: #0f0f0f; border: 1px solid #222; border-radius: 6px; padding: 8px 12px; font-family: "SF Mono", "Fira Code", monospace; font-size: 0.82rem; color: #ccc; outline: none; transition: border-color 0.15s; }
    .key-input:focus { border-color: #4f46e5; }
    .key-input::placeholder { color: #555; }
    footer { border-top: 1px solid #1a1a1a; margin-top: 48px; padding-top: 24px; }
    .footer-row { display: flex; gap: 20px; flex-wrap: wrap; font-size: 0.78rem; color: #666; line-height: 1.8; }
    .footer-row a { color: #777; text-decoration: none; }
    .footer-row a:hover { color: #aaa; }
    .footer-mono { font-family: "SF Mono", "Fira Code", monospace; font-size: 0.72rem; color: #888; }
    .btn-get-key { background: #1a1a2e; color: #a78bfa; border: 1px solid #2a2a4a; border-radius: 6px; padding: 8px 14px; font-size: 0.82rem; font-weight: 500; cursor: pointer; white-space: nowrap; transition: opacity 0.15s; flex-shrink: 0; }
    .btn-get-key:hover { opacity: 0.85; }
    .key-row { flex-wrap: wrap; }
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.88); z-index: 100; align-items: center; justify-content: center; padding: 24px; }
    .modal-box { background: #111; border: 1px solid #2a2a2a; border-radius: 12px; padding: 28px; max-width: 440px; width: 100%; }
    .modal-title { font-size: 1rem; font-weight: 600; margin-bottom: 14px; }
    .modal-warning { background: #1a0808; border: 1px solid #3a1414; color: #f87171; font-size: 0.82rem; padding: 10px 12px; border-radius: 6px; margin-bottom: 14px; line-height: 1.6; }
    .modal-key-row { display: flex; gap: 8px; margin-bottom: 20px; }
    .modal-key { font-family: "SF Mono","Fira Code",monospace; font-size: 0.82rem; color: #e5e5e5; background: #0f0f0f; border: 1px solid #222; border-radius: 6px; padding: 9px 12px; flex: 1; word-break: break-all; }
    .modal-done-btn { width: 100%; background: #4f46e5; color: #fff; border: none; border-radius: 8px; padding: 11px; font-size: 0.9rem; font-weight: 500; cursor: pointer; transition: opacity 0.15s; }
    .modal-done-btn:hover { opacity: 0.85; }
    pre { overflow-x: auto; }

    .docs-nav { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 10px 14px; background: #0d0d0d; border: 1px solid #1a1a1a; border-radius: 8px; margin-bottom: 28px; font-size: 0.78rem; align-items: center; }
    .docs-nav a { color: #999; text-decoration: none; padding: 2px 0; transition: color 0.15s; }
    .docs-nav a:hover { color: #a78bfa; }
    .docs-nav .nav-dot { color: #2a2a2a; }
    .docs-nav .nav-label { color: #555; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; margin-right: 4px; }

    .compose { display: flex; gap: 12px; flex-wrap: wrap; }
    .compose-col { flex: 1; min-width: 170px; background: #0d0d0d; border: 1px solid #1a1a1a; border-radius: 8px; padding: 14px; }
    .compose-col-head { font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #777; margin-bottom: 12px; }
    .compose-step { background: #111; border: 1px solid #1f1f1f; border-radius: 6px; padding: 7px 10px; font-family: "SF Mono","Fira Code",monospace; font-size: 0.76rem; color: #a78bfa; }
    .compose-step.muted { color: #aaa; font-family: -apple-system,sans-serif; font-style: italic; background: #0f0f0f; }
    .compose-arrow { text-align: center; color: #444; font-size: 0.78rem; line-height: 1; margin: 4px 0; }
    .compose-note { font-size: 0.76rem; color: #777; margin-top: 14px; line-height: 1.5; }

    .approval-feature { display: flex; gap: 20px; align-items: flex-start; background: linear-gradient(180deg,#101019,#0c0c11); border: 1px solid #2a2a4a; border-radius: 10px; padding: 20px; margin-top: 4px; flex-wrap: wrap; }
    .approval-text { flex: 1; min-width: 220px; }
    .approval-text .ap-tool { font-family: "SF Mono","Fira Code",monospace; color: #a78bfa; font-size: 0.82rem; margin-bottom: 4px; }
    .approval-text .ap-desc { font-size: 0.82rem; color: #999; line-height: 1.55; margin-bottom: 14px; }
    .approval-text .ap-desc:last-child { margin-bottom: 0; }
    .phone-mockup { width: 210px; flex-shrink: 0; background: #16161e; border: 1px solid #2a2a3a; border-radius: 22px; padding: 16px 14px 18px; box-shadow: 0 12px 28px rgba(0,0,0,0.5); }
    .phone-bar { font-size: 0.62rem; color: #555; text-align: center; margin-bottom: 12px; letter-spacing: 0.04em; }
    .phone-title { font-size: 0.88rem; font-weight: 600; color: #fff; margin-bottom: 10px; }
    .phone-meta { font-size: 0.7rem; color: #888; line-height: 1.6; margin-bottom: 3px; }
    .phone-meta strong { color: #ccc; font-weight: 500; }
    .phone-expire { font-size: 0.68rem; color: #f59e0b; margin: 10px 0 14px; }
    .phone-btn { display: block; width: 100%; text-align: center; padding: 8px 0; border-radius: 8px; font-size: 0.78rem; font-weight: 500; margin-bottom: 6px; }
    .phone-btn.approve { background: #22c55e; color: #052e16; }
    .phone-btn.deny { background: transparent; border: 1px solid #444; color: #999; margin-bottom: 0; }

    .recipes { display: flex; flex-direction: column; gap: 12px; }
    .recipe { background: #0d0d0d; border: 1px solid #1a1a1a; border-radius: 8px; padding: 14px 16px; }
    .recipe-head { font-size: 0.82rem; color: #a78bfa; margin-bottom: 4px; font-weight: 500; font-family: "SF Mono","Fira Code",monospace; }
    .recipe-sub { font-size: 0.78rem; color: #888; margin-bottom: 12px; line-height: 1.5; }
    .recipe pre { margin: 0; font-size: 0.74rem; padding: 12px 14px; }

    .hero { display: grid; grid-template-columns: 1fr; gap: 28px; margin-bottom: 28px; align-items: stretch; }
    @media (min-width: 760px) { .hero { grid-template-columns: 1.05fr 1fr; gap: 36px; align-items: center; } }
    .hero-text { display: flex; flex-direction: column; }
    .hero-terminal { background: #0c0c0e; border: 1px solid #1d1d22; border-radius: 12px; padding: 16px 18px 18px; font-family: "SF Mono","Fira Code",monospace; font-size: 0.78rem; line-height: 1.6; box-shadow: 0 16px 40px rgba(0,0,0,0.45); overflow: hidden; }
    .ht-bar { display: flex; gap: 6px; margin-bottom: 14px; align-items: center; padding-bottom: 10px; border-bottom: 1px solid #16161a; }
    .ht-bar .ht-dot { width: 10px; height: 10px; border-radius: 50%; background: #2a2a2e; }
    .ht-bar .ht-host { margin-left: auto; font-size: 0.7rem; color: #555; }
    .ht-line { margin-bottom: 5px; word-break: break-all; }
    .ht-line.gap { margin-top: 10px; }
    .ht-prompt { color: #555; margin-right: 6px; }
    .ht-cmd { color: #c4b5fd; }
    .ht-arg { color: #888; }
    .ht-ok { color: #4ade80; }
    .ht-comment { color: #555; font-style: italic; }
    .ht-amt { color: #fbbf24; }

    .pack { background: #0f0f12; border: 1px solid #1f1f24; padding: 20px 22px; }
    .pack:hover { border-color: #4f46e5; transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0,0,0,0.3); }
    .pack-price { font-size: 1.5rem; }
    .tool { background: #0f0f12; border: 1px solid #1f1f24; padding: 16px 18px; transition: border-color 0.15s; }
    .tool:hover { border-color: #2a2a32; }
    .compose-col { background: #0c0c0e; border: 1px solid #1d1d22; }
    .recipe { background: #0c0c0e; border: 1px solid #1d1d22; }
    pre { background: #0a0a0c; border-color: #1a1a1f; }

    .section-label { display: inline-block; font-family: "SF Mono","Fira Code",monospace; font-size: 0.7rem; color: #777; background: #131318; border: 1px solid #22222a; border-radius: 4px; padding: 2px 8px; margin-left: 4px; letter-spacing: 0.03em; }
  </style>
</head>
<body>
  <div class="container">
    <header class="hero">
      <div class="hero-text">
        <h1>Gvnr</h1>
        <p class="tagline">Spend caps, rate coordination, and a human-in-the-loop gate for AI agents — enforced before the call, not after the invoice.</p>
        <p class="value-prop">One MCP endpoint, one credit pool, settled via x402 (USDC on Base). Compose <code style="font-family:monospace;color:#c4b5fd">budget_clear → rate_check → idempotency_check → call LLM → reconcile</code> before every provider request, or fall back to <code style="font-family:monospace;color:#c4b5fd">request_approval</code> when an agent needs a human.</p>
        <div class="header-row">
          <div class="status">
            <div class="dot"></div>
            <div class="status-text"><strong>Live</strong> &nbsp;·&nbsp; <span class="network-badge">x402 · ${network}</span></div>
          </div>
          <a class="cta-btn" href="#credit-packs">Top up with USDC →</a>
        </div>
      </div>
      <div class="hero-terminal" aria-hidden="true">
        <div class="ht-bar">
          <div class="ht-dot"></div><div class="ht-dot"></div><div class="ht-dot"></div>
          <div class="ht-host">agent@research-loop</div>
        </div>
        <div class="ht-line"><span class="ht-prompt">$</span><span class="ht-cmd">budget_clear</span> <span class="ht-arg">model=opus-4-8 tokens=2000</span></div>
        <div class="ht-line"><span class="ht-ok">✓ approved</span></div>
        <div class="ht-line" style="padding-left:1.4em"><span class="ht-amt">9,999 ops remaining</span></div>
        <div class="ht-line" style="padding-left:1.4em"><span class="ht-arg">spend envelope: $4.95 left</span></div>
        <div class="ht-line gap"><span class="ht-prompt">$</span><span class="ht-cmd">rate_check</span> <span class="ht-arg">provider=anthropic model=opus-4-8</span></div>
        <div class="ht-line"><span class="ht-ok">✓ allowed</span> <span class="ht-arg">· 4/30 RPM</span></div>
        <div class="ht-line gap"><span class="ht-prompt">$</span><span class="ht-comment"># → your LLM call (you pay your provider)</span></div>
        <div class="ht-line gap"><span class="ht-prompt">$</span><span class="ht-cmd">reconcile</span> <span class="ht-arg">actual_in=1800 actual_out=2400</span></div>
        <div class="ht-line"><span class="ht-ok">✓ trued up</span></div>
        <div class="ht-line" style="padding-left:1.4em"><span class="ht-amt">9,999 ops remaining</span></div>
        <div class="ht-line" style="padding-left:1.4em"><span class="ht-arg">spend envelope: $4.93 left</span></div>
      </div>
    </header>

    <nav class="docs-nav">
      <span class="nav-label">On this page</span>
      <a href="#credit-packs">Packs</a>
      <span class="nav-dot">·</span>
      <a href="#tools">Tools</a>
      <span class="nav-dot">·</span>
      <a href="#compose">Compose</a>
      <span class="nav-dot">·</span>
      <a href="#quickstart">Quick start</a>
      <span class="nav-dot">·</span>
      <a href="#pricing">Pricing</a>
      <span class="nav-dot" style="margin:0 6px">|</span>
      <span class="nav-label">Reference</span>
      <a href="/b2b">B2B</a>
      <span class="nav-dot">·</span>
      <a href="/openapi.json">OpenAPI</a>
      <span class="nav-dot">·</span>
      <a href="/.well-known/mcp.json">MCP card</a>
      <span class="nav-dot">·</span>
      <a href="https://github.com/mightbesaad/gvnr" target="_blank" rel="noopener">GitHub</a>
    </nav>

    <section id="credit-packs">
      <h2>Credit packs</h2>
      <div class="packs">
        <a class="pack" href="/pay/starter" data-base="/pay/starter">
          <div class="pack-name">starter</div>
          <div class="pack-price">$19</div>
          <div class="pack-detail">10k governance ops / month</div>
        </a>
        <a class="pack" href="/pay/growth" data-base="/pay/growth">
          <div class="pack-name">growth</div>
          <div class="pack-price">$39</div>
          <div class="pack-detail">30k governance ops / month</div>
        </a>
        <a class="pack" href="/pay/studio" data-base="/pay/studio">
          <div class="pack-name">studio</div>
          <div class="pack-price">$79</div>
          <div class="pack-detail">100k governance ops / month</div>
        </a>
      </div>
      <div class="key-row">
        <input class="key-input" id="api-key-input" type="text" placeholder="Paste your API key (bg_...)" autocomplete="off" spellcheck="false">
        <button class="btn-get-key" id="get-key-btn" onclick="getApiKey()">Get API key</button>
      </div>
      <p style="font-size:0.78rem;color:#777;margin-top:8px">Pay via x402 — USDC on Base mainnet. Works with Base MCP, AgentKit, and any x402 client. A pack buys governance operations (budget_clear, rate_check, idempotency_check…) — your LLM tokens are billed by your provider, not by gvnr. Credits added immediately after on-chain verification.</p>
    </section>

    <section id="tools">
      <h2>MCP Tools</h2>

      <h3 id="spend" style="font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#777;margin:18px 0 10px">Spend cap</h3>
      <div class="tools">
        <div class="tool">
          <div class="tool-name">budget_clear(agent_id, model, estimated_tokens)</div>
          <div class="tool-desc">Approve or deny a spend request. Deducts estimated cost from the agent's envelope.</div>
        </div>
        <div class="tool">
          <div class="tool-name">set_envelope(agent_id, limit_usd, window?)</div>
          <div class="tool-desc">Create or update an agent's daily or session spend cap.</div>
        </div>
        <div class="tool">
          <div class="tool-name">get_balance()</div>
          <div class="tool-desc">Return the remaining governance-operation quota (one budget_clear = one op).</div>
        </div>
      </div>

      <h3 id="rate-limits" style="font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#777;margin:18px 0 10px">Rate limits</h3>
      <div class="tools">
        <div class="tool">
          <div class="tool-name">set_rate_envelope(agent_id, provider, model, requests_per_minute)</div>
          <div class="tool-desc">Allocate a per-(agent, provider, model) rate share. Fixed 60-second windows.</div>
        </div>
        <div class="tool">
          <div class="tool-name">rate_check(agent_id, provider, model)</div>
          <div class="tool-desc">Approve or deny based on the agent's rate envelope. Returns retry_after_ms on denial.</div>
        </div>
      </div>

      <h3 id="reconcile" style="font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#777;margin:18px 0 10px">Reconciler</h3>
      <div class="tools">
        <div class="tool">
          <div class="tool-name">reconcile(agent_id, actual_input_tokens, actual_output_tokens)</div>
          <div class="tool-desc">After the LLM responds, apply the drift between estimated and actual cost. Keeps the envelope honest.</div>
        </div>
      </div>

      <h3 id="idempotency" style="font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#777;margin:18px 0 10px">Idempotency</h3>
      <div class="tools">
        <div class="tool">
          <div class="tool-name">idempotency_check(key, ttl_seconds?)</div>
          <div class="tool-desc">Dedupe retries on a caller-supplied key. Returns is_first_call=true the first time, false on replays within TTL.</div>
        </div>
      </div>

      <h3 id="approvals" style="font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#777;margin:18px 0 10px">Approval bridge <span style="font-size:0.65rem;color:#a78bfa;background:#1a1a2e;border:1px solid #2a2a4a;padding:1px 6px;border-radius:4px;margin-left:4px;letter-spacing:0.04em">NEW</span></h3>
      <div class="approval-feature">
        <div class="approval-text">
          <div class="ap-tool">request_approval(agent_id, action_summary, ttl_seconds?, channels?)</div>
          <div class="ap-desc">Pause for a human in the loop. Returns <code style="font-family:monospace;color:#a78bfa">approval_id</code> + a mobile-friendly URL the human taps to approve or deny. Email today; Telegram + SMS forward-compat.</div>
          <div class="ap-tool">check_approval(approval_id)</div>
          <div class="ap-desc">Poll the decision: pending / approved / denied / timeout. Compose with budget_clear — denial → request_approval → resume.</div>
        </div>
        <div class="phone-mockup" aria-hidden="true">
          <div class="phone-bar">gvnr.dev/approve</div>
          <div class="phone-title">Approve agent action?</div>
          <div class="phone-meta"><strong>Agent</strong> · research-loop</div>
          <div class="phone-meta"><strong>Action</strong> · Spend $42 on Opus extraction over 30 docs</div>
          <div class="phone-expire">Expires in 4:23</div>
          <div class="phone-btn approve">Approve</div>
          <div class="phone-btn deny">Deny</div>
        </div>
      </div>
    </section>

    <section id="compose">
      <h2>How it composes</h2>
      <div class="compose">
        <div class="compose-col">
          <div class="compose-col-head">Setup · once per agent</div>
          <div class="compose-step">set_envelope</div>
          <div class="compose-arrow">↓</div>
          <div class="compose-step">set_rate_envelope</div>
        </div>
        <div class="compose-col">
          <div class="compose-col-head">Runtime · every LLM call</div>
          <div class="compose-step">budget_clear</div>
          <div class="compose-arrow">↓</div>
          <div class="compose-step">rate_check</div>
          <div class="compose-arrow">↓</div>
          <div class="compose-step">idempotency_check</div>
          <div class="compose-arrow">↓</div>
          <div class="compose-step muted">your LLM call</div>
          <div class="compose-arrow">↓</div>
          <div class="compose-step">reconcile</div>
        </div>
        <div class="compose-col">
          <div class="compose-col-head">Branch · on denial</div>
          <div class="compose-step">request_approval</div>
          <div class="compose-arrow">↓</div>
          <div class="compose-step muted">human taps approve</div>
          <div class="compose-arrow">↓</div>
          <div class="compose-step">check_approval</div>
          <div class="compose-arrow">↓</div>
          <div class="compose-step muted">resume the call</div>
        </div>
      </div>
      <p class="compose-note">One credit pool draws across all calls. Same auth, same endpoint, no extra infra. Any tool can be added or removed without re-integrating.</p>
    </section>

    <section id="quickstart">
      <h2>Quick start</h2>
      <p style="font-size:0.82rem;color:#888;margin-bottom:14px">Pick a recipe. Each one is independent — you can layer them as your agent grows.</p>

      <div class="recipes">
        <div class="recipe">
          <div class="recipe-head">Recipe 1 · Provision + top up</div>
          <div class="recipe-sub">Get an API key and add credits. Required once per account.</div>
          <pre>curl -X POST https://gvnr.dev/v1/account
# → { "api_key": "bg_...", "account_id": "..." }</pre>
          <p style="font-size:0.78rem;color:#888;margin:10px 0 6px">Then open the pay page in your browser (replace the key):</p>
          <div style="display:flex;gap:8px;align-items:center">
            <div style="font-family:'SF Mono','Fira Code',monospace;font-size:0.76rem;color:#ccc;background:#111;border:1px solid #1f1f1f;border-radius:6px;padding:9px 12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="qs-url">https://gvnr.dev/pay/starter?api_key=bg_YOUR_KEY</div>
            <button onclick="(function(b){navigator.clipboard.writeText(document.getElementById('qs-url').textContent).then(()=>{var t=b.textContent;b.textContent='Copied!';setTimeout(()=>b.textContent=t,1500)})})(this)" style="border:none;border-radius:6px;padding:8px 12px;font-size:0.78rem;font-weight:500;cursor:pointer;background:#1a1a2e;color:#a78bfa;border:1px solid #2a2a4a;white-space:nowrap">Copy</button>
          </div>
        </div>

        <div class="recipe">
          <div class="recipe-head">Recipe 2 · Spend cap</div>
          <div class="recipe-sub">Set a daily ceiling per agent, clear before each call, reconcile after. The core loop.</div>
          <pre># Set the envelope (once)
curl -X PUT https://gvnr.dev/v1/budget/envelope \\
  -H "Authorization: Bearer bg_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"my-agent","limit_usd":5,"window":"daily"}'

# Before each LLM call
curl -X POST https://gvnr.dev/v1/budget/clear \\
  -H "Authorization: Bearer bg_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"my-agent","model":"claude-sonnet-4-6","estimated_tokens":2000}'

# After the LLM responds
curl -X POST https://gvnr.dev/v1/budget/reconcile \\
  -H "Authorization: Bearer bg_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"my-agent","actual_input_tokens":1800,"actual_output_tokens":2400}'</pre>
        </div>

        <div class="recipe">
          <div class="recipe-head">Recipe 3 · Rate limits</div>
          <div class="recipe-sub">Coordinate RPM across multiple agents sharing the same provider quota.</div>
          <pre># Set the rate envelope (once)
curl -X PUT https://gvnr.dev/v1/rate/envelope \\
  -H "Authorization: Bearer bg_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"my-agent","provider":"anthropic","model":"claude-sonnet-4-6","requests_per_minute":30}'

# Before each LLM call
curl -X POST https://gvnr.dev/v1/rate/check \\
  -H "Authorization: Bearer bg_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"my-agent","provider":"anthropic","model":"claude-sonnet-4-6"}'</pre>
        </div>

        <div class="recipe">
          <div class="recipe-head">Recipe 4 · Idempotency</div>
          <div class="recipe-sub">Dedupe retries on a caller-supplied key. <code style="font-family:monospace;color:#a78bfa">is_first_call=true</code> the first time, <code style="font-family:monospace;color:#a78bfa">false</code> on replays.</div>
          <pre>curl -X POST https://gvnr.dev/v1/idempotency/check \\
  -H "Authorization: Bearer bg_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"key":"job-abc-123","ttl_seconds":3600}'</pre>
        </div>

        <div class="recipe">
          <div class="recipe-head">Recipe 5 · Human-in-the-loop</div>
          <div class="recipe-sub">When budget_clear denies (or for any sensitive action), hand off to a human via a mobile-friendly approval URL.</div>
          <pre># Set your notification email (once)
curl -X POST https://gvnr.dev/v1/account/notification-email \\
  -H "Authorization: Bearer bg_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"you@example.com"}'

# Request approval (returns approval_url)
curl -X POST https://gvnr.dev/v1/approval/request \\
  -H "Authorization: Bearer bg_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"my-agent","action_summary":"Spend $42 on Opus extraction over 30 docs","ttl_seconds":600}'

# Poll for the decision
curl https://gvnr.dev/v1/approval/check/APPROVAL_ID \\
  -H "Authorization: Bearer bg_YOUR_KEY"
# → { "decision": "pending" | "approved" | "denied" | "timeout", ... }</pre>
        </div>
      </div>
    </section>

    <section id="pricing">
      <h2>Model pricing</h2>
      <pre>${renderPriceTable()}</pre>
      <p style="font-size:0.8rem;color:#888;margin-top:10px">These are <strong>provider</strong> list rates — they set your per-agent spend <strong>cap</strong> (the envelope), not gvnr's charge. gvnr bills a flat governance fee per operation (see the packs above); your LLM tokens are billed by your provider directly. budget_clear estimates the cap debit (output tokens for chat models, input tokens for embedding/input-only models); reconcile trues it to actual. Unlisted models fall back to the highest rate (fail-safe). Updated May 2026.</p>
    </section>

    <footer>
      <div class="footer-row">
        <span>USDC receiver: <span class="footer-mono">${c.env.PAYTO_ADDRESS}</span></span>
        <span>·</span>
        <span>Network: Base mainnet (eip155:8453)</span>
        <span>·</span>
        <span>Open source (MIT) · 100/100 tests passing</span>
        <span>·</span>
        <a href="https://github.com/mightbesaad/gvnr" target="_blank" rel="noopener">GitHub</a>
        <span>·</span>
        <a href="/tos">Terms &amp; Privacy</a>
        <span>·</span>
        <a href="mailto:admin@gvnr.dev">admin@gvnr.dev</a>
        <span>·</span>
        <a href="https://github.com/mightbesaad/gvnr/issues" target="_blank" rel="noopener">Support</a>
      </div>
    </footer>
  </div>

<div class="modal-overlay" id="key-modal" onclick="if(event.target===this)closeKeyModal()">
  <div class="modal-box">
    <div class="modal-title">Your API key</div>
    <div class="modal-warning">⚠ Save this key now — it will not be shown again. There is no account recovery. If you lose it, your credits are permanently lost.</div>
    <div class="modal-key-row">
      <div class="modal-key" id="new-key-display"></div>
      <button class="btn-get-key" id="copy-key-btn" onclick="copyNewKey()">Copy</button>
    </div>
    <button class="modal-done-btn" onclick="closeKeyModal()">I've saved my key — start topping up</button>
  </div>
</div>

<script>
(function () {
  var input = document.getElementById('api-key-input');
  var packs = document.querySelectorAll('.pack[data-base]');
  var qsUrl = document.getElementById('qs-url');
  input.addEventListener('input', function () {
    var key = this.value.trim();
    packs.forEach(function (p) {
      var base = p.getAttribute('data-base');
      p.href = key ? base + '?api_key=' + encodeURIComponent(key) : base;
    });
    if (qsUrl) {
      qsUrl.textContent = key
        ? 'https://gvnr.dev/pay/starter?api_key=' + encodeURIComponent(key)
        : 'https://gvnr.dev/pay/starter?api_key=bg_YOUR_KEY';
    }
  });
})();

async function getApiKey() {
  var btn = document.getElementById('get-key-btn');
  btn.textContent = 'Getting...';
  btn.disabled = true;
  try {
    var res = await fetch('/v1/account', { method: 'POST' });
    var data = await res.json();
    if (!res.ok) {
      btn.textContent = 'Get API key';
      btn.disabled = false;
      alert(data.error === 'rate_limited' ? 'Rate limited. Try again in an hour.' : 'Error: ' + data.error);
      return;
    }
    document.getElementById('new-key-display').textContent = data.api_key;
    document.getElementById('key-modal').style.display = 'flex';
    btn.textContent = 'Get API key';
    btn.disabled = false;
  } catch (e) {
    btn.textContent = 'Get API key';
    btn.disabled = false;
    alert('Network error. Try again.');
  }
}

function copyNewKey() {
  var key = document.getElementById('new-key-display').textContent;
  navigator.clipboard.writeText(key).then(function () {
    var btn = document.getElementById('copy-key-btn');
    var orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(function () { btn.textContent = orig; }, 1500);
  });
}

function closeKeyModal() {
  var key = document.getElementById('new-key-display').textContent;
  document.getElementById('key-modal').style.display = 'none';
  var input = document.getElementById('api-key-input');
  input.value = key;
  input.dispatchEvent(new Event('input'));
  document.getElementById('credit-packs').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
</script>
</body>
</html>`;
  return c.html(html);
});

// Admin: seed credits for beta users — requires X-Admin-Secret header
app.post('/v1/admin/seed', async (c) => {
  const secret = c.req.header('X-Admin-Secret');
  if (!secret || secret !== c.env.ADMIN_SECRET) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const body = await c.req.json<{ api_key: string; amount_usd: number }>();
  if (!body.api_key || typeof body.amount_usd !== 'number' || !Number.isFinite(body.amount_usd) || body.amount_usd <= 0) {
    return c.json({ error: 'invalid_params', required: ['api_key', 'amount_usd'] }, 400);
  }

  const account = await getAccount(c.env.BUDGET_KV, body.api_key);
  if (!account) {
    return c.json({ error: 'account_not_found' }, 404);
  }

  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(account.account_id));
  const result = await stub.credit(body.amount_usd);

  return c.json({ ok: true, api_key: body.api_key, credited_ops: Math.floor(body.amount_usd), operations_remaining: result.operations_remaining });
});

// Human payment routes — mounted before x402 middleware to avoid interception.
// /v1/packs/:pack/info, /v1/account/topup-verify/:pack, /pay/:pack
app.route('/', payRoutes);
app.route('/tos', tosRoutes);
app.route('/b2b', b2bRoutes);

// x402 payment gate — must run before account routes so topup/:pack sees payment verification.
// Initialized lazily on first request so PAYTO_ADDRESS is available from env.
app.use('/v1/account/topup/*', async (c, next) => {
  const middleware = buildX402Middleware(
    c.env.PAYTO_ADDRESS,
    c.env.X402_NETWORK,
    c.env.CDP_API_KEY_ID,
    c.env.CDP_API_KEY_SECRET,
  );
  return middleware(c, next);
});

app.route('/v1/account', accountRoutes);
app.route('/v1/budget/envelope', envelopeRoutes);
app.route('/v1/budget', budgetRoutes);
app.route('/v1/rate', rateRoutes);
app.route('/v1/idempotency', idempotencyRoutes);
app.route('/v1/approval', approvalRoutes);
app.route('/approve', approveRoutes);

// MCP server — Streamable HTTP transport, stateless, all verbs
app.all('/mcp', mcpHandler);

app.notFound((c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Not Found — Gvnr</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#e5e5e5;padding:48px 24px;min-height:100vh}
    .container{max-width:520px;margin:0 auto}
    h1{font-size:1.4rem;font-weight:600;letter-spacing:-0.02em;margin-bottom:6px}
    p{color:#888;font-size:0.9rem;margin-bottom:24px;margin-top:6px}
    a{color:#a78bfa;text-decoration:none;font-size:0.9rem}
    a:hover{text-decoration:underline}
  </style>
</head>
<body>
<div class="container">
  <h1>404 — Not Found</h1>
  <p>This page doesn't exist.</p>
  <a href="/">← Back to homepage</a>
</div>
</body>
</html>`, 404);
});

export default app;
