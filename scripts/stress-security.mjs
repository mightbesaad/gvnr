#!/usr/bin/env node
// Security & stress test for Budget Governor — runs against the live endpoint
//
// Usage:
//   node scripts/stress-security.mjs
//   BASE_URL=https://gvnr.dev ADMIN_SECRET=xxx node scripts/stress-security.mjs
//
// ADMIN_SECRET is optional. Tests that need it are skipped if unset.

const BASE = process.env.BASE_URL ?? 'https://gvnr.dev';
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? '';

// ── Terminal output ───────────────────────────────────────────────────────────

const c = {
  green:  s => `\x1b[32m✓ ${s}\x1b[0m`,
  red:    s => `\x1b[31m✗ ${s}\x1b[0m`,
  yellow: s => `\x1b[33m⚠ ${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  section: s => `\n\x1b[1m\x1b[34m── ${s} ──\x1b[0m`,
};

let passed = 0, failed = 0;

function ok(label) {
  console.log(c.green(label));
  passed++;
}

function fail(label, detail) {
  console.log(c.red(label) + (detail ? `\n  ${c.dim(detail)}` : ''));
  failed++;
}

function check(cond, label, detail) {
  cond ? ok(label) : fail(label, detail);
}

function skip(label) {
  console.log(c.yellow(`SKIP ${label}`));
}

function info(msg) {
  console.log(c.dim(`  ${msg}`));
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function req(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  try {
    const res = await fetch(`${BASE}${path}`, { ...opts, headers });
    let body;
    const ct = res.headers.get('content-type') ?? '';
    try { body = ct.includes('json') ? await res.json() : await res.text(); }
    catch { body = null; }
    return { status: res.status, body, headers: res.headers };
  } catch (err) {
    return { status: 0, body: null, error: err.message };
  }
}

async function createAccount() {
  const r = await req('/v1/account', { method: 'POST' });
  if (r.status !== 201) throw new Error(`createAccount failed: ${JSON.stringify(r.body)}`);
  return r.body; // { api_key, account_id }
}

async function seedCredits(apiKey, amountUsd) {
  const r = await req('/v1/admin/seed', {
    method: 'POST',
    headers: { 'X-Admin-Secret': ADMIN_SECRET },
    body: JSON.stringify({ api_key: apiKey, amount_usd: amountUsd }),
  });
  if (r.status !== 200) throw new Error(`seedCredits failed: ${JSON.stringify(r.body)}`);
}

async function setEnvelope(apiKey, agentId, limitUsd, window = 'daily') {
  return req('/v1/budget/envelope', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ agent_id: agentId, limit_usd: limitUsd, window }),
  });
}

async function clearance(apiKey, agentId, tokens, model = 'claude-sonnet-4-6') {
  return req('/v1/budget/clear', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ agent_id: agentId, model, estimated_tokens: tokens }),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testHealth() {
  console.log(c.section('1. Health'));
  const r = await req('/health');
  check(r.status === 200 && r.body?.ok === true, 'GET /health → 200 {ok:true}', JSON.stringify(r.body));
}

async function testAuthentication() {
  console.log(c.section('2. Authentication bypass'));

  // No auth header
  let r = await req('/v1/account/balance');
  check(r.status === 401, 'GET /balance (no auth) → 401');

  r = await req('/v1/budget/clear', { method: 'POST', body: '{}' });
  check(r.status === 401, 'POST /budget/clear (no auth) → 401');

  r = await req('/v1/budget/envelope', { method: 'PUT', body: '{}' });
  check(r.status === 401, 'PUT /budget/envelope (no auth) → 401');

  r = await req('/v1/budget/envelope/test-agent', { method: 'DELETE' });
  check(r.status === 401, 'DELETE /budget/envelope/:id (no auth) → 401');

  // Bad key
  r = await req('/v1/account/balance', {
    headers: { Authorization: 'Bearer bg_00000000000000000000000000000000' },
  });
  check(r.status === 401, 'GET /balance (wrong key) → 401');

  // Malformed — no "Bearer" prefix
  r = await req('/v1/account/balance', {
    headers: { Authorization: 'bg_rawkey' },
  });
  check(r.status === 401, 'GET /balance (missing "Bearer" prefix) → 401');

  // Empty bearer value
  r = await req('/v1/account/balance', {
    headers: { Authorization: 'Bearer ' },
  });
  check(r.status === 401, 'GET /balance (empty Bearer value) → 401');

  // SQL-injection-looking key
  r = await req('/v1/account/balance', {
    headers: { Authorization: "Bearer ' OR '1'='1" },
  });
  check(r.status === 401, "GET /balance (sql injection key) → 401");
}

async function testAdminProtection() {
  console.log(c.section('3. Admin endpoint protection'));

  // No secret
  let r = await req('/v1/admin/seed', {
    method: 'POST',
    body: JSON.stringify({ api_key: 'bg_fake00000000000000000000000000', amount_usd: 1000 }),
  });
  check(r.status === 401 || r.status === 403, `POST /admin/seed (no secret) → 401/403`, `got ${r.status}`);

  // Wrong secret
  r = await req('/v1/admin/seed', {
    method: 'POST',
    headers: { 'X-Admin-Secret': 'not-the-real-secret-abc123xyz' },
    body: JSON.stringify({ api_key: 'bg_fake00000000000000000000000000', amount_usd: 1000 }),
  });
  check(r.status === 401 || r.status === 403, `POST /admin/seed (wrong secret) → 401/403`, `got ${r.status}`);
}

async function testInputValidationEnvelope(apiKey) {
  console.log(c.section('4a. Input validation — envelope'));

  const auth = { Authorization: `Bearer ${apiKey}` };

  // agent_id
  let r = await req('/v1/budget/envelope', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ agent_id: '', limit_usd: 5, window: 'daily' }),
  });
  check(r.status === 400, 'PUT envelope: agent_id empty → 400');

  r = await req('/v1/budget/envelope', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ agent_id: 'a'.repeat(129), limit_usd: 5, window: 'daily' }),
  });
  check(r.status === 400, 'PUT envelope: agent_id 129 chars → 400');

  // limit_usd edge cases
  const limitCases = [
    [-1,        'limit_usd = -1'],
    [0,         'limit_usd = 0'],
    [1_000_001, 'limit_usd > 1,000,000'],
    [null,      'limit_usd = null'],
    ['five',    'limit_usd = "five"'],
  ];
  for (const [val, label] of limitCases) {
    r = await req('/v1/budget/envelope', {
      method: 'PUT', headers: auth,
      body: JSON.stringify({ agent_id: 'test-agent', limit_usd: val, window: 'daily' }),
    });
    check(r.status === 400, `PUT envelope: ${label} → 400`, `got ${r.status} body=${JSON.stringify(r.body)}`);
  }

  // Invalid window
  r = await req('/v1/budget/envelope', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ agent_id: 'test-agent', limit_usd: 5, window: 'monthly' }),
  });
  check(r.status === 400, 'PUT envelope: window = "monthly" → 400');

  // Malformed JSON body
  const rawRes = await fetch(`${BASE}/v1/budget/envelope`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: '{not: valid json}',
  });
  check(rawRes.status === 400, 'PUT envelope: malformed JSON body → 400');
}

async function testInputValidationClearance(apiKey) {
  console.log(c.section('4b. Input validation — clearance'));

  const auth = { Authorization: `Bearer ${apiKey}` };

  // agent_id
  let r = await req('/v1/budget/clear', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ agent_id: '', model: 'claude-sonnet-4-6', estimated_tokens: 1000 }),
  });
  check(r.status === 400, 'POST clear: agent_id empty → 400');

  r = await req('/v1/budget/clear', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ agent_id: 'a'.repeat(129), model: 'claude-sonnet-4-6', estimated_tokens: 1000 }),
  });
  check(r.status === 400, 'POST clear: agent_id 129 chars → 400');

  // estimated_tokens edge cases
  const tokenCases = [
    [0,        'estimated_tokens = 0'],
    [-1,       'estimated_tokens = -1'],
    [null,     'estimated_tokens = null'],
    ['1000',   'estimated_tokens = "1000" (string)'],
  ];
  for (const [val, label] of tokenCases) {
    r = await req('/v1/budget/clear', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ agent_id: 'test-agent', model: 'claude-sonnet-4-6', estimated_tokens: val }),
    });
    check(r.status === 400, `POST clear: ${label} → 400`, `got ${r.status}`);
  }

  // Missing model
  r = await req('/v1/budget/clear', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ agent_id: 'test-agent', estimated_tokens: 1000 }),
  });
  check(r.status === 400, 'POST clear: missing model → 400');
}

async function testPackValidation(apiKey) {
  console.log(c.section('5. Pack & path validation'));

  const auth = { Authorization: `Bearer ${apiKey}` };

  // Invalid pack names on topup
  let r = await req('/v1/account/topup/nonexistent', { method: 'POST', headers: auth });
  check(r.status === 400 && r.body?.error === 'invalid_pack', 'POST topup/nonexistent → 400 invalid_pack');

  // Pack info endpoint
  r = await req('/v1/packs/nonexistent/info');
  check(r.status === 404, 'GET /v1/packs/nonexistent/info → 404');

  // Pay page — unknown pack
  const payUnknown = await fetch(`${BASE}/pay/unknown`);
  check(payUnknown.status === 404, 'GET /pay/unknown → 404');

  // Path traversal — encoded
  const traversal = await fetch(`${BASE}/pay/..%2Fadmin`);
  check(traversal.status === 404 || traversal.status === 400,
    'GET /pay/..%2Fadmin (path traversal attempt) → 404/400', `got ${traversal.status}`);

  // topup-verify with invalid pack
  r = await req('/v1/account/topup-verify/fakepack', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ tx_hash: '0x' + 'a'.repeat(64) }),
  });
  check(r.status === 400 && r.body?.error === 'invalid_pack',
    'POST topup-verify/fakepack → 400 invalid_pack');
}

async function testXssProtection() {
  console.log(c.section('6. XSS protection — pay page'));

  // api_key with HTML injection
  const xss1 = await fetch(`${BASE}/pay/starter?api_key=${encodeURIComponent('x"><script>alert(1)</script>')}`);
  check(xss1.status === 400, 'GET /pay/starter?api_key=<xss> → 400');

  // api_key wrong format (underscore wrong position)
  const xss2 = await fetch(`${BASE}/pay/starter?api_key=notbg_format_here`);
  check(xss2.status === 400, 'GET /pay/starter?api_key=wrong_format → 400');

  // api_key with null bytes
  const xss3 = await fetch(`${BASE}/pay/starter?api_key=bg_%00injection`);
  check(xss3.status === 400 || xss3.status === 200,
    'GET /pay/starter?api_key=<null_byte> → 400 or sanitized (not 500)', `got ${xss3.status}`);

  // Valid format passes through
  const valid = await fetch(`${BASE}/pay/starter?api_key=bg_${'a'.repeat(32)}`);
  check(valid.status === 200, 'GET /pay/starter?api_key=<valid_format> → 200');
}

async function testReplayProtection(apiKey) {
  console.log(c.section('7. Replay & tx hash validation'));

  const auth = { Authorization: `Bearer ${apiKey}` };

  // Invalid tx hash format
  let r = await req('/v1/account/topup-verify/starter', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ tx_hash: 'not-a-hash' }),
  });
  check(r.status === 400 && r.body?.error === 'invalid_tx_hash', 'topup-verify: invalid hash format → invalid_tx_hash');

  // Too short
  r = await req('/v1/account/topup-verify/starter', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ tx_hash: '0x1234' }),
  });
  check(r.status === 400 && r.body?.error === 'invalid_tx_hash', 'topup-verify: too-short hash → invalid_tx_hash');

  // Valid format but fake tx — should fail at RPC (not dedup), meaning the tx is NOT marked used
  const FAKE_TX = '0x' + 'deadbeef'.repeat(8); // 64 hex chars
  r = await req('/v1/account/topup-verify/starter', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ tx_hash: FAKE_TX }),
  });
  const rejectReason = r.body?.error;
  check(
    r.status === 400 && (rejectReason === 'tx_not_found' || rejectReason === 'rpc_error'),
    `topup-verify: fake tx → tx_not_found or rpc_error (not already_used)`,
    `got error=${rejectReason}`,
  );

  // Submit same fake tx again — dedup should NOT fire (tx was never credited, so never marked used)
  r = await req('/v1/account/topup-verify/starter', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ tx_hash: FAKE_TX }),
  });
  check(
    r.status === 400 && r.body?.error !== 'already_used',
    'Rejected tx is NOT marked as used — second submit still gets tx_not_found/rpc_error',
    `got error=${r.body?.error}`,
  );
}

// ── Stress tests ──────────────────────────────────────────────────────────────

async function testNoCreditsConcurrency(apiKey) {
  // Test that concurrent clearances on a zero-balance account all correctly deny.
  // No ADMIN_SECRET needed — fresh account has balance 0.
  console.log(c.section('8. Stress: zero-balance concurrent clearances'));

  // Set an envelope so denials come from no_credits, not no_envelope
  await setEnvelope(apiKey, 'stress-nocredits', 100);

  const CONCURRENCY = 20;
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      clearance(apiKey, 'stress-nocredits', 1000)
    )
  );

  const allOk = results.every(r => r.status === 200);
  const allDenied = results.every(r => r.body?.approved === false && r.body?.reason === 'no_credits');

  check(allOk, `All ${CONCURRENCY} concurrent clearances returned HTTP 200`);
  check(allDenied, `All ${CONCURRENCY} denied with no_credits (balance = 0 is atomic gate)`);
}

async function testEnvelopeOverdraft(apiKey) {
  // Verify the DO's serial processing prevents envelope overspend.
  // 20 concurrent clearances, each costing $0.075 (5K tokens × sonnet $15/M),
  // against a $0.50 envelope. Max 6 approvals possible; remainder must be denied.
  console.log(c.section('9. Stress: envelope spend atomicity (DO serial model)'));

  if (!ADMIN_SECRET) {
    skip('requires ADMIN_SECRET — set env var and rerun');
    return;
  }

  const AGENT = `stress-envelope-${Date.now()}`;
  const ENVELOPE_LIMIT = 0.50;   // $0.50
  const TOKENS_PER_CALL = 5_000; // $0.075 each (sonnet: $15/1M)
  const COST_PER_CALL = (TOKENS_PER_CALL / 1_000_000) * 15;
  const CONCURRENCY = 20;
  const MAX_APPROVALS = Math.floor(ENVELOPE_LIMIT / COST_PER_CALL); // 6

  await seedCredits(apiKey, 5.00); // enough balance so no_credits never fires
  await setEnvelope(apiKey, AGENT, ENVELOPE_LIMIT);

  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      clearance(apiKey, AGENT, TOKENS_PER_CALL)
    )
  );

  const approved = results.filter(r => r.body?.approved === true).length;
  const deniedEnvelope = results.filter(r => r.body?.reason === 'envelope_exceeded').length;
  const errors = results.filter(r => r.status !== 200).length;
  const totalSpent = approved * COST_PER_CALL;

  check(errors === 0, `All ${CONCURRENCY} requests returned HTTP 200 (no 500s)`);
  check(approved <= MAX_APPROVALS, `Approvals (${approved}) ≤ max possible (${MAX_APPROVALS}) — envelope not overdrawn`);
  check(totalSpent <= ENVELOPE_LIMIT + 0.0001, `Spent ($${totalSpent.toFixed(4)}) ≤ limit ($${ENVELOPE_LIMIT}) — DO serial model held`);
  check(approved + deniedEnvelope === CONCURRENCY, `approved (${approved}) + denied (${deniedEnvelope}) = ${CONCURRENCY} — no lost responses`);

  info(`${approved} approved · ${deniedEnvelope} denied · $${totalSpent.toFixed(4)} spent · limit $${ENVELOPE_LIMIT}`);

  // Verify envelope state via GET
  const envRes = await req(`/v1/budget/envelope/${AGENT}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const remaining = envRes.body?.remaining_usd ?? -1;
  check(remaining >= 0, `GET envelope remaining_usd (${remaining}) ≥ 0`);
  check(remaining <= ENVELOPE_LIMIT, `GET envelope remaining_usd (${remaining}) ≤ limit (${ENVELOPE_LIMIT})`);
}

async function testColdStartConcurrency() {
  console.log(c.section('10. Stress: cold DO start under concurrency'));

  // Fresh account = new DO instance never accessed before
  const { api_key } = await createAccount();

  // Immediately fire 10 concurrent balance requests before the DO warms up
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      req('/v1/account/balance', { headers: { Authorization: `Bearer ${api_key}` } })
    )
  );

  const allOk = results.every(r => r.status === 200);
  const allZero = results.every(r => r.body?.balance_usd === 0);
  const balances = results.map(r => r.body?.balance_usd);

  check(allOk, '10 concurrent balance reads on cold DO → all 200');
  check(allZero, 'All return balance_usd = 0 (no data race on init)');

  const unique = new Set(balances.map(b => JSON.stringify(b)));
  check(unique.size === 1, `All responses agree on same balance (${[...unique].join(', ')})`);
}

async function testRateLimitNote() {
  console.log(c.section('11. Rate limit (informational)'));
  // Note: the account creation rate limit (10/hour/IP via KV read-modify-write)
  // is NOT atomic — concurrent creates could bypass it. Not tested here to avoid
  // consuming quota, but the KV implementation in account.ts is a known gap.
  skip('Rate limit exhaustion test skipped — would consume 10/hour IP quota');
  info('Known gap: KV read-modify-write in POST /v1/account is not atomic under concurrency');
  info('Concurrent burst could exceed 10/hour limit. Mitigation: use CF rate limiting rules instead.');
}

// ── Security finding note ─────────────────────────────────────────────────────

function printFindings() {
  console.log(`\n${c.bold('Security findings / behavioral notes:')}`);
  console.log(c.yellow('Balance is never decremented on clearance'));
  console.log(c.dim('  runClearance() checks balance > 0 but does not deduct it.'));
  console.log(c.dim('  A single top-up gives unlimited clearance calls (gated only by daily envelope limits).'));
  console.log(c.dim('  Intentional if this is a "pay-to-unlock" model; a bug if pay-per-use was intended.'));

  console.log(c.yellow('KV rate limiter on account creation is non-atomic'));
  console.log(c.dim('  POST /v1/account does KV.get → increment → KV.put (not CAS).'));
  console.log(c.dim('  A burst of concurrent creates from the same IP could exceed the 10/hour limit.'));
  console.log(c.dim('  Fix: use Cloudflare Rate Limiting rules (WAF) instead of KV counters.'));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(c.bold('\nBudget Governor — Security & Stress Test'));
  console.log(`Target: ${c.bold(BASE)}`);
  if (!ADMIN_SECRET) console.log(c.yellow('ADMIN_SECRET not set — envelope overdraft test will be skipped'));

  let mainAccount;
  try {
    mainAccount = await createAccount();
  } catch (err) {
    console.error(c.red(`Failed to create test account: ${err.message}`));
    process.exit(2);
  }

  const { api_key } = mainAccount;

  await testHealth();
  await testAuthentication();
  await testAdminProtection();
  await testInputValidationEnvelope(api_key);
  await testInputValidationClearance(api_key);
  await testPackValidation(api_key);
  await testXssProtection();
  await testReplayProtection(api_key);
  await testNoCreditsConcurrency(api_key);
  await testEnvelopeOverdraft(api_key);
  await testColdStartConcurrency();
  await testRateLimitNote();

  printFindings();

  const total = passed + failed;
  const color = failed > 0 ? '\x1b[31m' : '\x1b[32m';
  console.log(`\n${c.bold('Results:')} ${color}${passed}/${total} passed\x1b[0m${failed > 0 ? `, \x1b[31m${failed} failed\x1b[0m` : ''}\n`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(c.red(`Fatal: ${err.message}`));
  process.exit(2);
});
