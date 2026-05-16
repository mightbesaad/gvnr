# Budget Governor

Hard spend cap for autonomous AI agents. One MCP call before each LLM request — approved or denied before the call reaches any provider.

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
curl -X POST https://budget-governor.billowing-glade-3692.workers.dev/v1/account
# { "api_key": "bg_...", "account_id": "..." }
```

### 2. Top up credits

```bash
curl -X POST \
  -H "Authorization: Bearer bg_YOUR_KEY" \
  https://budget-governor.billowing-glade-3692.workers.dev/v1/account/topup/starter
# Returns HTTP 402 with x402 payment details (USDC on Base Sepolia / Base)
```

Pay with any x402-compatible wallet. Balance is credited automatically on settlement.

### 3. Set an envelope for your agent

```bash
curl -X PUT \
  -H "Authorization: Bearer bg_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"my-agent","limit_usd":5,"window":"daily"}' \
  https://budget-governor.billowing-glade-3692.workers.dev/v1/budget/envelope
# { "success": true, "agent_id": "my-agent", "limit_usd": 5, "window": "daily" }
```

### 4. Call budget_clear before each LLM request

```bash
curl -X POST \
  -H "Authorization: Bearer bg_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"my-agent","model":"claude-sonnet-4-6","estimated_tokens":2000}' \
  https://budget-governor.billowing-glade-3692.workers.dev/v1/budget/clear
# { "approved": true, "remaining_usd": 4.994 }
```

---

## MCP setup

Add to Claude Desktop or any MCP-compatible client:

```
https://budget-governor.billowing-glade-3692.workers.dev/mcp?api_key=bg_YOUR_KEY
```

### Claude Code

```bash
claude mcp add budget-governor --transport http \
  "https://budget-governor.billowing-glade-3692.workers.dev/mcp?api_key=bg_YOUR_KEY"
```

### MCP tools

| Tool | Description |
|---|---|
| `budget_clear(agent_id, model, estimated_tokens)` | Check clearance and deduct estimated cost |
| `set_envelope(agent_id, limit_usd, window?)` | Create or update an agent's spend envelope |
| `get_balance()` | Get current account credit balance |

---

## REST API

All endpoints (except `POST /v1/account`) require `Authorization: Bearer bg_YOUR_KEY`.

### Account

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/account` | Provision account — returns `api_key` |
| `GET` | `/v1/account/balance` | Current credit balance |
| `POST` | `/v1/account/topup/:pack` | x402-gated credit top-up |

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

Top up via `POST /v1/account/topup/:pack`. Payment is USDC on Base (or Base Sepolia for testnet).

| Pack | Price | Clearances |
|---|---|---|
| `starter` | $19 | ~10k/month |
| `growth` | $39 | ~30k/month |
| `studio` | $79 | ~100k/month |

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

Current deployment: Base Sepolia (testnet).
