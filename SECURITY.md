# Security Policy

## Reporting a Vulnerability

Open a GitHub issue: https://github.com/mightbesaad/gvnr/issues

Include a description of the issue, steps to reproduce, and any relevant context.

## Scope

- Authentication bypass on REST endpoints or MCP server
- Payment verification logic (`/v1/account/topup-verify/:pack`)
- KV key collision or unauthorized data access
- XSS in the pay page (`/pay/:pack`)
- Transaction replay vulnerabilities

## Out of Scope

- The known KV eventual-consistency race condition on concurrent `budget_clear` calls (accepted day-one limitation, documented in source)
- Issues with third-party dependencies (report upstream)
