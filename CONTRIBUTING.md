# Contributing to Gvnr

Gvnr is currently maintained by a solo founder. Contributions are welcome — pull requests, issues, and discussion posts all land in the same place.

## Quick start

```bash
git clone https://github.com/mightbesaad/gvnr
cd gvnr
npm install
npm test
```

The full test suite should pass. If it doesn't, that's a real signal — open an issue with your environment details.

## Hygiene & hooks

This repo guards against accidentally shipping private/identity strings:

```bash
git config core.hooksPath budget-governor/scripts/hooks   # one-time, from the infra repo root
```

That enables a pre-commit gate (`scripts/check-hygiene.mjs`) that fails if scrubbed identity terms reappear. CI runs the same check plus `gitleaks` for secret values. Run it manually any time with `node scripts/check-hygiene.mjs`.

## What's useful right now

- Bug reports against any of the five primitives (Budget Governor, Reconciler, Rate Limit Coordinator, Idempotency, Approval Bridge)
- MCP client compatibility reports (Claude Desktop, Cursor, any MCP host) — what works, what doesn't
- Documentation improvements, especially for the integration path
- TypeScript types feedback once the OpenAPI-generated types ship

## What's not in scope yet

- A bundled SDK package — gated on prospect ask or LangChain signal (see roadmap)
- Self-hosted deployment guide — gvnr.dev runs hosted-only by design

## Filing an issue

For bugs: include the endpoint you called, the response you got, and the timestamp. For features: open a Discussion first; we'll move it to an issue once the design is clear.

## Code of conduct

Be useful. Be honest. That's it.
