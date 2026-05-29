import type { Context, Next } from 'hono';
import type { Env } from './types';
import { getAccount } from './kv';

export type AuthVariables = { accountId: string };
type AuthEnv = { Bindings: Env; Variables: AuthVariables };

export async function authMiddleware(c: Context<AuthEnv>, next: Next) {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'missing_api_key', retryable: false, hint: 'Send Authorization: Bearer <api_key> (or ?api_key= on /mcp). Obtain a key via POST /v1/account.' }, 401);
  }

  const apiKey = header.slice(7);
  const account = await getAccount(c.env.BUDGET_KV, apiKey);
  if (!account) {
    return c.json({ error: 'invalid_api_key', retryable: false, hint: 'Key not recognized. Obtain a new one via POST /v1/account.' }, 401);
  }

  c.set('accountId', account.account_id);
  await next();
}
