import type { Context, Next } from 'hono';
import type { Env } from './types';
import { getAccount } from './kv';

export type AuthVariables = { accountId: string };
type AuthEnv = { Bindings: Env; Variables: AuthVariables };

// Constant-time secret comparison for the X-Admin-Secret check. Both sides are hashed to a
// fixed 32-byte digest first, so the comparison loop is constant-length and reveals neither the
// length nor the byte-prefix of the configured secret through timing (a plain `a !== b`
// short-circuits on the first differing byte). Returns false if either side is empty.
export async function safeSecretEqual(a: string | undefined, b: string | undefined): Promise<boolean> {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
}

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
