export interface AccountRecord {
  account_id: string;
}

export interface EnvelopeRecord {
  limit_usd: number;
  spent_usd: number;
  window: 'daily' | 'session';
  reset_at: number; // unix ms — next reset time for daily window
  pending_estimate?: {
    model: string;
    estimated_cost_usd: number;
    estimated_at: number; // unix ms
  };
}

export interface ClearanceEvent {
  agent_id: string;
  model: string;
  est_usd: number;
  approved: boolean;
  reason?: 'no_credits' | 'no_envelope' | 'envelope_exceeded';
  ts: number; // unix ms
}

export interface RateEnvelopeRecord {
  provider: string;     // 'anthropic', 'openai', 'bedrock', etc. — informational
  model: string;        // e.g. 'claude-sonnet-4-6'
  requests_per_minute: number;
  window_start: number; // unix ms; window rolls when (now - window_start) >= 60_000
  requests_in_window: number;
}

import type { AccountState } from './account-do';

export interface AccountConfigRecord {
  notification_email?: string;
}

export interface Env {
  BUDGET_KV: KVNamespace;
  ACCOUNT: DurableObjectNamespace<AccountState>;
  ACCOUNT_RATE_LIMITER: RateLimit;
  APPROVAL_RATE_LIMITER: RateLimit;
  PAYTO_ADDRESS: string;     // USDC receiving address (0x...)
  X402_NETWORK: string;      // e.g. "eip155:8453" (Base) or "eip155:84532" (Base Sepolia)
  ADMIN_SECRET: string;      // secret header value for admin endpoints
  BASE_RPC_FALLBACK_URL?: string; // optional fallback RPC if the primary chain RPC fails
  RESEND_API_KEY?: string;   // optional — outbound approval email via Resend
  CDP_API_KEY_ID?: string;   // optional — Coinbase Developer Platform key ID for x402 mainnet facilitator
  CDP_API_KEY_SECRET?: string; // optional — paired CDP key secret
  TELEGRAM_BOT_TOKEN?: string; // optional — ops alerts (e.g. settled-but-not-credited top-ups)
  TELEGRAM_CHAT_ID?: string;   // optional — paired chat id for TELEGRAM_BOT_TOKEN
  ALERT_EMAIL?: string;        // optional — recipient for ops email alerts (paired with RESEND_API_KEY)
}
