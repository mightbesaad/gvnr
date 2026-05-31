// Single source of truth for outward-facing repo links.
// Centralized after a rename left the old repo URL hardcoded in 13 places —
// every link to the old org 404'd post-migration and a full green
// test suite never noticed. A rename now touches ONE line; the hygiene check
// (scripts/check-hygiene.mjs) + the "no foreign github URL" test guard
// against regressions.
export const REPO_URL = 'https://github.com/mightbesaad/gvnr';
export const REPO_ISSUES_URL = `${REPO_URL}/issues`;
