# Budget Governor

Pre-call cap + post-call reconcile for AI agent spend. One MCP call before each LLM request, one after — stops estimate drift before your provider bill catches up.

No deployment. No proxy. No self-hosting.

---

## The problem

Agents cost 10–12x more than estimated in production. System prompts, retry loops, and tool calls multiply fast. A runaway agent can generate a $47,000 bill in 11 days. The common fix — self-hosting LiteLLM — requires running infrastructure most developers won't set up.

Budget Governor is the hosted alternative: an external authority your agent checks before spending.

---

## How it works

1. Your agent calls `budget_clear` (MCP tool or REST) before each LLM request
2. The governor checks your account credit balance and the agent's spend envelope
3. It returns `{ approved: true }` or `{ approved: false, reason: "..." }`
4. If denied, your agent skips the call

The envelope is configured by you (per-agent daily or session cap). The credit balance is topped up via USDC on Base.

---

## Quick start

### 1. Provision an account

```bash
curl -X POST https://gvnr.dev/v1/account
# { "api_key": "bg_...", "account_id": "..." }
```

### 2. Top up credits

Open the payment page for your chosen pack, pass your API key as a query param:

```
https://gvnr.dev/pay/starter?api_key=bg_YOUR_KEY
```

Send USDC on Base to the address shown, paste your tx hash — credits are added after on-chain verification.

Or, if you prefer the programmatic path — POST the tx hash directly:

```bash
curl -X POST \
  -H "Authorization: Bearer bg_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tx_hash":"0x..."}' \
  https://gvnr.dev/v1/account/topup-verify/starter
```

### 3. Set an envelope for your agent

```bash
curl -X PUT \
  -H "Authorization: Bearer bg_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"my-agent","limit_usd":5,"window":"daily"}' \
  https://gvnr.dev/v1/budget/envelope
# { "success": true, "agent_id": "my-agent", "limit_usd": 5, "window": "daily" }
```

### 4. Call budget_clear before each LLM request

```bash
curl -X POST \
  -H "Authorization: Bearer bg_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"my-agent","model":"claude-sonnet-4-6","estimated_tokens":2000}' \
  https://gvnr.dev/v1/budget/clear
# { "approved": true, "remaining_usd": 4.994 }
```

### 5. After the LLM responds, reconcile against actual usage

```bash
curl -X POST \
  -H "Authorization: Bearer bg_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"my-agent","actual_input_tokens":1800,"actual_output_tokens":2400}' \
  https://gvnr.dev/v1/budget/reconcile
# { "ok": true, "drift_usd": 0.003, "remaining_usd": 4.991, "balance_usd": 9.991 }
```

`reconcile` is optional but keeps the envelope honest — Anthropic, OpenAI, and Gemini all return `usage` fields with the actual token counts; pass those in.

---

## MCP setup

Add to Claude Desktop or any MCP-compatible client:

```
https://gvnr.dev/mcp?api_key=bg_YOUR_KEY
```

### Claude Code

```bash
claude mcp add budget-governor --transport http \
  "https://gvnr.dev/mcp?api_key=bg_YOUR_KEY"
```

### MCP tools

| Tool | Description |
|---|---|
| `budget_clear(agent_id, model, estimated_tokens)` | Check clearance and deduct estimated cost |
| `set_envelope(agent_id, limit_usd, window?)` | Create or update an agent's spend envelope |
| `get_balance()` | Get current account credit balance |
| `reconcile(agent_id, actual_input_tokens, actual_output_tokens)` | Apply the drift between estimated and actual cost after the LLM responds |

---

## REST API

All endpoints (except `POST /v1/account`) require `Authorization: Bearer bg_YOUR_KEY`.

### Account

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/account` | Provision account — returns `api_key` |
| `GET` | `/v1/account/balance` | Current credit balance |
| `GET` | `/v1/packs/:pack/info` | Public — pack details, USDC address, raw amount |
| `POST` | `/v1/account/topup-verify/:pack` | Submit tx hash → verify on-chain → credit account |
| `POST` | `/v1/account/topup/:pack` | x402-gated credit top-up (machine clients) |

### Budget

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/budget/clear` | Clearance call — approve or deny |
| `PUT` | `/v1/budget/envelope` | Create or update agent envelope |
| `GET` | `/v1/budget/envelope/:agent_id` | Read envelope state |

### Clearance response

```json
{ "approved": true, "remaining_usd": 4.994 }
```

```json
{ "approved": false, "remaining_usd": 0, "reason": "envelope_exceeded" }
```

Denial reasons: `no_credits` · `no_envelope` · `envelope_exceeded`

---

## Credit packs

Top up at `GET /pay/:pack?api_key=bg_YOUR_KEY`. Send USDC on Base mainnet — credits added after on-chain verification.

| Pack | Price | Clearances | Link |
|---|---|---|---|
| `starter` | $19 | ~10k/month | `/pay/starter` |
| `growth` | $39 | ~30k/month | `/pay/growth` |
| `studio` | $79 | ~100k/month | `/pay/studio` |

---

## Envelope windows

- `daily` — resets at UTC midnight each day
- `session` — never resets (use for one-shot tasks)

---

## Supported models

Model pricing is a static lookup on the hot path — no external calls. Includes claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5, gpt-4o, gpt-4o-mini, and others. Unknown models fall back to a conservative default.

---

## Network

| `X402_NETWORK` | Chain | Notes |
|---|---|---|
| `eip155:84532` | Base Sepolia | Testnet — safe for development |
| `eip155:8453` | Base mainnet | Real USDC |

Current deployment: Base mainnet.

---

## License

MIT — see [LICENSE](LICENSE).

The canonical hosted service is at `https://gvnr.dev`. Self-hosted instances are unaffiliated.
