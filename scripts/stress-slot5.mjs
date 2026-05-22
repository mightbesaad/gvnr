#!/usr/bin/env node
// Slot 5 (Agent Approval Bridge) stress + security test — runs against the live endpoint.
//
// Usage:
//   node scripts/stress-slot5.mjs
//   BASE_URL=https://gvnr.dev node scripts/stress-slot5.mjs

const BASE = process.env.BASE_URL ?? 'https://gvnr.dev';

const c = {
  green:  s => `\x1b[32m✓ ${s}\x1b[0m`,
  red:    s => `\x1b[31m✗ ${s}\x1b[0m`,
  yellow: s => `\x1b[33m⚠ ${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  section: s => `\n\x1b[1m\x1b[34m── ${s} ──\x1b[0m`,
};

let passed = 0, failed = 0, warned = 0;
const findings = [];

function ok(label)         { console.log(c.green(label)); passed++; }
function fail(label, why)  { console.log(c.red(label) + (why ? `\n  ${c.dim(why)}` : '')); failed++; findings.push({ label, why }); }
function warn(label, why)  { console.log(c.yellow('⚠ ' + label) + (why ? `\n  ${c.dim(why)}` : '')); warned++; findings.push({ label, why, soft: true }); }
function check(cond, label, why) { cond ? ok(label) : fail(label, why); }
function info(msg)         { console.log(c.dim(`  ${msg}`)); }

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

async function provisionAccount() {
  const r = await req('/v1/account', { method: 'POST' });
  if (r.status !== 201) throw new Error(`provisionAccount failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}

async function setNotificationEmail(apiKey, email) {
  return req('/v1/account/notification-email', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ email }),
  });
}

async function requestApproval(apiKey, body) {
  return req('/v1/approval/request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
}

async function checkApproval(apiKey, approvalId) {
  return req(`/v1/approval/check/${encodeURIComponent(approvalId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

async function decide(approvalId, decision, headers = {}) {
  return req(`/approve/${encodeURIComponent(approvalId)}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: `decision=${encodeURIComponent(decision)}`,
  });
}

