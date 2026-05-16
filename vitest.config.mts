import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					// x402 facilitator only supports testnet in CI/unit tests;
					// production wrangler.jsonc uses mainnet (eip155:8453).
					bindings: { X402_NETWORK: "eip155:84532" },
				},
			},
		},
	},
});
