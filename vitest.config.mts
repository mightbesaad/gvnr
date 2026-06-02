import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					// x402 facilitator only supports testnet in CI/unit tests;
					// production wrangler.jsonc uses mainnet (eip155:8453).
					// SIGNUP_TRIAL_OPS forced to "0" so the existing 0-op-baseline tests hold;
					// the trial-grant tests flip it per-test.
					bindings: { X402_NETWORK: "eip155:84532", ADMIN_SECRET: "dev-secret-local", SIGNUP_TRIAL_OPS: "0" },
					// Miniflare only supports period: 10 | 60; production uses 3600.
					// Limit set high so tests don't exhaust the shared "unknown" IP key.
					ratelimits: {
						ACCOUNT_RATE_LIMITER: { simple: { limit: 1000, period: 60 } },
					},
				},
			},
		},
	},
});
