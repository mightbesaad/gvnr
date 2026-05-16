# Budget Governor — Deploy Runbook

Engineering deploy to Cloudflare Workers. Not a product launch — no custom domain, no x402 monitoring setup required.

---

## 1. Pre-flight

**Cloudflare auth** — must be done once per machine:

```bash
npx wrangler whoami     # shows logged-in account if already authenticated
npx wrangler login      # if not — opens browser OAuth flow
```

**Code checks:**

```bash
git status              # must be clean before deploying
npx tsc --noEmit        # must pass with 0 errors
npm test                # all tests green
```

Do not proceed if any of the above fails.

---

## 2. Decisions

Two choices to make before touching config:

**a) Network (real money vs testnet)**

| Value | Chain | Consequence |
|---|---|---|
| `eip155:84532` | Base Sepolia (testnet) | Safe — topup 402s use test USDC, no real money |
| `eip155:8453` | Base mainnet | Real — topup 402s charge real USDC |

Default in `wrangler.jsonc` is already `eip155:84532`. Change only when ready for production.

**b) `PAYTO_ADDRESS`**

Replace the zero address `0x000...000` with your real wallet address in `wrangler.jsonc`.
This is a public on-chain address — it goes in `vars`, not secrets.

---

## 3. Create KV namespace

Run once. Creates the remote KV namespace and prints the IDs.

```bash
npx wrangler kv namespace create BUDGET_KV
npx wrangler kv namespace create BUDGET_KV --preview
```

Paste the returned IDs into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "BUDGET_KV",
    "id": "<id from first command>",
    "preview_id": "<id from second command>"
  }
]
```

Then commit:

```bash
git add wrangler.jsonc
git commit -m "chore: add KV namespace IDs"
```

---

## 4. Config edits

In `wrangler.jsonc`, set the real values decided in step 2:

```jsonc
"vars": {
  "PAYTO_ADDRESS": "0xYOUR_REAL_ADDRESS",
  "X402_NETWORK": "eip155:84532"   // or eip155:8453 for mainnet
}
```

Commit if changed:

```bash
git add wrangler.jsonc
git commit -m "chore: set PAYTO_ADDRESS and network for deploy"
```

---

## 5. Deploy

```bash
npx wrangler deploy
```

Output will include the deployed URL, e.g. `https://budget-governor.<subdomain>.workers.dev`.

---

## 6. Smoke tests

Replace `$URL` and `$KEY` in the commands below.

```bash
URL=https://budget-governor.<subdomain>.workers.dev
```

**Health**
```bash
curl $URL/health
# {"ok":true}
```

**Provision account**
```bash
curl -X POST $URL/v1/account
# {"api_key":"bg_...","account_id":"..."}
KEY=bg_<value from above>
```

**Balance**
```bash
curl -H "Authorization: Bearer $KEY" $URL/v1/account/balance
# {"balance_usd":0}
```

**Topup → expect 402**
```bash
curl -X POST -H "Authorization: Bearer $KEY" $URL/v1/account/topup/starter
# HTTP 402 with x402 payment details
```

**MCP — list tools**
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  "$URL/mcp?api_key=$KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# returns budget_clear, set_envelope, get_balance
```

**MCP — budget_clear (no envelope yet, expect no_envelope)**
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  "$URL/mcp?api_key=$KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"budget_clear","arguments":{"agent_id":"smoke-test","model":"claude-sonnet-4-6","estimated_tokens":1000}}}'
# approved: false, reason: no_envelope (correct — no credits and no envelope)
```

---

## 7. Rollback

If the deploy breaks something:

```bash
npx wrangler deployments list          # find previous deployment ID
npx wrangler rollback                  # rolls back to previous deployment
```

---

## 8. Observability

Stream live logs from the deployed worker:

```bash
npx wrangler tail
```

Cloudflare dashboard also shows logs under Workers & Pages → budget-governor → Logs (requires observability enabled, which is already set in `wrangler.jsonc`).

---

## 9. Definition of done

- [ ] `$URL/health` returns `{"ok":true}`
- [ ] `POST /v1/account` creates an account with `bg_` prefixed key
- [ ] `POST /v1/account/topup/starter` returns HTTP 402 with x402 payment details
- [ ] `POST /mcp?api_key=...` with `tools/list` returns all three tools
- [ ] MCP Inspector (or Claude Desktop) can connect to `/mcp` with an api_key param
