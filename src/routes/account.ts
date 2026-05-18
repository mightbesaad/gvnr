import { Hono } from 'hono';
import type { Env } from '../lib/types';
import { keys, getBalance, setBalance } from '../lib/kv';
import { authMiddleware, type AuthVariables } from '../lib/auth';
import { PACKS, type PackName } from '../lib/x402';

type Variables = AuthVariables;

const account = new Hono<{ Bindings: Env; Variables: Variables }>();

// POST /v1/account — provision a new account, returns api_key
account.post('/', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const rlKey = `ratelimit:newacct:${ip}:${hourBucket}`;
  const count = Number(await c.env.BUDGET_KV.get(rlKey) ?? '0');
  if (count >= 10) {
    return c.json({ error: 'rate_limited', retry_after: 'next_hour' }, 429);
  }
  await c.env.BUDGET_KV.put(rlKey, String(count + 1), { expirationTtl: 7200 });

  const accountId = crypto.randomUUID();
  const apiKey = `bg_${crypto.randomUUID().replace(/-/g, '')}`;

  await c.env.BUDGET_KV.put(keys.api(apiKey), JSON.stringify({ account_id: accountId }));
  await setBalance(c.env.BUDGET_KV, accountId, { balance_usd: 0, updated_at: Date.now() });

  return c.json({ api_key: apiKey, account_id: accountId }, 201);
});

// GET /v1/account/balance — current credit balance
account.get('/balance', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const balance = await getBalance(c.env.BUDGET_KV, accountId);
  return c.json({ balance_usd: balance?.balance_usd ?? 0 });
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
  const current = await getBalance(c.env.BUDGET_KV, accountId);
  const newBalance = (current?.balance_usd ?? 0) + pack.amount_usd;
  await setBalance(c.env.BUDGET_KV, accountId, { balance_usd: newBalance, updated_at: Date.now() });

  return c.json({ balance_usd: newBalance, pack: packName, credited: pack.amount_usd });
});

export default account;
