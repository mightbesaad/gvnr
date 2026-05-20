import { paymentMiddleware } from '@x402/hono';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import type { RoutesConfig } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import type { MiddlewareHandler } from 'hono';

const FACILITATOR_URL = 'https://x402.org/facilitator';

export const PACKS = {
  starter: { amount_usd: 19, description: 'Starter — ~10k tool calls/month' },
  growth:  { amount_usd: 39, description: 'Growth — ~30k tool calls/month' },
  studio:  { amount_usd: 79, description: 'Studio — ~100k tool calls/month' },
} as const;

export type PackName = keyof typeof PACKS;

// Singleton state — one resource server + one init promise per Workers isolate.
let resourceServer: x402ResourceServer | null = null;
let initPromise: Promise<void> | null = null;
let innerMiddleware: MiddlewareHandler | null = null;

function getResourceServer(): x402ResourceServer {
  if (!resourceServer) {
    const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
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

export function buildX402Middleware(payToAddress: string, network: string): MiddlewareHandler {
  const server = getResourceServer();

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
