import { Hono } from 'hono';
import type { Env } from './lib/types';
import { buildX402Middleware } from './lib/x402';
import { mcpHandler } from './routes/mcp';
import accountRoutes from './routes/account';
import envelopeRoutes from './routes/envelope';
import budgetRoutes from './routes/budget';

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof SyntaxError) {
    return c.json({ error: 'invalid_json' }, 400);
  }
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
});

app.get('/health', (c) => c.json({ ok: true }));

app.get('/', (c) => {
  const network = c.env.X402_NETWORK === 'eip155:8453' ? 'Base mainnet' : 'Base Sepolia (testnet)';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Budget Governor</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 48px 24px; min-height: 100vh; }
    .container { max-width: 640px; margin: 0 auto; }
    h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 6px; }
    .tagline { color: #888; font-size: 0.95rem; margin-bottom: 40px; }
    .status { display: flex; align-items: center; gap: 10px; margin-bottom: 40px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; flex-shrink: 0; }
    .status-text { font-size: 0.9rem; color: #aaa; }
    .status-text strong { color: #e5e5e5; }
    section { margin-bottom: 36px; }
    h2 { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #555; margin-bottom: 14px; }
    .tools { display: flex; flex-direction: column; gap: 10px; }
    .tool { background: #111; border: 1px solid #1f1f1f; border-radius: 8px; padding: 14px 16px; }
    .tool-name { font-family: "SF Mono", "Fira Code", monospace; font-size: 0.85rem; color: #a78bfa; margin-bottom: 4px; }
    .tool-desc { font-size: 0.85rem; color: #888; }
    pre { background: #111; border: 1px solid #1f1f1f; border-radius: 8px; padding: 16px; font-family: "SF Mono", "Fira Code", monospace; font-size: 0.8rem; color: #ccc; overflow-x: auto; line-height: 1.6; }
    .network-badge { display: inline-block; padding: 3px 10px; border-radius: 4px; font-size: 0.78rem; font-family: monospace; background: #1a1a2e; color: #818cf8; border: 1px solid #2a2a4a; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Budget Governor</h1>
    <p class="tagline">Hard spend cap for autonomous AI agents — one call, before the LLM request.</p>

    <div class="status">
      <div class="dot"></div>
      <div class="status-text"><strong>Live</strong> &nbsp;·&nbsp; <span class="network-badge">${network}</span></div>
    </div>

    <section>
      <h2>MCP Tools</h2>
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
          <div class="tool-desc">Return the current account credit balance in USD.</div>
        </div>
      </div>
    </section>

    <section>
      <h2>Quick start</h2>
      <pre># 1. Provision an account
curl -X POST https://budget-governor.billowing-glade-3692.workers.dev/v1/account

# 2. Set an envelope for your agent
curl -X PUT \\
  -H "Authorization: Bearer bg_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"my-agent","limit_usd":5,"window":"daily"}' \\
  https://budget-governor.billowing-glade-3692.workers.dev/v1/budget/envelope

# 3. Call before each LLM request
curl -X POST \\
  -H "Authorization: Bearer bg_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"my-agent","model":"claude-sonnet-4-6","estimated_tokens":2000}' \\
  https://budget-governor.billowing-glade-3692.workers.dev/v1/budget/clear</pre>
    </section>

    <section>
      <h2>Credit packs</h2>
      <pre>starter  $19 / month   ~10k clearances
growth   $39 / month   ~30k clearances
studio   $79 / month   ~100k clearances</pre>
    </section>
  </div>
</body>
</html>`;
  return c.html(html);
});

// x402 payment gate — must run before account routes so topup/:pack sees payment verification.
// Initialized lazily on first request so PAYTO_ADDRESS is available from env.
app.use('/v1/account/topup/*', async (c, next) => {
  const middleware = buildX402Middleware(c.env.PAYTO_ADDRESS, c.env.X402_NETWORK);
  return middleware(c, next);
});

app.route('/v1/account', accountRoutes);
app.route('/v1/budget/envelope', envelopeRoutes);
app.route('/v1/budget', budgetRoutes);

// MCP server — Streamable HTTP transport, stateless, all verbs
app.all('/mcp', mcpHandler);

export default app;
