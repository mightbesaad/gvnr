import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';

// ── RPC mock helpers ─────────────────────────────────────────────────────────

const PAYTO = '0xBcF326ff22CDEc10Ca4F8AE9415Bb6884a0c26D3';
const USDC_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function makeReceipt(toAddress: string, rawAmount: bigint, status = '0x1') {
  return {
    status,
    logs: [{
      address: USDC_SEPOLIA.toLowerCase(),
      topics: [
        TRANSFER_TOPIC,
        '0x' + 'dead'.padStart(64, '0'), // from — not checked
        '0x000000000000000000000000' + toAddress.slice(2).toLowerCase(),
      ],
      data: '0x' + rawAmount.toString(16).padStart(64, '0'),
    }],
  };
}

function stubRpc(receipt: object | null) {
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes('.base.org')) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', result: receipt, id: 1 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return real(input, init);
  });
}

async function provisionAccount(): Promise<{ apiKey: string; accountId: string }> {
  const res = await SELF.fetch('http://localhost/v1/account', { method: 'POST' });
  const body = await res.json<{ api_key: string; account_id: string }>();
  return { apiKey: body.api_key, accountId: body.account_id };
}

async function seedCredits(apiKey: string, balanceUsd: number) {
  await SELF.fetch('http://localhost/v1/admin/seed', {
    method: 'POST',
    headers: { 'X-Admin-Secret': 'dev-secret-local', 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, amount_usd: balanceUsd }),
  });
}

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await SELF.fetch('http://localhost/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('GET /', () => {
  it('returns HTML status page', async () => {
    const res = await SELF.fetch('http://localhost/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('Budget Governor');
    expect(text).toContain('budget_clear');
  });
});

describe('POST /v1/account', () => {
  it('provisions account with bg_ prefixed key', async () => {
    const res = await SELF.fetch('http://localhost/v1/account', { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json<{ api_key: string; account_id: string }>();
    expect(body.api_key).toMatch(/^bg_/);
    expect(body.account_id).toBeTruthy();
  });
});

describe('GET /v1/account/balance', () => {
  it('returns 401 without auth', async () => {
    const res = await SELF.fetch('http://localhost/v1/account/balance');
    expect(res.status).toBe(401);
  });

  it('returns balance for valid key', async () => {
    const { apiKey } = await provisionAccount();
    const res = await SELF.fetch('http://localhost/v1/account/balance', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ balance_usd: 0 });
  });
});

describe('POST /v1/account/topup/:pack', () => {
  it('returns 402 with payment-required header for valid pack', async () => {
    const { apiKey } = await provisionAccount();
    const res = await SELF.fetch('http://localhost/v1/account/topup/starter', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(402);
    expect(res.headers.get('payment-required')).toBeTruthy();
  });

  it('returns 400 for invalid pack', async () => {
    const { apiKey } = await provisionAccount();
    const res = await SELF.fetch('http://localhost/v1/account/topup/invalid', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_pack');
  });
});

describe('PUT /v1/budget/envelope', () => {
  it('creates an envelope', async () => {
    const { apiKey } = await provisionAccount();
    const res = await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', limit_usd: 5, window: 'daily' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ success: boolean; agent_id: string; limit_usd: number }>();
    expect(body.success).toBe(true);
    expect(body.agent_id).toBe('test-agent');
    expect(body.limit_usd).toBe(5);
  });
});

describe('GET /v1/budget/envelope/:agent_id', () => {
  it('returns envelope state', async () => {
    const { apiKey } = await provisionAccount();
    await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', limit_usd: 5 }),
    });
    const res = await SELF.fetch('http://localhost/v1/budget/envelope/test-agent', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ agent_id: string; limit_usd: number; remaining_usd: number }>();
    expect(body.agent_id).toBe('test-agent');
    expect(body.limit_usd).toBe(5);
    expect(body.remaining_usd).toBe(5);
  });

  it('returns 404 for missing envelope', async () => {
    const { apiKey } = await provisionAccount();
    const res = await SELF.fetch('http://localhost/v1/budget/envelope/no-such-agent', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /v1/budget/envelope/:agent_id', () => {
  it('deletes an envelope', async () => {
    const { apiKey } = await provisionAccount();
    await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', limit_usd: 5 }),
    });
    const del = await SELF.fetch('http://localhost/v1/budget/envelope/test-agent', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(del.status).toBe(200);
    const body = await del.json<{ success: boolean; agent_id: string }>();
    expect(body.success).toBe(true);
  });

  it('returns 404 after deletion', async () => {
    const { apiKey } = await provisionAccount();
    await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', limit_usd: 5 }),
    });
    await SELF.fetch('http://localhost/v1/budget/envelope/test-agent', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const res = await SELF.fetch('http://localhost/v1/budget/envelope/test-agent', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/budget/clear', () => {
  it('returns 400 for zero estimated_tokens', async () => {
    const { apiKey } = await provisionAccount();
    const res = await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', model: 'claude-sonnet-4-6', estimated_tokens: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('denies with no_credits when balance is zero', async () => {
    const { apiKey } = await provisionAccount();
    const res = await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', model: 'claude-sonnet-4-6', estimated_tokens: 1000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ approved: boolean; reason: string }>();
    expect(body.approved).toBe(false);
    expect(body.reason).toBe('no_credits');
  });

  it('denies with no_envelope when envelope is missing', async () => {
    const { apiKey } = await provisionAccount();
    await seedCredits(apiKey, 10);
    const res = await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'no-envelope-agent', model: 'claude-sonnet-4-6', estimated_tokens: 1000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ approved: boolean; reason: string }>();
    expect(body.approved).toBe(false);
    expect(body.reason).toBe('no_envelope');
  });

  it('approves when credits and envelope are sufficient', async () => {
    const { apiKey } = await provisionAccount();
    await seedCredits(apiKey, 10);
    await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', limit_usd: 5 }),
    });
    const res = await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', model: 'claude-sonnet-4-6', estimated_tokens: 1000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ approved: boolean; remaining_usd: number }>();
    expect(body.approved).toBe(true);
    expect(body.remaining_usd).toBeLessThan(5);
  });

  it('denies with no_credits when balance is insufficient for estimated cost', async () => {
    const { apiKey } = await provisionAccount();
    await seedCredits(apiKey, 0.05); // $0.05 — below cost of 10K sonnet tokens ($0.15)
    await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', limit_usd: 10 }),
    });
    const res = await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', model: 'claude-sonnet-4-6', estimated_tokens: 10_000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ approved: boolean; reason: string }>();
    expect(body.approved).toBe(false);
    expect(body.reason).toBe('no_credits');
  });

  it('deducts balance on approval', async () => {
    const { apiKey } = await provisionAccount();
    await seedCredits(apiKey, 10);
    await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', limit_usd: 10 }),
    });
    await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', model: 'claude-sonnet-4-6', estimated_tokens: 1000 }),
    });
    const balRes = await SELF.fetch('http://localhost/v1/account/balance', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const { balance_usd } = await balRes.json<{ balance_usd: number }>();
    expect(balance_usd).toBeLessThan(10);
  });

  it('denies with envelope_exceeded when cost exceeds remaining', async () => {
    const { apiKey } = await provisionAccount();
    await seedCredits(apiKey, 10); // $10 covers 100K tokens ($1.50) but envelope is $0.001
    await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', limit_usd: 0.001 }),
    });
    const res = await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', model: 'claude-sonnet-4-6', estimated_tokens: 100_000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ approved: boolean; reason: string }>();
    expect(body.approved).toBe(false);
    expect(body.reason).toBe('envelope_exceeded');
  });
});

