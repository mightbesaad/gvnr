#!/usr/bin/env node
/**
 * Post-deploy smoke test — verifies the golden path against a live environment.
 *
 * Usage:
 *   node scripts/smoke-test.mjs
 *   BASE_URL=https://gvnr.dev SMOKE_ADMIN_SECRET=<secret> node scripts/smoke-test.mjs
 *
 * Without SMOKE_ADMIN_SECRET: verifies routing and auth only (no credits needed).
 * With SMOKE_ADMIN_SECRET: also exercises the full clearance path end-to-end.
 */

const BASE = (process.env.BASE_URL ?? 'https://gvnr.dev').replace(/\/$/, '');
const ADMIN_SECRET = process.env.SMOKE_ADMIN_SECRET;
const MCP_HEADERS = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${label}: ${err.message}`);
    failed++;
  }
}

async function mcpCall(apiKey, method, params = {}) {
  const res = await fetch(`${BASE}/mcp?api_key=${apiKey}`, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

async function mcpTool(apiKey, name, args = {}) {
  const body = await mcpCall(apiKey, 'tools/call', { name, arguments: args });
  assert(body.result, `MCP tool ${name} error: ${JSON.stringify(body.error)}`);
  return JSON.parse(body.result.content[0].text);
}

// ── Basic routing ─────────────────────────────────────────────────────────────

console.log('\nBasic routing');

let apiKey;

await check('GET /health → ok', async () => {
  const res = await fetch(`${BASE}/health`);
  assert(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  assert(body.ok === true, `body: ${JSON.stringify(body)}`);
});

await check('POST /v1/account → bg_ prefixed key', async () => {
  const res = await fetch(`${BASE}/v1/account`, { method: 'POST' });
  assert(res.status === 201, `status ${res.status}`);
  const body = await res.json();
  assert(body.api_key?.startsWith('bg_'), `api_key: ${body.api_key}`);
  assert(body.account_id, 'missing account_id');
  apiKey = body.api_key;
});

await check('GET /v1/account/balance → 0', async () => {
  const res = await fetch(`${BASE}/v1/account/balance`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  assert(body.balance_usd === 0, `balance: ${body.balance_usd}`);
});

await check('POST /v1/budget/clear (no credits) → no_credits', async () => {
  const res = await fetch(`${BASE}/v1/budget/clear`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: 'smoke', model: 'claude-haiku-4-5-20251001', estimated_tokens: 100 }),
  });
  assert(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  assert(body.approved === false && body.reason === 'no_credits', JSON.stringify(body));
});

// ── MCP routing ───────────────────────────────────────────────────────────────

console.log('\nMCP routing');

await check('POST /mcp tools/call (no key) → 401', async () => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_balance', arguments: {} },
    }),
  });
  assert(res.status === 401, `status ${res.status}`);
});

await check('POST /mcp tools/list (no key) → enumerates for indexers', async () => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  const names = body.result?.tools?.map(t => t.name) ?? [];
  assert(names.includes('budget_clear'), `tools: ${JSON.stringify(names)}`);
});

await check('POST /mcp tools/list → three tools', async () => {
  const body = await mcpCall(apiKey, 'tools/list', {});
  const names = body.result?.tools?.map(t => t.name) ?? [];
  assert(names.includes('budget_clear'), `tools: ${JSON.stringify(names)}`);
  assert(names.includes('set_envelope'), `tools: ${JSON.stringify(names)}`);
  assert(names.includes('get_balance'), `tools: ${JSON.stringify(names)}`);
});

await check('MCP budget_clear (no credits) → no_credits', async () => {
  const result = await mcpTool(apiKey, 'budget_clear', {
    agent_id: 'smoke',
    model: 'claude-haiku-4-5-20251001',
    estimated_tokens: 100,
  });
  assert(result.approved === false && result.reason === 'no_credits', JSON.stringify(result));
});

await check('MCP get_balance → 0', async () => {
  const result = await mcpTool(apiKey, 'get_balance', {});
  assert(result.balance_usd === 0, `balance: ${result.balance_usd}`);
});

// ── Full golden path (requires SMOKE_ADMIN_SECRET) ────────────────────────────

if (ADMIN_SECRET) {
  console.log('\nFull golden path (admin)');

  await check('Seed $1 via admin', async () => {
    const res = await fetch(`${BASE}/v1/admin/seed`, {
      method: 'POST',
      headers: { 'X-Admin-Secret': ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, amount_usd: 1 }),
    });
    assert(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    assert(body.balance_usd === 1, `balance after seed: ${body.balance_usd}`);
  });

  await check('REST set_envelope + REST budget_clear → approved', async () => {
    await fetch(`${BASE}/v1/budget/envelope`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'smoke-rest', limit_usd: 0.5 }),
    });
    const res = await fetch(`${BASE}/v1/budget/clear`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'smoke-rest', model: 'claude-haiku-4-5-20251001', estimated_tokens: 100 }),
    });
    const body = await res.json();
    assert(body.approved === true, JSON.stringify(body));
  });

  await check('MCP set_envelope + MCP budget_clear → approved', async () => {
    await mcpTool(apiKey, 'set_envelope', { agent_id: 'smoke-mcp', limit_usd: 0.5, window: 'daily' });
    const result = await mcpTool(apiKey, 'budget_clear', {
      agent_id: 'smoke-mcp',
      model: 'claude-haiku-4-5-20251001',
      estimated_tokens: 100,
    });
    assert(result.approved === true, JSON.stringify(result));
  });

  await check('MCP get_balance reflects deductions', async () => {
    const result = await mcpTool(apiKey, 'get_balance', {});
    assert(result.balance_usd > 0 && result.balance_usd < 1, `balance: ${result.balance_usd}`);
  });
} else {
  console.log('\n  (skipping full golden path — set SMOKE_ADMIN_SECRET to enable)');
}

// ── Result ────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
