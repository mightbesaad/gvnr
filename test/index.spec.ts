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

// ── POST /v1/budget/reconcile ─────────────────────────────────────────────────

describe('POST /v1/budget/reconcile', () => {
  async function setupClearance(opts: { credits?: number; model?: string; estimated_tokens?: number; limit?: number } = {}) {
    const credits = opts.credits ?? 10;
    const model = opts.model ?? 'claude-sonnet-4-6';
    const tokens = opts.estimated_tokens ?? 1000;
    const limit = opts.limit ?? 10;

    const { apiKey } = await provisionAccount();
    await seedCredits(apiKey, credits);
    await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', limit_usd: limit }),
    });
    await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', model, estimated_tokens: tokens }),
    });
    return { apiKey };
  }

  it('actual > estimate: positive drift applied (under 2x threshold)', async () => {
    // sonnet 1000 out → est $0.015; actual 500 in + 1500 out = $0.024 (1.6x); drift = +$0.009
    const { apiKey } = await setupClearance({ credits: 10, estimated_tokens: 1000 });
    const res = await SELF.fetch('http://localhost/v1/budget/reconcile', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', actual_input_tokens: 500, actual_output_tokens: 1500 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; drift_usd: number; remaining_usd: number; balance_usd: number; warning?: string }>();
    expect(body.ok).toBe(true);
    expect(body.drift_usd).toBeCloseTo(0.009, 6);
    expect(body.warning).toBeUndefined();
    expect(body.balance_usd).toBeCloseTo(9.976, 6);
  });

  it('actual < estimate: negative drift refunds', async () => {
    // sonnet 5000 out → est $0.075; actual 100 in + 200 out = $0.0033; drift = -$0.0717
    const { apiKey } = await setupClearance({ credits: 10, estimated_tokens: 5000 });
    const res = await SELF.fetch('http://localhost/v1/budget/reconcile', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', actual_input_tokens: 100, actual_output_tokens: 200 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ drift_usd: number; balance_usd: number }>();
    expect(body.drift_usd).toBeCloseTo(-0.0717, 6);
    expect(body.balance_usd).toBeCloseTo(9.9967, 6);
  });

  it('actual == estimate: drift = 0', async () => {
    // est = (1000/1e6)*15 = $0.015; actual 0 in + 1000 out = $0.015
    const { apiKey } = await setupClearance({ credits: 10, estimated_tokens: 1000 });
    const res = await SELF.fetch('http://localhost/v1/budget/reconcile', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', actual_input_tokens: 0, actual_output_tokens: 1000 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ drift_usd: number }>()).drift_usd).toBe(0);
  });

  it('error: no prior budget_clear → no_pending_clearance', async () => {
    const { apiKey } = await provisionAccount();
    await seedCredits(apiKey, 10);
    await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', limit_usd: 5 }),
    });
    const res = await SELF.fetch('http://localhost/v1/budget/reconcile', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', actual_input_tokens: 100, actual_output_tokens: 200 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('no_pending_clearance');
  });

  it('error: no envelope at all → no_envelope', async () => {
    const { apiKey } = await provisionAccount();
    const res = await SELF.fetch('http://localhost/v1/budget/reconcile', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'no-such-agent', actual_input_tokens: 100, actual_output_tokens: 200 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('no_envelope');
  });

  it('double reconcile: second returns no_pending_clearance', async () => {
    const { apiKey } = await setupClearance({ credits: 10, estimated_tokens: 1000 });
    const first = await SELF.fetch('http://localhost/v1/budget/reconcile', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', actual_input_tokens: 100, actual_output_tokens: 1000 }),
    });
    expect(first.status).toBe(200);

    const second = await SELF.fetch('http://localhost/v1/budget/reconcile', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', actual_input_tokens: 100, actual_output_tokens: 1000 }),
    });
    expect(second.status).toBe(400);
    expect((await second.json<{ error: string }>()).error).toBe('no_pending_clearance');
  });

  it('actual > 2x estimate: applied with drift_exceeds_2x_threshold warning + log', async () => {
    // est = (100/1e6)*15 = $0.0015; actual 0 in + 10000 out = $0.15 → 100x estimate
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { apiKey } = await setupClearance({ credits: 10, estimated_tokens: 100, limit: 10 });
    const res = await SELF.fetch('http://localhost/v1/budget/reconcile', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', actual_input_tokens: 0, actual_output_tokens: 10_000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ drift_usd: number; warning?: string }>();
    expect(body.drift_usd).toBeCloseTo(0.1485, 6);
    expect(body.warning).toBe('drift_exceeds_2x_threshold');

    const logged = logSpy.mock.calls.map(c => String(c[0])).find(s => s.includes('drift_warning'));
    expect(logged).toBeTruthy();
    const parsed = JSON.parse(logged!);
    expect(parsed.event).toBe('drift_warning');
    expect(parsed.model).toBe('claude-sonnet-4-6');
    logSpy.mockRestore();
  });

  it('unknown model: uses DEFAULT_PRICE (Opus rate) for actual', async () => {
    // est at default: (1000/1e6)*75 = $0.075; actual 1000 in + 1000 out at default = $0.09; drift = +$0.015
    const { apiKey } = await setupClearance({ credits: 10, estimated_tokens: 1000, model: 'totally-unknown-model-xyz' });
    const res = await SELF.fetch('http://localhost/v1/budget/reconcile', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', actual_input_tokens: 1000, actual_output_tokens: 1000 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ drift_usd: number }>()).drift_usd).toBeCloseTo(0.015, 6);
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

  it('returns 200 with already_credited for already-used tx hash (idempotent)', async () => {
    const { apiKey } = await provisionAccount();
    await env.BUDGET_KV.put(`used_tx:84532:${VALID_TX}`, '1');
    const res = await SELF.fetch('http://localhost/v1/account/topup-verify/starter', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: VALID_TX }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ balance_usd: number; pack: string; already_credited: boolean }>();
    expect(body.already_credited).toBe(true);
    expect(body.pack).toBe('starter');
    expect(typeof body.balance_usd).toBe('number');
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

  it('second submit of same tx hash returns existing balance, does not double-credit', async () => {
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
    expect(second.status).toBe(200);
    const body = await second.json<{ balance_usd: number; already_credited: boolean }>();
    expect(body.already_credited).toBe(true);
    expect(body.balance_usd).toBe(19); // unchanged — no double credit
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

  it('rejects underpayment by 1 wei (proves >= not >)', async () => {
    const TX = '0x' + '1'.repeat(64);
    stubRpc(makeReceipt(PAYTO, 19_000_000n - 1n));
    const { apiKey } = await provisionAccount();

    const res = await SELF.fetch('http://localhost/v1/account/topup-verify/starter', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: TX }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('transfer_not_found');
  });

  it('credits pack amount and logs overpayment when transfer exceeds expected', async () => {
    const TX = '0x' + '2'.repeat(64);
    stubRpc(makeReceipt(PAYTO, 20_000_000n)); // $20 sent to $19 pack — $1 overpay
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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

    const logged = logSpy.mock.calls.map(c => String(c[0])).find(s => s.includes('overpayment'));
    expect(logged).toBeTruthy();
    const parsed = JSON.parse(logged!);
    expect(parsed.event).toBe('overpayment');
    expect(parsed.pack).toBe('starter');
    expect(parsed.overpaid_raw).toBe('1000000');
    logSpy.mockRestore();
  });

  it('falls back to BASE_RPC_FALLBACK_URL when primary RPC throws', async () => {
    const TX = '0x' + '3'.repeat(64);
    const calls: string[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.includes('.base.org')) {
        calls.push('primary');
        throw new Error('primary unreachable');
      }
      if (url.includes('publicnode.com')) {
        calls.push('fallback');
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          result: makeReceipt(PAYTO, 19_000_000n),
          id: 1,
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return real(input, init);
    });

    const { apiKey } = await provisionAccount();
    const res = await SELF.fetch('http://localhost/v1/account/topup-verify/starter', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: TX }),
    });

    expect(res.status).toBe(200);
    expect((await res.json<{ balance_usd: number }>()).balance_usd).toBe(19);
    expect(calls).toEqual(['primary', 'fallback']);
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

  it('returns 401 for missing api_key', async () => {
    const res = await SELF.fetch('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for invalid api_key', async () => {
    const res = await SELF.fetch('http://localhost/mcp?api_key=bg_invalid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
  });
});

// ── Cross-path: REST ↔ MCP read/write consistency ────────────────────────────

describe('cross-path: REST write → MCP read', () => {
  it('envelope set via REST is visible to MCP budget_clear', async () => {
    const { apiKey } = await provisionAccount();
    await seedCredits(apiKey, 10);

    await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'rest-agent', limit_usd: 5 }),
    });

    const clearance = await mcpToolCall(apiKey, 'budget_clear', {
      agent_id: 'rest-agent',
      model: 'claude-haiku-4-5-20251001',
      estimated_tokens: 100,
    });

    expect(clearance.approved).toBe(true);
  });
});

describe('cross-path: MCP write → REST read', () => {
  it('envelope set via MCP is returned by REST GET', async () => {
    const { apiKey } = await provisionAccount();
    await seedCredits(apiKey, 10);

    await mcpToolCall(apiKey, 'set_envelope', {
      agent_id: 'mcp-agent',
      limit_usd: 3,
      window: 'daily',
    });

    const res = await SELF.fetch('http://localhost/v1/budget/envelope/mcp-agent', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ limit_usd: number; window: string }>();
    expect(body.limit_usd).toBe(3);
    expect(body.window).toBe('daily');
  });
});

// ── runClearance edge cases ───────────────────────────────────────────────────

describe('estimateCostUsd unknown-model fallback', () => {
  it('debits unknown models at the highest known rate (Opus output) — fail-safe', async () => {
    const { apiKey } = await provisionAccount();
    // $0.075 = 1000 tokens × $75/M (Opus rate, the new default)
    await seedCredits(apiKey, 0.075);
    await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent', limit_usd: 1 }),
    });

    // Approves at exactly the seeded balance
    const ok = await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent', model: 'totally-unknown-model-xyz', estimated_tokens: 1000 }),
    });
    expect((await ok.json<{ approved: boolean }>()).approved).toBe(true);

    // Now denied — balance drained at the higher (Opus) rate, not the old $15 default
    const denied = await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent', model: 'totally-unknown-model-xyz', estimated_tokens: 1 }),
    });
    const body = await denied.json<{ approved: boolean; reason: string }>();
    expect(body.approved).toBe(false);
    expect(body.reason).toBe('no_credits');
  });
});

