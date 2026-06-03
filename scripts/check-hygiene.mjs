#!/usr/bin/env node
/**
 * Hygiene gate — fails if scrubbed identity terms reappear in the
 * public-bound budget-governor/ tree.
 *
 * This is the guard the 2026-05-31 migration wished it had: gvnrdev/kajaril
 * references had leaked into 13+ files and a fully-green test suite never
 * noticed (tests check function, not hygiene).
 *
 * Runs in two places:
 *   - pre-commit hook (scripts/hooks/pre-commit) on the private infra repo
 *   - CI (.github/workflows/test.yml) on the public repo
 *
 * Scope is identity WORDS only. Leaked secret *values* (API keys, tokens)
 * are gitleaks' job in CI — so this never false-positives on env-var NAMES
 * like X_CLIENT_ID.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Scrubbed identity terms that must never reappear in the public tree.
const DENY = [
  /kajaril/i,
  /gvnrdev/i,
  /\bAvvio\b/i,
  /\bTurnkey\b/i,
  /Bridge\.xyz/i,
  /Banking Circle/i,
  /\bEgypt\b/i,
];

// Narrow, temporary exceptions. Remove each when its condition clears.
const ALLOW = [];

// Tracked files we never scan as text. check-hygiene.mjs is self-excluded —
// it must spell out the forbidden terms to detect them (linters ignore their
// own config the same way).
const SKIP = /(^|\/)(package-lock\.json|check-hygiene\.mjs|.*\.(png|jpe?g|gif|ico|svg|webp|woff2?|ttf|otf))$/i;

const files = execSync('git ls-files', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => !SKIP.test(f));

const findings = [];
for (const f of files) {
  let text;
  try {
    text = readFileSync(join(root, f), 'utf8');
  } catch {
    continue; // unreadable/binary — skip
  }
  text.split('\n').forEach((line, i) => {
    if (ALLOW.some((re) => re.test(line))) return;
    for (const re of DENY) {
      if (re.test(line)) findings.push(`${f}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (findings.length) {
  console.error('✗ hygiene check FAILED — scrubbed identity terms in the public-bound tree:\n');
  for (const x of findings) console.error('  ' + x);
  console.error(
    '\nThese must not ship publicly. Remove them, or — if genuinely intentional —\n' +
      'add a narrow exception to ALLOW in scripts/check-hygiene.mjs.',
  );
  process.exit(1);
}
console.log(`✓ hygiene check passed (${files.length} files scanned, no scrubbed identity terms).`);
