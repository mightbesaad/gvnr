# TypeScript integration

Gvnr exposes a typed REST surface (12+ endpoints under `/v1/`) via an OpenAPI 3.1 spec at [`https://gvnr.dev/openapi.json`](https://gvnr.dev/openapi.json). Generate types locally with one command and use them with plain `fetch` — no SDK install, no version drift.

## Generate types

From any project:

```bash
npx openapi-typescript@latest https://gvnr.dev/openapi.json -o types/gvnr.d.ts
```

That produces `types/gvnr.d.ts` with `paths`, `components.schemas.ErrorResponse`, request bodies, and response bodies for every route. Re-run any time gvnr's spec version bumps.

## Typed REST call (the everyday loop)

The clear → call → reconcile loop is plain `Authorization: Bearer`:

```typescript
import type { paths } from './types/gvnr';

// openapi-typescript marks requestBody optional; unwrap with NonNullable
type ClearReq = NonNullable<paths['/v1/budget/clear']['post']['requestBody']>['content']['application/json'];
type ClearRes = paths['/v1/budget/clear']['post']['responses']['200']['content']['application/json'];

const API_KEY = 'bg_...'; // from POST /v1/account; load from your env

async function clear(input: ClearReq): Promise<ClearRes> {
  const res = await fetch('https://gvnr.dev/v1/budget/clear', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return res.json();
}

async function main() {
  const decision = await clear({ agent_id: 'planner-1', model: 'claude-sonnet-4-6', estimated_tokens: 2000 });
  if (!decision.approved) throw new Error(`gvnr denied: ${decision.reason}`);
  // ... call your LLM ...
  // then POST /v1/budget/reconcile with actual_input_tokens + actual_output_tokens
}
main();
```

The discriminant `approved: boolean` narrows `reason` to `'no_credits' | 'no_envelope' | 'envelope_exceeded'` only when `approved=false`.

## Topup via x402

The pack-payment endpoint (`/pay/:pack`) is x402-gated — return a `402 Payment Required` with payment instructions, the client wallet pays via USDC on Base, then re-requests. Use [`x402-fetch`](https://www.npmjs.com/package/x402-fetch) (Coinbase's reference client) if you want this automated in code:

```typescript
import { wrapFetchWithPayment } from 'x402-fetch';
import { privateKeyToAccount } from 'viem/accounts';

async function topUp() {
  const PRIVATE_KEY = '0x...' as `0x${string}`; // load from your env
  const API_KEY = 'bg_...';

  const account = privateKeyToAccount(PRIVATE_KEY);
  const payFetch = wrapFetchWithPayment(fetch, account);

  // One call — x402-fetch handles the 402 → pay → retry round-trip
  const res = await payFetch(`https://gvnr.dev/pay/starter?api_key=${API_KEY}`);
  const body = await res.json();
  // { balance_usd: 19, pack: 'starter', credited: 19 }
}
```

For interactive topups (paste tx hash in browser), point users at `https://gvnr.dev/pay/starter?api_key=...` — no SDK needed.

## What the types cover

- **All request bodies** (POST/PUT routes) with required-field enforcement
- **All 200 response bodies** with discriminated unions for `budget_clear`, `rate_check`, etc.
- **Path parameters** typed as enums where applicable (`pack: 'starter' | 'growth' | 'studio'`)
- **`ErrorResponse`** shape for all non-200 responses (via `components.schemas`)

## What's not included

- A packaged npm SDK. Gated on prospect ask or a LangChain-ecosystem signal; raw `fetch` + generated types covers ~80% of the SDK value with zero maintenance debt. See the project roadmap.
- A runtime client class. Wrap `fetch` yourself in 10 lines (above) — it's faster than learning an SDK's surface.

## Re-syncing types

Pin the gvnr spec version you generated against:

```bash
curl -s https://gvnr.dev/openapi.json | jq -r '.info.version'
# 1.5.1
```

Regenerate when that bumps. The spec follows semver.