describe('runClearance edge cases', () => {
  // haiku-4-5 = $4/M tokens → 1000 tokens = $0.004
  const MODEL = 'claude-haiku-4-5-20251001';
  const COST = 0.004; // cost of 1000 tokens at haiku price

  it('approves when balance equals estimated cost exactly', async () => {
    const { apiKey } = await provisionAccount();
    await seedCredits(apiKey, COST);
    await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent', limit_usd: COST }),
    });

    const res = await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent', model: MODEL, estimated_tokens: 1000 }),
    });
    expect((await res.json<{ approved: boolean }>()).approved).toBe(true);
  });

  it('depletes balance across sequential clearances, then denies', async () => {
    const { apiKey } = await provisionAccount();
    await seedCredits(apiKey, COST * 3); // exactly 3 clearances
    await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent', limit_usd: COST * 10 }),
    });

    const args = { agent_id: 'agent', model: MODEL, estimated_tokens: 1000 };
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

    for (let i = 0; i < 3; i++) {
      const r = await SELF.fetch('http://localhost/v1/budget/clear', {
        method: 'POST', headers,
        body: JSON.stringify(args),
      });
      expect((await r.json<{ approved: boolean }>()).approved).toBe(true);
    }

    const denied = await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST', headers,
      body: JSON.stringify(args),
    });
    expect((await denied.json<{ approved: boolean; reason: string }>()).reason).toBe('no_credits');
  });

  it('session window never resets spent amount', async () => {
    const { apiKey } = await provisionAccount();
    await seedCredits(apiKey, 10);
    await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent', limit_usd: COST, window: 'session' }),
    });

    // spend the full envelope
    await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent', model: MODEL, estimated_tokens: 1000 }),
    });

    // session window — no reset, should deny
    const res = await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent', model: MODEL, estimated_tokens: 1000 }),
    });
    expect((await res.json<{ approved: boolean; reason: string }>()).reason).toBe('envelope_exceeded');
  });

  it('daily window resets spent amount when reset_at is in the past', async () => {
    const { apiKey, accountId } = await provisionAccount();
    await seedCredits(apiKey, 10);

    // plant an already-exhausted envelope with a past reset_at via direct DO access
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId));
    await stub.setEnvelope('agent', {
      limit_usd: COST,
      spent_usd: COST,       // fully spent
      window: 'daily',
      reset_at: Date.now() - 1000, // reset was 1 second ago
    });

    const res = await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent', model: MODEL, estimated_tokens: 1000 }),
    });
    expect((await res.json<{ approved: boolean }>()).approved).toBe(true);
  });
});
