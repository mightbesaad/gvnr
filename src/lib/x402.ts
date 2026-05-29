import { paymentMiddleware } from '@x402/hono';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import type { RoutesConfig } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { createFacilitatorConfig } from '@coinbase/x402';
import type { MiddlewareHandler } from 'hono';

const FALLBACK_FACILITATOR_URL = 'https://x402.org/facilitator';

// `ops` = governance operations granted (one per budget_clear). This is gvnr's revenue
// unit — flat per-op quota, decoupled from the customer's LLM spend (which they pay their
// provider directly). Bigger packs price each op lower: $0.0019 / $0.0013 / $0.00079.
export const PACKS = {
  starter: { amount_usd: 19, ops: 10_000,  description: 'Starter — 10k governance ops/month' },
  growth:  { amount_usd: 39, ops: 30_000,  description: 'Growth — 30k governance ops/month' },
  studio:  { amount_usd: 79, ops: 100_000, description: 'Studio — 100k governance ops/month' },
} as const;

export type PackName = keyof typeof PACKS;

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
