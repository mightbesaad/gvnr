import { Hono } from 'hono';
import type { Env } from '../lib/types';
import { hashApiKey } from '../lib/kv';
import { authMiddleware, type AuthVariables } from '../lib/auth';
import { PACKS, type PackName } from '../lib/x402';

type Variables = AuthVariables;

const account = new Hono<{ Bindings: Env; Variables: Variables }>();

// POST /v1/account — provision a new account, returns api_key
account.post('/', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const { success } = await c.env.ACCOUNT_RATE_LIMITER.limit({ key: ip });
  if (!success) {
    return c.json({ error: 'rate_limited', retry_after: 'next_hour' }, 429);
  }

  const accountId = crypto.randomUUID();
  const apiKey = `bg_${crypto.randomUUID().replace(/-/g, '')}`;
  const keyHash = await hashApiKey(apiKey);

  await c.env.BUDGET_KV.put(`api:${keyHash}`, JSON.stringify({ account_id: accountId }));

  return c.json({ api_key: apiKey, account_id: accountId }, 201);
});

// GET /v1/account/balance — current credit balance
account.get('/balance', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(accountId));
  const balance = await stub.getBalance();
  return c.json({ balance_usd: balance });
});

// POST /v1/account/topup/:pack — x402-gated credit top-up
// x402 middleware (applied in index.ts) intercepts first: returns 402 if no payment,
// calls next() if payment is verified. By the time this handler runs, payment is settled.
account.post('/topup/:pack', authMiddleware, async (c) => {
  const packName = c.req.param('pack') as PackName;
  const pack = PACKS[packName];

  if (!pack) {
    return c.json({ error: 'invalid_pack', valid: Object.keys(PACKS) }, 400);
  }

  const accountId = c.get('accountId');
  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(accountId));
  const result = await stub.credit(pack.amount_usd);

  return c.json({ balance_usd: result.balance_usd, pack: packName, credited: pack.amount_usd });
});

export default account;
