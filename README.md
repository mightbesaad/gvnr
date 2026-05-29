# Gvnr

[![Tests](https://github.com/mightbesaad/gvnr/actions/workflows/test.yml/badge.svg)](https://github.com/mightbesaad/gvnr/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/tag/mightbesaad/gvnr?label=release&color=blue)](https://github.com/mightbesaad/gvnr/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-dev.gvnr%2Fgvnr-purple)](https://registry.modelcontextprotocol.io/v0.1/servers?search=dev.gvnr/gvnr)
[![gvnr MCP server](https://glama.ai/mcp/servers/gvnrdev/gvnr/badges/score.svg)](https://glama.ai/mcp/servers/gvnrdev/gvnr)

Spend caps, rate coordination, idempotency, and a human-in-the-loop gate for AI agents — **enforced before the call, not after the invoice.** One MCP endpoint, settled via x402 (USDC on Base). No proxy, no self-hosting, no infrastructure to deploy.

Listed on the Official MCP Registry as [`dev.gvnr/gvnr`](https://registry.modelcontextprotocol.io/v0.1/servers?search=dev.gvnr/gvnr).

---

## The problem

Agents cost 10–12× more than estimated in production. System prompts, retry loops, and tool calls multiply fast — a runaway agent can generate a $47,000 bill in 11 days. The usual fix, self-hosting a gateway like LiteLLM, means running infrastructure most developers won't set up.

Gvnr is the hosted alternative: an external authority your agent checks **before** it spends. Your agent asks "am I clear to make this call?" and acts on the answer.

---

## How it works

Gvnr is **not** an LLM proxy — your tokens never pass through it, and you pay your model provider directly. Gvnr governs the *decision to spend*, in two independent meters:

**1. The governance-operation quota** — what you buy from Gvnr.
Your account holds a balance of **governance operations** (`operations_remaining`). One `budget_clear` burns one op. You top this up with USDC; it's decoupled from your LLM spend. `get_balance` reports it.

**2. The spend envelope** — a USD cap *you* set, per agent.
`set_envelope(agent_id, limit_usd, window)` gives an agent a daily or per-session USD ceiling. Gvnr tracks estimated spend against it and denies once it's exceeded — this is the runaway guardrail. No dollars move; it's an accounting limit you control.

A `budget_clear` is approved only when **both** hold: the account has ops left in the quota, and the agent is under its envelope. The loop:

1. Your agent calls `budget_clear(agent_id, model, estimated_tokens)` before each LLM request.
2. Gvnr checks the op quota and the agent's envelope, and returns `{ approved: true, ... }` or `{ approved: false, reason }`.
3. If denied, your agent skips (or escalates via `request_approval`).
4. After the LLM responds, call `reconcile(...)` with the real token counts so the envelope tracks actual cost, not the estimate.

---

## Quick start

### 1. Provision an account

```bash
curl -X POST https://gvnr.dev/v1/account
# { "api_key": "bg_...", "account_id": "..." }
```

### 2. Top up your governance-op quota

Pay-as-you-go: **~1,000 ops per $1**, any amount, USDC on Base. Open the pay page and pass your API key:

```
https://gvnr.dev/pay/starter?api_key=bg_YOUR_KEY
```

Send USDC to the address shown and paste your tx hash — ops are credited proportional to the amount received, after on-chain verification. Programmatic clients can submit the hash directly:

```bash
curl -X POST \
  -H "Authorization: Bearer bg_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tx_hash":"0x..."}' \
  https://gvnr.dev/v1/account/topup-verify/starter
# { "operations_remaining": 19000, "credited_ops": 19000, "credited_usd": 19 }
```

Or settle in one round-trip with an x402 client (Base MCP, AgentKit, x402-fetch) — name your own amount:

```
POST https://gvnr.dev/v1/account/topup?usd=5      # → 402 challenge → pay → 5,000 ops credited
```

### 3. Set a spend envelope for your agent

```bash
curl -X PUT \
  -H "Authorization: Bearer bg_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"my-agent","limit_usd":5,"window":"daily"}' \
  https://gvnr.dev/v1/budget/envelope
# { "success": true, "agent_id": "my-agent", "limit_usd": 5, "window": "daily" }
```

### 4. (optional) Set a rate envelope per (agent, provider, model)

```bash
curl -X PUT \
  -H "Authorization: Bearer bg_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"my-agent","provider":"anthropic","model":"claude-sonnet-4-6","requests_per_minute":30}' \
  https://gvnr.dev/v1/rate/envelope
```

### 5. Before each LLM request: `budget_clear`, then `rate_check`

```bash
curl -X POST \
  -H "Authorization: Bearer bg_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"my-agent","model":"claude-sonnet-4-6","estimated_tokens":2000}' \
  https://gvnr.dev/v1/budget/clear
# { "approved": true, "remaining_usd": 4.994, "operations_remaining": 18999 }

curl -X POST \
  -H "Authorization: Bearer bg_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"my-agent","provider":"anthropic","model":"claude-sonnet-4-6"}' \
  https://gvnr.dev/v1/rate/check
# { "allowed": true, "requests_remaining_this_minute": 29 }
```

### 6. (optional) Dedupe retries with `idempotency_check`

```bash
curl -X POST \
  -H "Authorization: Bearer bg_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key":"job-abc-123","ttl_seconds":3600}' \
  https://gvnr.dev/v1/idempotency/check
# First call:  { "is_first_call": true,  "ttl_remaining_seconds": 3600 }
# Replay:      { "is_first_call": false, "ttl_remaining_seconds": 3598 }
```

### 7. After the LLM responds, reconcile against actual usage

```bash
curl -X POST \
  -H "Authorization: Bearer bg_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"my-agent","actual_input_tokens":1800,"actual_output_tokens":2400}' \
  https://gvnr.dev/v1/budget/reconcile
# { "ok": true, "drift_usd": 0.003, "remaining_usd": 4.991, "operations_remaining": 18999 }
```

`reconcile` adjusts the **spend envelope** by the drift between your estimate and actual cost (the op quota is untouched). Anthropic, OpenAI, and Gemini all return `usage` fields with real token counts — pass those in to keep the envelope honest.

---

## MCP setup

Add to Claude Desktop or any MCP-compatible client:

```
https://gvnr.dev/mcp?api_key=bg_YOUR_KEY
```

### Claude Code

```bash
claude mcp add gvnr --transport http \
  "https://gvnr.dev/mcp?api_key=bg_YOUR_KEY"
```

### MCP tools

| Tool | Description |
|---|---|
| `budget_clear(agent_id, model, estimated_tokens)` | Check clearance against the op quota + spend envelope; burns one op |
| `set_envelope(agent_id, limit_usd, window?)` | Create or update an agent's USD spend cap |
| `get_balance()` | Remaining governance-operation quota (`operations_remaining`) |
| `reconcile(agent_id, actual_input_tokens, actual_output_tokens)` | Apply estimate-vs-actual drift to the spend envelope after the LLM responds |
| `set_rate_envelope(agent_id, provider, model, requests_per_minute)` | Allocate a per-(agent, provider, model) rate share |
| `rate_check(agent_id, provider, model)` | Approve or deny against the rate envelope; returns `retry_after_ms` on denial |
| `idempotency_check(key, ttl_seconds?)` | Dedupe retries on a caller-supplied key; returns `is_first_call` |
| `request_approval(agent_id, action_summary, ttl_seconds?)` | Open a human-in-the-loop approval request; returns an `approval_id` |
| `check_approval(approval_id)` | Poll an approval: `pending` / `approved` / `denied` / `timeout` |

---

## REST API

All endpoints except `POST /v1/account` require `Authorization: Bearer bg_YOUR_KEY`.

**TypeScript users:** generate full types from the live OpenAPI spec — `npx openapi-typescript@latest https://gvnr.dev/openapi.json -o types/gvnr.d.ts`. See [TYPESCRIPT.md](TYPESCRIPT.md) for the integration pattern (typed `fetch`, x402 topups, discriminated response unions).

### Account & top-up

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/account` | Provision account — returns `api_key` |
| `GET` | `/v1/account/balance` | Remaining governance-op quota (`operations_remaining`) |
| `GET` | `/v1/packs/:pack/info` | Public — preset details, USDC address, raw amount |
| `POST` | `/v1/account/topup-verify/:pack` | Submit tx hash → verify on-chain → credit (proportional to amount received) |
| `POST` | `/v1/account/topup?usd=<amount>` | x402-gated pay-as-you-go top-up — name your amount (min $1, max $100) |
| `POST` | `/v1/account/topup/:pack` | x402-gated preset top-up (machine clients) |

### Budget

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/budget/clear` | Clearance call — approve or deny |
| `POST` | `/v1/budget/reconcile` | Apply estimate-vs-actual drift to the envelope |
| `PUT` | `/v1/budget/envelope` | Create or update agent spend cap |
| `GET` | `/v1/budget/envelope/:agent_id` | Read envelope state |
| `DELETE` | `/v1/budget/envelope/:agent_id` | Delete an agent's envelope |

### Rate · Idempotency · Approval

| Method | Path | Description |
|---|---|---|
| `PUT` | `/v1/rate/envelope` | Set a per-(agent, provider, model) RPM share |
| `POST` | `/v1/rate/check` | Runtime rate check — `allowed` flag, `retry_after_ms` on denial |
| `POST` | `/v1/idempotency/check` | Dedupe on a caller-supplied key — `is_first_call` |
| `POST` | `/v1/approval/request` | Open a human approval request — returns `approval_id` |
| `GET` | `/v1/approval/check/:approval_id` | Poll decision: `pending` / `approved` / `denied` / `timeout` |

### Clearance response

```json
{ "approved": true, "remaining_usd": 4.994, "operations_remaining": 18999 }
```

```json
{ "approved": false, "remaining_usd": 0, "reason": "envelope_exceeded" }
```

Denial reasons: `no_credits` (op quota exhausted) · `no_envelope` (agent has no envelope) · `envelope_exceeded`

---

## Billing — governance ops, not your tokens

Gvnr charges for **governance operations**, not LLM usage. Your model tokens are billed by your provider; Gvnr never sees them.

Top-ups are **pay-as-you-go at ~1,000 ops/$1** in USDC on Base mainnet — send any amount and ops are credited proportionally after on-chain verification. The named packs below are just convenient presets:

| Preset | Price | Governance ops | Link |
|---|---|---|---|
| `starter` | $19 | 19,000 | `/pay/starter` |
| `growth` | $39 | 39,000 | `/pay/growth` |
| `studio` | $79 | 79,000 | `/pay/studio` |

Works with Base MCP, AgentKit, and any x402 client.

---

## Envelope windows

- `daily` — resets at UTC midnight each day
- `session` — never resets (use for one-shot tasks; caller-managed)

---

## Supported models

Model pricing is a static lookup on the hot path — no external calls. The envelope's cost estimate uses these per-million-token rates (USD):

| Model | Input | Output |
|---|---|---|
| `claude-opus-4-8` / `4-7` / `4-6` | $5 | $25 |
| `claude-sonnet-4-6` | $3 | $15 |
| `claude-haiku-4-5` | $1 | $5 |
| `gpt-4o` | $2.50 | $10 |
| `gpt-4o-mini` | $0.15 | $0.60 |
| `gpt-4-turbo` | $10 | $30 |
| `text-embedding-3-small` / `-large` | $0.02 / $0.13 | input-only |
| `gemini-embedding-001` / `-2` | $0.15 / $0.20 | input-only |

Embedding / input-only models are billed on input tokens — pass input tokens as `estimated_tokens` to `budget_clear`. Unknown models fall back to a conservative `$15 / $75` default.

---

## Network

| `X402_NETWORK` | Chain | Notes |
|---|---|---|
| `eip155:84532` | Base Sepolia | Testnet — safe for development |
| `eip155:8453` | Base mainnet | Real USDC |

Current deployment: **Base mainnet**.

---

## License

MIT — see [LICENSE](LICENSE).

The canonical hosted service is `https://gvnr.dev`. Self-hosted instances are unaffiliated.
