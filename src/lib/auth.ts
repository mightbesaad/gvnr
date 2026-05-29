import type { Context, Next } from 'hono';
import type { Env } from './types';
import { getAccount } from './kv';

export type AuthVariables = { accountId: string };
type AuthEnv = { Bindings: Env; Variables: AuthVariables };

export async function authMiddleware(c: Context<AuthEnv>, next: Next) {
  // Accept the key via Bearer header OR ?api_key= query. The query fallback is required
  // for x402 clients (e.g. Base MCP) that strip Authorization headers — without it an
  // agent paying the x402-gated topup endpoint can't identify which account to credit.
  const header = c.req.header('Authorization');
  const apiKey = header?.startsWith('Bearer ') ? header.slice(7) : c.req.query('api_key');
  if (!apiKey) {
    return c.json({ error: 'missing_api_key', retryable: false, hint: 'Send Authorization: Bearer <api_key>, or ?api_key= in the query. Obtain a key via POST /v1/account.' }, 401);
  }

  const account = await getAccount(c.env.BUDGET_KV, apiKey);
  if (!account) {
    return c.json({ error: 'invalid_api_key', retryable: false, hint: 'Key not recognized. Obtain a new one via POST /v1/account.' }, 401);
  }

  c.set('accountId', account.account_id);
  await next();
}
