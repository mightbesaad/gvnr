export interface AccountRecord {
  account_id: string;
}

export interface BalanceRecord {
  balance_usd: number;
  updated_at: number;
}

export interface EnvelopeRecord {
  limit_usd: number;
  spent_usd: number;
  window: 'daily' | 'session';
  reset_at: number; // unix ms — next reset time for daily window
}

import type { AccountState } from './account-do';

export interface Env {
  BUDGET_KV: KVNamespace;
  ACCOUNT: DurableObjectNamespace<AccountState>;
  ACCOUNT_RATE_LIMITER: RateLimit;
  PAYTO_ADDRESS: string;     // USDC receiving address (0x...)
  X402_NETWORK: string;      // e.g. "eip155:8453" (Base) or "eip155:84532" (Base Sepolia)
  ADMIN_SECRET: string;      // secret header value for admin endpoints
}