// ── Payment UI ───────────────────────────────────────────────────────────────

describe('GET /v1/packs/:pack/info', () => {
  it('returns correct shape for each pack', async () => {
    const packs = [
      { name: 'starter', amount_usd: 19, raw: '19000000' },
      { name: 'growth',  amount_usd: 39, raw: '39000000' },
      { name: 'studio',  amount_usd: 79, raw: '79000000' },
    ];
    for (const p of packs) {
      const res = await SELF.fetch(`http://localhost/v1/packs/${p.name}/info`);
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body.pack).toBe(p.name);
      expect(body.amount_usd).toBe(p.amount_usd);
      expect(body.usdc_amount_raw).toBe(p.raw);
      expect(body.usdc_contract).toBeTruthy();
      expect(body.payto_address).toBeTruthy();
    }
  });

  it('returns 404 for unknown pack', async () => {
    const res = await SELF.fetch('http://localhost/v1/packs/invalid/info');
    expect(res.status).toBe(404);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_pack');
  });
});

describe('GET /pay/:pack', () => {
  it('renders pay page for each pack', async () => {
    for (const pack of ['starter', 'growth', 'studio']) {
      const res = await SELF.fetch(`http://localhost/pay/${pack}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('USDC');
      expect(html).toContain(PAYTO);
    }
  });

  it('returns 404 for unknown pack', async () => {
    const res = await SELF.fetch('http://localhost/pay/unknown');
    expect(res.status).toBe(404);
  });

  it('blocks XSS via malformed api_key', async () => {
    const res = await SELF.fetch('http://localhost/pay/starter?api_key=x%22%3E%3Cscript%3E');
    expect(res.status).toBe(400);
  });

  it('accepts valid api_key format', async () => {
    const { apiKey } = await provisionAccount();
    const res = await SELF.fetch(`http://localhost/pay/starter?api_key=${apiKey}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(apiKey);
  });
});

describe('POST /v1/account/topup-verify/:pack', () => {
  const VALID_TX = '0x' + 'a'.repeat(64);

  afterEach(() => vi.unstubAllGlobals());

  it('returns 401 without auth', async () => {
    const res = await SELF.fetch('http://localhost/v1/account/topup-verify/starter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: VALID_TX }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid tx_hash format', async () => {
    const { apiKey } = await provisionAccount();
    const res = await SELF.fetch('http://localhost/v1/account/topup-verify/starter', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: 'not-a-hash' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_tx_hash');
  });

  it('returns 400 for invalid pack', async () => {
    const { apiKey } = await provisionAccount();
    const res = await SELF.fetch('http://localhost/v1/account/topup-verify/fake', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: VALID_TX }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_pack');
  });

  it('returns 409 for already-used tx hash', async () => {
    const { apiKey } = await provisionAccount();
    await env.BUDGET_KV.put(`used_tx:84532:${VALID_TX}`, '1');
    const res = await SELF.fetch('http://localhost/v1/account/topup-verify/starter', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: VALID_TX }),
    });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe('already_used');
  });

  it('returns 400 when tx not found on chain', async () => {
    stubRpc(null);
    const { apiKey } = await provisionAccount();
    const res = await SELF.fetch('http://localhost/v1/account/topup-verify/starter', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: '0x' + 'b'.repeat(64) }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('tx_not_found');
  });

  it('credits account and marks tx used on valid payment', async () => {
    const TX = '0x' + 'c'.repeat(64);
    stubRpc(makeReceipt(PAYTO, 19_000_000n));
    const { apiKey } = await provisionAccount();

    const res = await SELF.fetch('http://localhost/v1/account/topup-verify/starter', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: TX }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ balance_usd: number; credited: number }>();
    expect(body.credited).toBe(19);
    expect(body.balance_usd).toBe(19);

    // tx marked as used in KV
    const used = await env.BUDGET_KV.get(`used_tx:84532:${TX}`);
    expect(used).toBe('1');

    // balance persisted
    const balRes = await SELF.fetch('http://localhost/v1/account/balance', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect((await balRes.json<{ balance_usd: number }>()).balance_usd).toBe(19);
  });

  it('rejects second submit of same tx hash (replay protection)', async () => {
    const TX = '0x' + 'd'.repeat(64);
    stubRpc(makeReceipt(PAYTO, 19_000_000n));
    const { apiKey } = await provisionAccount();
    await SELF.fetch('http://localhost/v1/account/topup-verify/starter', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: TX }),
    });

    const second = await SELF.fetch('http://localhost/v1/account/topup-verify/starter', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: TX }),
    });
    expect(second.status).toBe(409);
    expect((await second.json<{ error: string }>()).error).toBe('already_used');
  });

  it('rejects transfer to wrong address', async () => {
    const TX = '0x' + 'e'.repeat(64);
    stubRpc(makeReceipt('0x' + 'dead'.padStart(40, '0'), 19_000_000n));
    const { apiKey } = await provisionAccount();

    const res = await SELF.fetch('http://localhost/v1/account/topup-verify/starter', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: TX }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('transfer_not_found');
  });

  it('rejects wrong USDC amount', async () => {
    const TX = '0x' + 'f'.repeat(64);
    stubRpc(makeReceipt(PAYTO, 1_000_000n)); // $1 instead of $19
    const { apiKey } = await provisionAccount();

    const res = await SELF.fetch('http://localhost/v1/account/topup-verify/starter', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: TX }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('transfer_not_found');
  });
});

