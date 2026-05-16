import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

async function provisionAccount(): Promise<{ apiKey: string; accountId: string }> {
  const res = await SELF.fetch('http://localhost/v1/account', { method: 'POST' });
  const body = await res.json<{ api_key: string; account_id: string }>();
  return { apiKey: body.api_key, accountId: body.account_id };
}

async function seedCredits(accountId: string, balanceUsd: number) {
  await env.BUDGET_KV.put(
    `account:${accountId}:balance`,
    JSON.stringify({ balance_usd: balanceUsd, updated_at: Date.now() }),
  );
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
    const { apiKey, accountId } = await provisionAccount();
    await seedCredits(accountId, 10);
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
    const { apiKey, accountId } = await provisionAccount();
    await seedCredits(accountId, 10);
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

  it('denies with envelope_exceeded when cost exceeds remaining', async () => {
    const { apiKey, accountId } = await provisionAccount();
    await seedCredits(accountId, 10);
    await SELF.fetch('http://localhost/v1/budget/envelope', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', limit_usd: 0.001 }),
    });
    const res = await SELF.fetch('http://localhost/v1/budget/clear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'test-agent', model: 'claude-sonnet-4-6', estimated_tokens: 1000000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ approved: boolean; reason: string }>();
    expect(body.approved).toBe(false);
    expect(body.reason).toBe('envelope_exceeded');
  });
});
