import { paymentMiddleware } from '@x402/hono';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import type { RoutesConfig, HTTPRequestContext } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { createFacilitatorConfig } from '@coinbase/x402';
import type { MiddlewareHandler } from 'hono';

const FALLBACK_FACILITATOR_URL = 'https://x402.org/facilitator';

// Pay-as-you-go top-up bounds (USD). The minimum is an *initiation* floor on the x402 path
// only: per-op cost is ~3 microdollars (≈99.7% margin) so ops are never the issue, but a
// per-top-up gas/settlement cost can dwarf a micro-payment — a ~$1 floor stays frictionless
// while protecting bottom-end unit economics. The manual tx-hash verify path intentionally
// has NO minimum (it credits whatever USDC actually arrived, so it can never eat funds).
//
// MAX is currently a conservative $100. It was originally a hard bound on verify→settle exposure
// (the middleware used to credit at verify time, before settlement). That exposure is now CLOSED:
// crediting is contingent on settlement success via the creditAfterSettle wrapper in index.ts
// (see TopupIntent / shouldCreditAfterSettle), so the cap is now just a fat-finger / abuse guard
// and can be raised when there's a reason to.
export const MIN_TOPUP_USD = 1;
export const MAX_TOPUP_USD = 100;

export type TopupAmountResult =
  | { ok: true; usd: number }
  | { ok: false; error: 'invalid_amount' | 'below_minimum' | 'above_maximum'; hint: string };

// Single source of truth for the pay-as-you-go `?usd=` amount. Used by BOTH the dynamic x402
// price function (which builds the 402 challenge) and the credit handler (which grants ops),
// so the quoted amount and the credited ops can never diverge. Canonicalizes to whole cents
// to avoid float drift between challenge-time and credit-time parsing.
export function parseTopupUsd(raw: string | string[] | undefined): TopupAmountResult {
  if (raw === undefined || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_amount', hint: 'Provide a single ?usd= amount in dollars, e.g. ?usd=5.' };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: 'invalid_amount', hint: 'usd must be a positive number, e.g. ?usd=5.' };
  }
  // Round to whole cents so the price function and the handler resolve identical values.
  const usd = Math.round(n * 100) / 100;
  if (usd < MIN_TOPUP_USD) {
    return { ok: false, error: 'below_minimum', hint: `Minimum top-up is $${MIN_TOPUP_USD}. Send at least ?usd=${MIN_TOPUP_USD}.` };
  }
  if (usd > MAX_TOPUP_USD) {
    return { ok: false, error: 'above_maximum', hint: `Maximum top-up is $${MAX_TOPUP_USD}.` };
  }
  return { ok: true, usd };
}

// Packs are PRESET top-up amounts, not rigid SKUs. Ops are derived from the pay-as-you-go
// rate (OPS_PER_USD in models.ts): a top-up credits floor(amount_usd * OPS_PER_USD) ops, so
// any amount works and packs are just convenient presets. At 1,000 ops/$1 these yield
// 19,000 / 39,000 / 79,000 ops. gvnr's revenue is the op quota, decoupled from the
// customer's LLM spend (which they pay their provider directly).
export const PACKS = {
  starter: { amount_usd: 19, description: 'Starter — 19,000 governance ops' },
  growth:  { amount_usd: 39, description: 'Growth — 39,000 governance ops' },
  studio:  { amount_usd: 79, description: 'Studio — 79,000 governance ops' },
} as const;

export type PackName = keyof typeof PACKS;

// Credit-after-settlement plumbing. The x402 middleware credits NOTHING itself. A topup route
// handler validates the (verified) payment, stashes a TopupIntent on the request context, and
// returns a provisional 2xx. The middleware then settles on-chain and either leaves that 2xx in
// place (success) or overwrites it with a 402 (settlement failure). Only afterward does the
// wrapper in index.ts run shouldCreditAfterSettle + AccountState.credit — so a verify-then-
// settle-fail can never leave ops credited without funds. This closes the verify→settle window
// that the $100 MAX_TOPUP_USD cap was a stopgap for. `body` is the provisional response body the
// handler built (minus operations_remaining, which only exists once the credit lands).
export interface TopupIntent {
  accountId: string;
  ops: number;
  body: Record<string, unknown>;
}