// ── MCP tool helpers ──────────────────────────────────────────────────────────

async function mcpCall(apiKey: string, method: string, params: object) {
  const res = await SELF.fetch(`http://localhost/mcp?api_key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json<{ result?: { content: Array<{ text: string }> }; error?: object }>();
}

async function mcpToolCall(apiKey: string, name: string, args: object) {
  const body = await mcpCall(apiKey, 'tools/call', { name, arguments: args });
  if (!body.result) throw new Error(`MCP error: ${JSON.stringify(body.error)}`);
  return JSON.parse(body.result.content[0].text);
}

describe('MCP tools → Durable Object routing', () => {
  it('set_envelope via MCP then budget_clear via MCP returns approved', async () => {
    const { apiKey } = await provisionAccount();
    await seedCredits(apiKey, 10);

    await mcpToolCall(apiKey, 'set_envelope', {
      agent_id: 'test-agent',
      limit_usd: 5,
      window: 'daily',
    });

    const clearance = await mcpToolCall(apiKey, 'budget_clear', {
      agent_id: 'test-agent',
      model: 'claude-haiku-4-5-20251001',
      estimated_tokens: 100,
    });

    expect(clearance.approved).toBe(true);
  });

  it('get_balance via MCP returns DO balance after credit', async () => {
    const { apiKey } = await provisionAccount();
    await seedCredits(apiKey, 7);

    const bal = await mcpToolCall(apiKey, 'get_balance', {});
    expect(bal.balance_usd).toBe(7);
  });
});
