# Contributing to Gvnr

Gvnr is currently maintained by a solo founder. Contributions are welcome — pull requests, issues, and discussion posts all land in the same place.

## Quick start

```bash
git clone https://github.com/mightbesaad/gvnr
cd gvnr
npm install
npm test
```

100/100 tests should pass. If they don't, that's a real signal — open an issue with your environment details.

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