// Credit iff the handler stashed an intent (i.e. payment verified and the handler ran) AND the
// final response is a success (settlement did not overwrite it with a 402). Type-guards `intent`
// so the caller gets a non-undefined TopupIntent in the true branch.
export function shouldCreditAfterSettle(
  intent: TopupIntent | undefined,
  status: number,
): intent is TopupIntent {
  return intent !== undefined && status < 400;
}

// Singleton state — one resource server + one init promise per Workers isolate.
let resourceServer: x402ResourceServer | null = null;
let initPromise: Promise<void> | null = null;
let innerMiddleware: MiddlewareHandler | null = null;

function getResourceServer(cdpKeyId?: string, cdpKeySecret?: string): x402ResourceServer {
  if (!resourceServer) {
    // Prefer Coinbase CDP facilitator when keys are configured (supports Base mainnet
    // eip155:8453). Fall back to the public x402.org facilitator (Sepolia-only) when
    // keys are absent — useful for testnet development.
    const facilitatorConfig = cdpKeyId && cdpKeySecret
      ? createFacilitatorConfig(cdpKeyId, cdpKeySecret)
      : { url: FALLBACK_FACILITATOR_URL };
    const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);
    resourceServer = new x402ResourceServer(facilitatorClient)
      .register('eip155:*', new ExactEvmScheme());
  }
  return resourceServer;
}

function buildRoutes(payToAddress: string, network: string): RoutesConfig {
  const routes: RoutesConfig = {};
  for (const [pack, { amount_usd, description }] of Object.entries(PACKS)) {
    routes[`POST /v1/account/topup/${pack}`] = {
      accepts: {
        scheme: 'exact',
        price: `$${amount_usd}`,
        network: network as `${string}:${string}`,
        payTo: payToAddress,
      },
      description,
    };
  }

  // Pay-as-you-go: name your own amount via ?usd=<dollars>. The price is resolved per-request
  // from the same `?usd=` the credit handler reads (via parseTopupUsd), so the exact-scheme
  // challenge and the credited ops are bound to one canonical value — the agent can't be
  // quoted one amount and credited for another. Invalid/below-min amounts are rejected with a
  // 400 by the gate wrapper in index.ts before this runs, so the fallback below is defensive.
  routes['POST /v1/account/topup'] = {
    accepts: {
      scheme: 'exact',
      price: (ctx: HTTPRequestContext) => {
        const parsed = parseTopupUsd(ctx.adapter.getQueryParam?.('usd'));
        return `$${(parsed.ok ? parsed.usd : MIN_TOPUP_USD).toFixed(2)}`;
      },
      network: network as `${string}:${string}`,
      payTo: payToAddress,
    },
    description: `Pay-as-you-go top-up — name your amount via ?usd=<dollars> (min $${MIN_TOPUP_USD}). Credits floor(usd × 1000) governance ops.`,
  };

  return routes;
}

export function buildX402Middleware(
  payToAddress: string,
  network: string,
  cdpKeyId?: string,
  cdpKeySecret?: string,
): MiddlewareHandler {
  const server = getResourceServer(cdpKeyId, cdpKeySecret);

  if (!innerMiddleware) {
    innerMiddleware = paymentMiddleware(
      buildRoutes(payToAddress, network),
      server,
      undefined,
      undefined,
      false, // we handle initialization ourselves below
    );
  }

  return async (c, next) => {
    // Initialize once — fetches supported schemes from facilitator.
    if (!initPromise) {
      initPromise = server.initialize();
    }
    await initPromise;
    return innerMiddleware!(c, next);
  };
}
