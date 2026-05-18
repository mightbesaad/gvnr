import { Hono } from 'hono';
import type { Env } from './lib/types';
import { buildX402Middleware } from './lib/x402';
import { mcpHandler } from './routes/mcp';
import accountRoutes from './routes/account';
import envelopeRoutes from './routes/envelope';
import budgetRoutes from './routes/budget';
import payRoutes from './routes/pay';
import tosRoutes from './routes/tos';
import { getAccount } from './lib/kv';
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
        description: 'Check if an agent is authorized to spend tokens and deduct the estimated cost from its envelope.',
        url: 'https://gvnr.dev/mcp',
        sha256: '7109eb205933377306b30da55acd5899319ffddc79bf4bdf13100ad85cd2f87a',
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
        description: 'Get the current credit balance in USD for this account.',
        url: 'https://gvnr.dev/mcp',
        sha256: '5f0e5e27eb2d2e1dd303892eb46edea7e6987524284e5f646e739300e9bc355f',
      },
    ],
  });
});

app.get('/sitemap.xml', (c) => {
  c.header('Content-Type', 'application/xml');
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://gvnr.dev/</loc></url>
  <url><loc>https://gvnr.dev/tos</loc></url>
  <url><loc>https://gvnr.dev/pay/starter</loc></url>
  <url><loc>https://gvnr.dev/pay/growth</loc></url>
  <url><loc>https://gvnr.dev/pay/studio</loc></url>
</urlset>`);
});

app.get('/.well-known/mcp.json', (c) => {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json({
    name: 'Budget Governor',
    description: 'Hard spend cap for autonomous AI agents. Check clearance and track spend before each LLM call.',
    version: '1.0.0',
    url: 'https://gvnr.dev/mcp',
    transport: ['streamable-http'],
    authentication: {
      type: 'bearer',
      description: 'API key obtained from POST https://gvnr.dev/v1/account',
    },
    tools: [
      { name: 'budget_clear', description: 'Check if an agent is authorized to spend tokens and deduct the estimated cost' },
      { name: 'set_envelope', description: 'Create or update a spend envelope for an agent' },
      { name: 'get_balance', description: 'Get current account credit balance in USD' },
    ],
  });
});

app.get('/openapi.json', (c) => {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json({
    openapi: '3.1.0',
    info: { title: 'Budget Governor', version: '1.0.0', description: 'Hard spend cap for autonomous AI agents.' },
    servers: [{ url: 'https://gvnr.dev' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key from POST /v1/account' },
      },
    },
    paths: {
      '/v1/account': {
        post: {
          summary: 'Provision account',
          responses: { '200': { description: 'Returns api_key and account_id' } },
        },
      },
      '/v1/account/balance': {
        get: {
          summary: 'Get credit balance',
          security: [{ bearerAuth: [] }],
          responses: { '200': { description: 'Returns balance_usd' } },
        },
      },
      '/v1/account/topup-verify/{pack}': {
        post: {
          summary: 'Verify on-chain USDC payment and credit account',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'pack', in: 'path', required: true, schema: { type: 'string', enum: ['starter', 'growth', 'studio'] } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { tx_hash: { type: 'string' } }, required: ['tx_hash'] } } } },
          responses: { '200': { description: 'Credits added, returns balance_usd' } },
        },
      },
      '/v1/budget/clear': {
        post: {
          summary: 'Clearance call — approve or deny agent spend',
          security: [{ bearerAuth: [] }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { agent_id: { type: 'string' }, model: { type: 'string' }, estimated_tokens: { type: 'integer' } }, required: ['agent_id', 'model', 'estimated_tokens'] } } } },
          responses: { '200': { description: 'Returns approved (bool), remaining_usd, optional reason' } },
        },
      },
      '/v1/budget/envelope': {
        put: {
          summary: 'Create or update agent spend envelope',
          security: [{ bearerAuth: [] }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { agent_id: { type: 'string' }, limit_usd: { type: 'number' }, window: { type: 'string', enum: ['daily', 'session'] } }, required: ['agent_id', 'limit_usd'] } } } },
          responses: { '200': { description: 'Envelope created or updated' } },
        },
      },
      '/v1/budget/envelope/{agent_id}': {
        get: {
          summary: 'Read envelope state',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'agent_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Returns envelope record' } },
        },
      },
      '/v1/packs/{pack}/info': {
        get: {
          summary: 'Get pack details and payment info',
          parameters: [{ name: 'pack', in: 'path', required: true, schema: { type: 'string', enum: ['starter', 'growth', 'studio'] } }],
          responses: { '200': { description: 'Returns amount, USDC address, raw amount' } },
        },
      },
      '/mcp': {
        post: {
          summary: 'MCP server endpoint (Streamable HTTP)',
          security: [{ bearerAuth: [] }],
          description: 'Pass api_key as query param or Authorization: Bearer header',
          responses: { '200': { description: 'MCP JSON-RPC response' } },
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
  <title>Budget Governor — AI agent spend caps</title>
  <meta name="description" content="Hard spend cap for autonomous AI agents. One MCP call before each LLM request stops runaway billing before it starts.">
  <meta property="og:title" content="Budget Governor">
  <meta property="og:description" content="Hard spend cap for autonomous AI agents. One MCP call before each LLM request — stops runaway billing before it starts.">
  <meta property="og:url" content="https://gvnr.dev">
  <meta property="og:type" content="website">
  <meta name="robots" content="index, follow">
  <link rel="describedby" href="/openapi.json">
  <link rel="mcp" href="/.well-known/mcp.json">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 48px 24px; min-height: 100vh; }
    .container { max-width: 640px; margin: 0 auto; }
    h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 6px; }
    .tagline { color: #888; font-size: 0.95rem; margin-bottom: 6px; }
    .value-prop { color: #aaa; font-size: 0.85rem; margin-bottom: 24px; }
    .header-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 36px; flex-wrap: wrap; }
    .status { display: flex; align-items: center; gap: 10px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; flex-shrink: 0; }
    .status-text { font-size: 0.9rem; color: #aaa; }
    .status-text strong { color: #e5e5e5; }
    .cta-btn { display: inline-block; background: #4f46e5; color: #fff; text-decoration: none; padding: 8px 18px; border-radius: 6px; font-size: 0.85rem; font-weight: 500; white-space: nowrap; transition: opacity 0.15s; }
    .cta-btn:hover { opacity: 0.85; }
    section { margin-bottom: 36px; }
    h2 { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #555; margin-bottom: 14px; }
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
  </style>
</head>
<body>
  <div class="container">
    <h1>Budget Governor</h1>
    <p class="tagline">Hard spend cap for autonomous AI agents — one call, before the LLM request.</p>
    <p class="value-prop">Stop runaway billing before it starts. Set a $5/day cap per agent, get approved or denied in one MCP call.</p>

    <div class="header-row">
      <div class="status">
        <div class="dot"></div>
        <div class="status-text"><strong>Live</strong> &nbsp;·&nbsp; <span class="network-badge">${network}</span></div>
      </div>
      <a class="cta-btn" href="#pricing">Top up credits →</a>
    </div>

    <section id="pricing">
      <h2>Credit packs</h2>
      <div class="packs">
        <a class="pack" href="/pay/starter" data-base="/pay/starter">
          <div class="pack-name">starter</div>
          <div class="pack-price">$19</div>
          <div class="pack-detail">~10k budget_clear calls / month</div>
        </a>
        <a class="pack" href="/pay/growth" data-base="/pay/growth">
          <div class="pack-name">growth</div>
          <div class="pack-price">$39</div>
          <div class="pack-detail">~30k budget_clear calls / month</div>
        </a>
        <a class="pack" href="/pay/studio" data-base="/pay/studio">
          <div class="pack-name">studio</div>
          <div class="pack-price">$79</div>
          <div class="pack-detail">~100k budget_clear calls / month</div>
        </a>
      </div>
      <div class="key-row">
        <input class="key-input" id="api-key-input" type="text" placeholder="Paste your API key (bg_...)" autocomplete="off" spellcheck="false">
        <button class="btn-get-key" id="get-key-btn" onclick="getApiKey()">Get API key</button>
      </div>
      <p style="font-size:0.78rem;color:#777;margin-top:8px">Pay with USDC on Base mainnet. Credits added immediately after on-chain verification.</p>
    </section>

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
curl -X POST https://gvnr.dev/v1/account
# → { "api_key": "bg_...", "account_id": "..." }</pre>

      <p style="font-size:0.8rem;color:#888;margin:10px 0 6px"># 2. Top up credits — open in your browser</p>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px">
        <div style="font-family:'SF Mono','Fira Code',monospace;font-size:0.78rem;color:#ccc;background:#111;border:1px solid #1f1f1f;border-radius:8px;padding:10px 12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="qs-url">https://gvnr.dev/pay/starter?api_key=bg_YOUR_KEY</div>
        <button onclick="(function(b){navigator.clipboard.writeText(document.getElementById('qs-url').textContent).then(()=>{var t=b.textContent;b.textContent='Copied!';setTimeout(()=>b.textContent=t,1500)})})(this)" style="border:none;border-radius:6px;padding:9px 14px;font-size:0.82rem;font-weight:500;cursor:pointer;background:#1a1a2e;color:#a78bfa;border:1px solid #2a2a4a;white-space:nowrap">Copy</button>
      </div>

      <pre># 3. Set an envelope for your agent
curl -X PUT \\
  -H "Authorization: Bearer bg_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"my-agent","limit_usd":5,"window":"daily"}' \\
  https://gvnr.dev/v1/budget/envelope

# 4. Call before each LLM request
curl -X POST \\
  -H "Authorization: Bearer bg_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"my-agent","model":"claude-sonnet-4-6","estimated_tokens":2000}' \\
  https://gvnr.dev/v1/budget/clear</pre>
    </section>

    <section>
      <h2>Model pricing</h2>
      <pre>claude-opus-4-7      $15.00 / $75.00  per M tokens (in / out)
claude-sonnet-4-6     $3.00 / $15.00
claude-haiku-4-5      $0.80 /  $4.00
gpt-4o                $2.50 / $10.00
gpt-4o-mini           $0.15 /  $0.60
gemini-1-5-pro        $1.25 /  $3.50</pre>
      <p style="font-size:0.8rem;color:#888;margin-top:10px">budget_clear deducts estimated output cost. Unused tokens are not charged. Unlisted models default to $15.00/M output tokens. Updated May 2026.</p>
    </section>

    <footer>
      <div class="footer-row">
        <span>USDC receiver: <span class="footer-mono">0xBcF326ff22CDEc10Ca4F8AE9415Bb6884a0c26D3</span></span>
        <span>·</span>
        <span>Network: Base mainnet (eip155:8453)</span>
        <span>·</span>
        <a href="https://github.com/mightbesaad/gvnr" target="_blank" rel="noopener">GitHub</a>
        <span>·</span>
        <a href="/tos">Terms</a>
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
  document.getElementById('pricing').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  return c.json({ ok: true, api_key: body.api_key, credited: body.amount_usd, balance_usd: result.balance_usd });
});

// Human payment routes — mounted before x402 middleware to avoid interception.
// /v1/packs/:pack/info, /v1/account/topup-verify/:pack, /pay/:pack
app.route('/', payRoutes);
app.route('/tos', tosRoutes);

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

app.notFound((c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Not Found — Budget Governor</title>
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
