# Contributing

## Bug reports and feature requests

Open a [GitHub issue](https://github.com/mightbesaad/gvnr/issues). Include steps to reproduce for bugs, or a clear use case for features.

## Pull requests

1. Fork the repo and create a branch from `main`
2. Run `npm test` — all 34 tests must pass
3. Run `npx tsc --noEmit` — no type errors
4. Open a PR with a clear description of what and why

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # set ADMIN_SECRET=dev-secret-local
npm test                          # runs against Miniflare (no real CF account needed)
```

To test against a real Cloudflare deployment, see [DEPLOY.md](DEPLOY.md).