// Each section that hits request_approval should provision a fresh account so
// we don't bleed quota across sections (APPROVAL_RATE_LIMITER = 30/min/account).
async function freshSetup() {
  const { api_key } = await provisionAccount();
  await setNotificationEmail(api_key, 'stress@example.com');
  return api_key;
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(c.bold(`Slot 5 stress test against ${BASE}`));

  // ── Section 1: Token entropy + URL shape ──────────────────────────────────
  console.log(c.section('Token entropy + URL shape'));
  let apiKey = await freshSetup();

  const ids = new Set();
  let nonUrlSafe = 0;
  let wrongLength = 0;
  const SAMPLE = 25;
  for (let i = 0; i < SAMPLE; i++) {
    const r = await requestApproval(apiKey, { agent_id: 'a', action_summary: 'x', ttl_seconds: 600 });
    if (r.status !== 200) { fail(`token sample ${i} request failed`, JSON.stringify(r.body)); continue; }
    const id = r.body.approval_id;
    ids.add(id);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) nonUrlSafe++;
    if (id.length !== 22) wrongLength++;
  }
  check(ids.size === SAMPLE, `${SAMPLE} unique tokens generated`, `got ${ids.size} unique out of ${SAMPLE}`);
  check(nonUrlSafe === 0, 'all tokens are URL-safe base64 (A-Za-z0-9_-)', `${nonUrlSafe} non-conforming`);
  check(wrongLength === 0, 'all tokens are 22 chars (16 bytes base64url)', `${wrongLength} wrong length`);

  const r1 = await requestApproval(apiKey, { agent_id: 'a', action_summary: 'x', ttl_seconds: 600 });
  check(r1.body.approval_url === `${BASE}/approve/${r1.body.approval_id}`, 'approval_url matches origin + /approve/{id}', `got ${r1.body.approval_url}`);

  // ── Section 2: Auth boundary ──────────────────────────────────────────────
  console.log(c.section('Auth boundary on /v1/approval/*'));
  apiKey = await freshSetup();
  const noAuth = await req('/v1/approval/check/whatever');
  check(noAuth.status === 401, '/v1/approval/check requires auth', `got ${noAuth.status}`);

  const noAuthReq = await req('/v1/approval/request', { method: 'POST', body: JSON.stringify({}) });
  check(noAuthReq.status === 401, '/v1/approval/request requires auth', `got ${noAuthReq.status}`);

  const noAuthEmail = await req('/v1/account/notification-email', { method: 'POST', body: JSON.stringify({ email: 'x@y.z' }) });
  check(noAuthEmail.status === 401, '/v1/account/notification-email requires auth', `got ${noAuthEmail.status}`);

  // Cross-account isolation
  const { api_key: apiKeyB } = await provisionAccount();
  const targetReq = await requestApproval(apiKey, { agent_id: 'a', action_summary: 'private summary do not leak', ttl_seconds: 600 });
  const targetId = targetReq.body.approval_id;
  const crossCheck = await checkApproval(apiKeyB, targetId);
  check(crossCheck.status === 404, 'account B cannot poll account A approval (404)', `got ${crossCheck.status}, body=${JSON.stringify(crossCheck.body).slice(0, 200)}`);

  // ── Section 3: Bearer-URL model on /approve/* ─────────────────────────────
  console.log(c.section('Bearer-URL model on /approve/*'));
  apiKey = await freshSetup();
  const pageReq = await requestApproval(apiKey, { agent_id: 'a', action_summary: 'page test', ttl_seconds: 600 });
  const pageId = pageReq.body.approval_id;

  const page = await req(`/approve/${pageId}`);
  check(page.status === 200, 'GET /approve/{id} returns 200 without API key (URL is the auth)', `got ${page.status}`);
  check(typeof page.body === 'string' && page.body.includes('Approve agent action?'), 'pending page rendered', '');
  check(page.headers.get('content-security-policy')?.includes("script-src 'none'"), "CSP includes script-src 'none'", `got: ${page.headers.get('content-security-policy')}`);
  check(page.headers.get('cache-control')?.includes('no-store'), 'Cache-Control: no-store on approval page', `got: ${page.headers.get('cache-control')}`);
  check(page.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff', `got: ${page.headers.get('x-content-type-options')}`);
  check(page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), "CSP includes frame-ancestors 'none' (clickjacking)", `got: ${page.headers.get('content-security-policy')}`);
  check(page.headers.get('referrer-policy') === 'no-referrer', 'Referrer-Policy: no-referrer (token does not leak via Referer)', `got: ${page.headers.get('referrer-policy')}`);

  // GET /approve with unknown id → 404 page
  const unknown = await req('/approve/totally_unknown_token');
  check(unknown.status === 404, 'GET /approve/{unknown} returns 404', `got ${unknown.status}`);
  check(typeof unknown.body === 'string' && unknown.body.includes('Approval not found'), '404 page renders Not Found copy', '');

  // ── Section 4: Input validation edges ─────────────────────────────────────
  console.log(c.section('Input validation edges'));
  apiKey = await freshSetup();
  const cases = [
    { name: 'empty agent_id',          body: { agent_id: '', action_summary: 'x' } },
    { name: 'agent_id at 128 chars',   body: { agent_id: 'a'.repeat(128), action_summary: 'x' }, expectOk: true },
    { name: 'agent_id at 129 chars',   body: { agent_id: 'a'.repeat(129), action_summary: 'x' } },
    { name: 'empty action_summary',    body: { agent_id: 'a', action_summary: '' } },
    { name: 'action_summary at 280',   body: { agent_id: 'a', action_summary: 'y'.repeat(280) }, expectOk: true },
    { name: 'action_summary at 281',   body: { agent_id: 'a', action_summary: 'y'.repeat(281) } },
    { name: 'ttl=0',                   body: { agent_id: 'a', action_summary: 'x', ttl_seconds: 0 } },
    { name: 'ttl=-1',                  body: { agent_id: 'a', action_summary: 'x', ttl_seconds: -1 } },
    { name: 'ttl > 7 days',            body: { agent_id: 'a', action_summary: 'x', ttl_seconds: 7 * 86400 + 1 } },
    { name: 'ttl float',               body: { agent_id: 'a', action_summary: 'x', ttl_seconds: 1.5 } },
    { name: 'missing agent_id',        body: { action_summary: 'x' } },
    { name: 'missing action_summary',  body: { agent_id: 'a' } },
    { name: 'empty channels',          body: { agent_id: 'a', action_summary: 'x', channels: [] } },
    { name: 'unknown channel',         body: { agent_id: 'a', action_summary: 'x', channels: ['fax'] } },
    { name: 'unimplemented channel telegram', body: { agent_id: 'a', action_summary: 'x', channels: ['telegram'] }, expectError: 'channel_not_implemented' },
    { name: 'mixed valid + unimplemented',    body: { agent_id: 'a', action_summary: 'x', channels: ['email', 'sms'] }, expectError: 'channel_not_implemented' },
  ];
  for (const tc of cases) {
    const r = await requestApproval(apiKey, tc.body);
    if (tc.expectOk) {
      check(r.status === 200, `accepts ${tc.name} (boundary)`, `got ${r.status}, body=${JSON.stringify(r.body).slice(0, 200)}`);
    } else if (tc.expectError) {
      check(r.status === 400 && r.body?.error === tc.expectError, `rejects ${tc.name} with ${tc.expectError}`, `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    } else {
      check(r.status === 400, `rejects ${tc.name}`, `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
  }

  // notification_email not set
  const { api_key: apiKeyC } = await provisionAccount();
  const noEmailReq = await requestApproval(apiKeyC, { agent_id: 'a', action_summary: 'x', ttl_seconds: 600 });
  check(noEmailReq.status === 400 && noEmailReq.body?.error === 'notification_email_unset', 'rejects with notification_email_unset when account has no email', `got ${noEmailReq.status} ${JSON.stringify(noEmailReq.body).slice(0, 200)}`);

  // ── Section 5: XSS / HTML injection ───────────────────────────────────────
  console.log(c.section('XSS / HTML injection on approval page'));
  apiKey = await freshSetup();
  const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const xssReq = await requestApproval(apiKey, { agent_id: 'a<b>c', action_summary: xss, ttl_seconds: 600 });
  check(xssReq.status === 200, 'XSS payload in action_summary accepted (will be escaped on render)', JSON.stringify(xssReq.body).slice(0, 200));
  const xssId = xssReq.body.approval_id;
  const xssPage = await req(`/approve/${xssId}`);
  check(typeof xssPage.body === 'string', 'approval page returned HTML', '');
  check(!xssPage.body.includes('<script>alert(1)</script>'), '<script> tag escaped (no raw injection)', 'raw script tag present in HTML output');
  check(!/<img\s+src=x/i.test(xssPage.body), '<img> tag escaped (no raw HTML element)', 'raw <img> tag with src=x reaches the page');
  check(xssPage.body.includes('&lt;script&gt;'), 'angle brackets HTML-escaped', '');
  check(xssPage.body.includes('&lt;img'), '<img tag entity-encoded', '');

  // ── Section 6: Repeat decide / race ───────────────────────────────────────
  console.log(c.section('Repeat decide & race'));
  apiKey = await freshSetup();
  const rd = await requestApproval(apiKey, { agent_id: 'a', action_summary: 'repeat test', ttl_seconds: 600 });
  const rdId = rd.body.approval_id;
  const first1 = await decide(rdId, 'approved');
  check(first1.status === 200 && first1.body.includes('Approved'), 'first decide (approve) returns 200 + approved page', '');

  const second = await decide(rdId, 'denied');
  check(second.status === 200, 'repeat decide returns 200 (idempotent terminal page)', `got ${second.status}`);
  check(second.body.includes('Approved') && !second.body.includes('class="state state-denied"'), 'state remains approved (not flipped to denied)', '');

  const cs = await checkApproval(apiKey, rdId);
  check(cs.body?.decision === 'approved', 'check reports approved after repeated decide attempts', `got ${cs.body?.decision}`);

  // Race: two simultaneous decides on a fresh approval
  const race = await requestApproval(apiKey, { agent_id: 'a', action_summary: 'race', ttl_seconds: 600 });
  const raceId = race.body.approval_id;
  const [r1a, r1b] = await Promise.all([decide(raceId, 'approved'), decide(raceId, 'denied')]);
  const finalState = await checkApproval(apiKey, raceId);
  check(finalState.body?.decision === 'approved' || finalState.body?.decision === 'denied',
       `concurrent decide resolves to a single decision (got ${finalState.body?.decision})`,
       `r1a=${r1a.status} r1b=${r1b.status}`);
  warn('KV decide has no CAS — last-write-wins on simultaneous taps from two tabs',
       'mitigation would require DO. Acceptable for V1: a single human is extremely unlikely to tap two tabs within the same RTT.');

  // ── Section 7: Decide endpoint variants ───────────────────────────────────
  console.log(c.section('Decide endpoint shape'));
  apiKey = await freshSetup();
  const sh = await requestApproval(apiKey, { agent_id: 'a', action_summary: 'shape test', ttl_seconds: 600 });
  const shId = sh.body.approval_id;

  // Invalid decision value
  const badDecision = await req(`/approve/${shId}/decide`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'decision=maybe',
  });
  check(badDecision.status === 400, 'rejects decision=maybe with 400', `got ${badDecision.status}`);

  // Empty body
  const emptyBody = await req(`/approve/${shId}/decide`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '',
  });
  check(emptyBody.status === 400, 'rejects empty body with 400', `got ${emptyBody.status}`);

  // JSON body should also work per route handler
  const jsonBody = await req(`/approve/${shId}/decide`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }),
  });
  check(jsonBody.status === 200, 'JSON body also accepted on decide endpoint', `got ${jsonBody.status}`);

  // No content-type at all
  const noCT = await req(`/approve/${shId}/decide`, {
    method: 'POST', headers: {}, body: 'decision=approved',
  });
  // Once the approval is decided (above), subsequent decides return 200 with terminal page.
  check(noCT.status === 200 || noCT.status === 400, 'decide without Content-Type does not crash', `got ${noCT.status}`);

  // GET on decide endpoint → 405-ish (Hono returns 404 for wrong method on path)
  const wrongMethod = await req(`/approve/${shId}/decide`);
  check([404, 405].includes(wrongMethod.status), 'GET on /approve/{id}/decide is not allowed', `got ${wrongMethod.status}`);

  // ── Section 8: Notification email validation ──────────────────────────────
  console.log(c.section('Notification email validation'));
  const emailKey = (await provisionAccount()).api_key;
  const emailCases = [
    { name: 'plain valid',                email: 'a@b.co',                       expectOk: true },
    { name: 'subaddress (+)',             email: 'a+tag@b.co',                   expectOk: true },
    { name: 'no @',                       email: 'plain',                        expectOk: false },
    { name: 'whitespace',                 email: 'a @b.co',                      expectOk: false },
    { name: 'no domain dot',              email: 'a@b',                          expectOk: false },
    { name: 'huge local',                 email: 'a'.repeat(255) + '@b.co',      expectOk: false },
    { name: 'unicode TLD',                email: 'a@b.παράδειγμα',                expectOk: true },
  ];
  for (const tc of emailCases) {
    const r = await setNotificationEmail(emailKey, tc.email);
    if (tc.expectOk) check(r.status === 200, `accepts ${tc.name}: ${tc.email}`, `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    else check(r.status === 400, `rejects ${tc.name}: ${tc.email}`, `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  // DELETE notification email
  await setNotificationEmail(emailKey, 'real@example.com');
  const delRes = await req('/v1/account/notification-email', {
    method: 'DELETE', headers: { Authorization: `Bearer ${emailKey}` },
  });
  check(delRes.status === 200, 'DELETE notification-email returns 200', `got ${delRes.status}`);
  const afterDel = await req('/v1/account/notification-email', { headers: { Authorization: `Bearer ${emailKey}` } });
  check(afterDel.body?.notification_email === null, 'GET returns null after DELETE', `got ${JSON.stringify(afterDel.body)}`);

  // ── Section 9: TTL boundary — timeout state ───────────────────────────────
  console.log(c.section('TTL boundary'));
  apiKey = await freshSetup();
  const timeoutReq = await requestApproval(apiKey, { agent_id: 'a', action_summary: 'timeout test', ttl_seconds: 1 });
  if (timeoutReq.status === 200) {
    const tId = timeoutReq.body.approval_id;
    await new Promise((r) => setTimeout(r, 1500));
    const tCheck = await checkApproval(apiKey, tId);
    check(tCheck.status === 200 && tCheck.body?.decision === 'timeout', 'check returns timeout after expires_at', `got ${tCheck.status} ${JSON.stringify(tCheck.body).slice(0, 200)}`);

    // Decide attempt on timed-out approval — fire-and-forget; we just verify state after
    await decide(tId, 'approved');
    const afterLate = await checkApproval(apiKey, tId);
    check(afterLate.body?.decision === 'timeout', 'cannot decide after timeout — state stays timeout', `got ${afterLate.body?.decision}`);
  } else {
    fail('could not create ttl=1 approval', JSON.stringify(timeoutReq.body));
  }

  // ── Section 10: Credit accounting (gap discovery) ─────────────────────────
  console.log(c.section('Credit accounting'));
  apiKey = await freshSetup();
  const balanceBefore = await req('/v1/account/balance', { headers: { Authorization: `Bearer ${apiKey}` } });
  // Fire a few approval calls
  const ca1 = await requestApproval(apiKey, { agent_id: 'a', action_summary: 'credit test 1', ttl_seconds: 600 });
  await checkApproval(apiKey, ca1.body.approval_id);
  const balanceAfter = await req('/v1/account/balance', { headers: { Authorization: `Bearer ${apiKey}` } });
  if (balanceBefore.body?.balance_usd === balanceAfter.body?.balance_usd) {
    warn('request_approval + check_approval do NOT debit credits',
         `pricing page implies '10k tool calls' covers all tools, but Slot 5 tools (and rate_check, idempotency_check) bypass the credit pool. Decision needed: (a) make pricing honest ("clearances cost credits, ancillary tools free"), or (b) add debit hook to ancillary tools. Not a Slot 5 bug — long-standing inconsistency surfaced here.`);
  } else {
    ok('approval tools debit credits as expected');
  }

  // ── Section 11: Rate limiting on request_approval ─────────────────────────
  console.log(c.section('Rate limiting / spam protection'));
  // Fresh account so we don't inherit budget from earlier sections (this account already
  // received ~60+ approval requests above; counter would be saturated).
  const { api_key: rlKey } = await provisionAccount();
  await setNotificationEmail(rlKey, 'rl-test@example.com');
  const rateBatch = await Promise.all(Array.from({ length: 45 }, (_, i) =>
    requestApproval(rlKey, { agent_id: 'a', action_summary: `burst ${i}`, ttl_seconds: 600 })));
  const oks = rateBatch.filter((r) => r.status === 200).length;
  const limited = rateBatch.filter((r) => r.status === 429).length;
  info(`burst of 45 request_approval calls on a fresh account: ${oks} OK, ${limited} 429-rate-limited`);
  check(limited > 0, 'request_approval is rate-limited per account',
       'no 429s seen after 45 calls — APPROVAL_RATE_LIMITER may be misconfigured or unbound');

  // ── Section 12: Idempotency gap ───────────────────────────────────────────
  console.log(c.section('Idempotency'));
  apiKey = await freshSetup();
  const idempA = await requestApproval(apiKey, { agent_id: 'agent-x', action_summary: 'dupe-test', ttl_seconds: 600 });
  const idempB = await requestApproval(apiKey, { agent_id: 'agent-x', action_summary: 'dupe-test', ttl_seconds: 600 });
  if (idempA.body?.approval_id === idempB.body?.approval_id) {
    ok('identical request_approval params return the same approval_id');
  } else {
    warn('identical request_approval params create distinct approvals (no built-in idempotency)',
         'documented in MCP tool description; callers can gate retries with idempotency_check. Acceptable since the idempotency_check tool exists for this. Just verifying the documented behavior.');
  }

  // ── Section 13: Malformed approval_id paths ───────────────────────────────
  console.log(c.section('Malformed approval_id handling'));
  apiKey = await freshSetup();
  const badIds = [
    // '..' alone is client-normalized to parent dir by fetch/curl — never reaches the handler.
    // Test only ids that actually transit to the server.
    '../../etc/passwd',
    '%00',
    'a'.repeat(2000),
    'with spaces',
    'with/slash',
    "with'quote",
    'has$pecial!chars',
  ];
  for (const bad of badIds) {
    const r1 = await checkApproval(apiKey, bad);
    const r2 = await req(`/approve/${encodeURIComponent(bad)}`);
    // 400 is also a fine response — Hono path-matcher may reject before our handler. Goal: NEVER 500.
    check([400, 404].includes(r1.status), `check_approval handles malformed id (${bad.slice(0, 30)})`, `got ${r1.status}`);
    check([400, 404].includes(r2.status), `/approve/{bad} handles malformed id (${bad.slice(0, 30)})`, `got ${r2.status}`);
  }

  // ── Section 14: MCP card + agent-skills declares the new tools ────────────
  console.log(c.section('MCP card surface'));
  const card = await req('/.well-known/mcp.json');
  const cardTools = card.body?.tools?.map(t => t.name) ?? [];
  check(cardTools.includes('request_approval'), 'mcp.json declares request_approval', `tools: ${cardTools.join(',')}`);
  check(cardTools.includes('check_approval'),   'mcp.json declares check_approval',   `tools: ${cardTools.join(',')}`);
  check(card.body?.name === 'Gvnr',             'mcp.json name = "Gvnr"',              `got ${card.body?.name}`);
  check(card.body?.version === '1.4.0',         'mcp.json version = 1.4.0',            `got ${card.body?.version}`);

  const skills = await req('/.well-known/agent-skills/index.json');
  const skillNames = skills.body?.skills?.map(s => s.name) ?? [];
  check(skillNames.includes('request_approval'), 'agent-skills lists request_approval', `skills: ${skillNames.join(',')}`);
  check(skillNames.includes('check_approval'),   'agent-skills lists check_approval',   `skills: ${skillNames.join(',')}`);

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(c.section('Result'));
  console.log(`${c.bold('Passed:')} ${passed}`);
  console.log(`${c.bold('Failed:')} ${failed}`);
  console.log(`${c.bold('Warnings:')} ${warned}`);
  if (failed > 0) {
    console.log(c.red('\nFailures:'));
    findings.filter(f => !f.soft).forEach(f => console.log(`  - ${f.label}${f.why ? ' — ' + f.why : ''}`));
  }
  if (warned > 0) {
    console.log(c.yellow('\nWarnings (gaps / future work):'));
    findings.filter(f => f.soft).forEach(f => console.log(`  - ${f.label}\n      ${f.why}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(c.red('FATAL'), err); process.exit(2); });
