import { Hono } from 'hono';
import type { Env } from '../lib/types';
import { PACKS, type PackName } from '../lib/x402';
import { NETWORK_CONFIGS, type NetworkKey, packToRawAmount, verifyUsdcTransfer, USDC_DECIMALS } from '../lib/chain';
import { authMiddleware, type AuthVariables } from '../lib/auth';
import { opsForUsd } from '../lib/models';

type Variables = AuthVariables;

const pay = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /v1/packs/:pack/info — human-readable payment requirements (no auth)
pay.get('/v1/packs/:pack/info', async (c) => {
  const packName = c.req.param('pack') as PackName;
  const pack = PACKS[packName];
  if (!pack) return c.json({ error: 'invalid_pack', valid: Object.keys(PACKS) }, 404);

  const network = c.env.X402_NETWORK as NetworkKey;
  const cfg = NETWORK_CONFIGS[network];
  if (!cfg) return c.json({ error: 'misconfigured_network', retryable: false, hint: 'Server network configuration error — retrying will not help; contact support.' }, 500);

  return c.json({
    pack: packName,
    amount_usd: pack.amount_usd,
    description: pack.description,
    network_name: cfg.name,
    chain_id: cfg.chainId,
    usdc_contract: cfg.usdcContract,
    usdc_amount_raw: packToRawAmount(pack.amount_usd).toString(),
    payto_address: c.env.PAYTO_ADDRESS,
  });
});

// POST /v1/account/topup-verify/:pack — on-chain verification, credits account
pay.post('/v1/account/topup-verify/:pack', authMiddleware, async (c) => {
  const packName = c.req.param('pack') as PackName;
  const pack = PACKS[packName];
  if (!pack) return c.json({ error: 'invalid_pack', valid: Object.keys(PACKS) }, 400);

  const body = await c.req.json<{ tx_hash?: string }>();
  const txHash = body.tx_hash?.trim();
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return c.json({ error: 'invalid_tx_hash', retryable: false, hint: 'tx_hash must be 0x-prefixed with 64 hex chars.' }, 400);
  }

  const network = c.env.X402_NETWORK as NetworkKey;
  const cfg = NETWORK_CONFIGS[network];
  if (!cfg) return c.json({ error: 'misconfigured_network', retryable: false, hint: 'Server network configuration error — retrying will not help; contact support.' }, 500);

  const txKey = `used_tx:${cfg.chainId}:${txHash.toLowerCase()}`;
  const accountId = c.get('accountId');
  const stub = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName(accountId));

  const alreadyUsed = await c.env.BUDGET_KV.get(txKey);
  if (alreadyUsed) {
    const operations = await stub.getOperations();
    return c.json({ operations_remaining: operations, pack: packName, already_credited: true });
  }

  const verification = await verifyUsdcTransfer(
    txHash,
    c.env.PAYTO_ADDRESS,
    cfg.usdcContract,
    cfg.rpcUrl,
    c.env.BASE_RPC_FALLBACK_URL,
  );
  if (!verification.ok) {
    const transient = verification.error === 'tx_not_found' || verification.error === 'rpc_error';
    return c.json({ error: verification.error, retryable: transient }, 400);
  }

  // Pay-as-you-go: credit ops proportional to however much USDC actually arrived at payTo.
  // Any amount works; nothing is rejected or wasted (no fund-loss footgun).
  const creditedUsd = Number(BigInt(verification.amount_raw!)) / 10 ** USDC_DECIMALS;
  const ops = opsForUsd(creditedUsd);
  const credited = await stub.credit(ops);

  // Mark tx as used — 30-day TTL prevents replay, doesn't bloat KV forever
  await c.env.BUDGET_KV.put(txKey, '1', { expirationTtl: 2592000 });

  return c.json({ operations_remaining: credited.operations_remaining, credited_ops: ops, credited_usd: creditedUsd });
});

// GET /pay/:pack — human-facing payment page
pay.get('/pay/:pack', async (c) => {
  c.header('X-Frame-Options', 'DENY');
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  c.header('X-Content-Type-Options', 'nosniff');

  const packName = c.req.param('pack') as PackName;
  const pack = PACKS[packName];
  if (!pack) {
    return c.html(errorPage(`Unknown pack. Valid packs: ${Object.keys(PACKS).join(', ')}.`), 404);
  }

  const network = c.env.X402_NETWORK as NetworkKey;
  const cfg = NETWORK_CONFIGS[network];
  if (!cfg) return c.html(errorPage('Server misconfigured.'), 500);

  const rawApiKey = c.req.query('api_key') ?? '';
  // Validate format before embedding in HTML — prevents XSS via crafted api_key param
  if (rawApiKey && !/^bg_[0-9a-f]{32}$/i.test(rawApiKey)) {
    return c.html(errorPage('Invalid API key format.'), 400);
  }
  const apiKey = rawApiKey;
  const rawAmount = packToRawAmount(pack.amount_usd);
  return c.html(payPage({
    packName,
    amountUsd: pack.amount_usd,
    description: pack.description,
    apiKey,
    networkName: cfg.name,
    chainId: cfg.chainId,
    usdcContract: cfg.usdcContract,
    usdcAmountRaw: rawAmount.toString(),
    paytoAddress: c.env.PAYTO_ADDRESS,
    explorerUrl: cfg.explorerUrl,
  }));
});

export default pay;

// ── HTML templates ────────────────────────────────────────────────────────────

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error — Budget Governor</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#e5e5e5;padding:48px 24px;min-height:100vh}
    .container{max-width:520px;margin:0 auto}
    h1{font-size:1.4rem;font-weight:600;letter-spacing:-0.02em;margin-bottom:6px}
    .msg{color:#f87171;font-size:0.9rem;margin-bottom:24px;margin-top:6px}
    a{color:#a78bfa;text-decoration:none;font-size:0.9rem}
    a:hover{text-decoration:underline}
  </style>
</head>
<body>
<div class="container">
  <h1>Error</h1>
  <p class="msg">${message}</p>
  <a href="/">← Back to homepage</a>
</div>
</body>
</html>`;
}

interface PageData {
  packName: string;
  amountUsd: number;
  description: string;
  apiKey: string;
  networkName: string;
  chainId: number;
  usdcContract: string;
  usdcAmountRaw: string;
  paytoAddress: string;
  explorerUrl: string;
}

function payPage(d: PageData): string {
  const chainHex = '0x' + d.chainId.toString(16);
  const isTestnet = d.networkName.includes('testnet') || d.networkName.includes('Sepolia');
  const packLabels: Record<string, string> = { starter: 'Starter', growth: 'Growth', studio: 'Studio' };
  const otherPacks = Object.keys(PACKS).filter(p => p !== d.packName);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Top up — Budget Governor</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#e5e5e5;padding:48px 24px;min-height:100vh}
    .container{max-width:520px;margin:0 auto}
    a{color:#a78bfa;text-decoration:none}
    h1{font-size:1.4rem;font-weight:600;letter-spacing:-0.02em;margin-bottom:4px}
    .sub{color:#888;font-size:0.9rem;margin-bottom:36px}
    .card{background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:20px 22px;margin-bottom:16px}
    .step-label{font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#888;margin-bottom:10px}
    .pack-row{display:flex;align-items:baseline;gap:10px;margin-bottom:6px}
    .pack-name{font-size:1.1rem;font-weight:600}
    .pack-price{font-size:1.5rem;font-weight:700;color:#a78bfa}
    .pack-desc{font-size:0.85rem;color:#888}
    .pack-switch{font-size:0.8rem;color:#777;margin-top:8px}
    .field-label{font-size:0.75rem;color:#777;margin-bottom:5px;margin-top:14px}
    .field-label:first-of-type{margin-top:0}
    .copy-row{display:flex;gap:8px;align-items:center}
    .mono{font-family:"SF Mono","Fira Code",monospace;font-size:0.82rem;color:#ccc;background:#0f0f0f;border:1px solid #222;border-radius:6px;padding:9px 12px;flex:1;overflow-wrap:break-word;word-break:break-all;white-space:normal}
    .btn{border:none;border-radius:6px;padding:9px 14px;font-size:0.82rem;font-weight:500;cursor:pointer;transition:opacity 0.15s}
    .btn:hover{opacity:0.85}
    .btn-copy{background:#1a1a2e;color:#a78bfa;border:1px solid #2a2a4a;white-space:nowrap}
    .btn-primary{background:#4f46e5;color:#fff;width:100%;padding:11px;font-size:0.9rem;margin-top:16px;border-radius:8px}
    .btn-wallet{background:#1a1a2e;color:#a78bfa;border:1px solid #2a2a4a;width:100%;padding:10px;font-size:0.85rem;margin-top:8px;border-radius:8px}
    .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.75rem;font-family:monospace;background:#1a2e1a;color:#4ade80;border:1px solid #1e3a1e}
    .badge.testnet{background:#1a1a2e;color:#818cf8;border-color:#2a2a4a}
    input[type=text]{width:100%;background:#0f0f0f;border:1px solid #222;border-radius:6px;padding:9px 12px;font-family:"SF Mono","Fira Code",monospace;font-size:0.82rem;color:#ccc;outline:none;transition:border-color 0.15s}
    input[type=text]:focus{border-color:#4f46e5}
    input[type=text]::placeholder{color:#555}
    .key-row{display:flex;gap:8px;margin-bottom:0}
    .key-input{flex:1}
    .status{margin-top:14px;padding:10px 12px;border-radius:6px;font-size:0.85rem;display:none}
    .status.ok{background:#0a1f0a;border:1px solid #1e3a1e;color:#4ade80}
    .status.err{background:#1f0a0a;border:1px solid #3a1e1e;color:#f87171}
    .status.info{background:#0f0f1f;border:1px solid #1e1e3a;color:#818cf8}
    .divider{border:none;border-top:1px solid #1a1a1a;margin:16px 0}
    .instructions{font-size:0.83rem;color:#888;line-height:1.7;margin-top:10px}
    .instructions li{margin-left:16px}
    footer{border-top:1px solid #1a1a1a;margin-top:32px;padding-top:20px}
    .footer-row{display:flex;gap:16px;flex-wrap:wrap;font-size:0.78rem;color:#666;line-height:1.8;justify-content:center}
    .footer-row a{color:#777;text-decoration:none}
    .footer-row a:hover{color:#aaa}
  </style>
</head>
<body>
<div class="container">
  <h1>Top up your account</h1>
  <p class="sub">Pay via x402 — USDC on Base &nbsp;·&nbsp; <span class="badge ${isTestnet ? 'testnet' : ''}">${d.networkName}</span></p>

  <!-- Step 1: Pack -->
  <div class="card">
    <div class="step-label">1 · Select pack</div>
    <div class="pack-row">
      <span class="pack-name">${packLabels[d.packName] ?? d.packName}</span>
      <span class="pack-price">$${d.amountUsd}</span>
    </div>
    <div class="pack-desc">${d.description}</div>
    ${otherPacks.length ? `<div class="pack-switch">Switch: ${otherPacks.map(p => `<a href="/pay/${p}${d.apiKey ? `?api_key=${d.apiKey}` : ''}">${packLabels[p] ?? p}</a>`).join(' · ')}</div>` : ''}
  </div>

  <!-- Step 2: Send -->
  <div class="card">
    <div class="step-label">2 · Send USDC</div>

    <div class="field-label">Send to address</div>
    <div class="copy-row">
      <div class="mono" id="payto">${d.paytoAddress}</div>
      <button class="btn btn-copy" onclick="copy('payto', this)">Copy</button>
    </div>

    <div class="field-label">Exact amount (USDC)</div>
    <div class="copy-row">
      <div class="mono" id="amount">${d.amountUsd}.000000</div>
      <button class="btn btn-copy" onclick="copy('amount', this)">Copy</button>
    </div>

    <hr class="divider">

    <button class="btn btn-wallet" onclick="connectAndPay()" id="wallet-btn">
      Connect wallet &amp; pay automatically
    </button>

    <div class="instructions">
      <ul>
        <li>Network: <strong style="color:#ccc">Base</strong> (not Ethereum mainnet)</li>
        <li>Token: <strong style="color:#ccc">USDC</strong> — send exactly $${d.amountUsd}</li>
        <li>Contract: <a href="${isTestnet ? 'https://sepolia.basescan.org' : 'https://basescan.org'}/token/${d.usdcContract}" target="_blank" rel="noopener" style="font-family:monospace;font-size:0.78rem;color:#818cf8">${d.usdcContract} ↗</a></li>
        <li>Receiver: <a href="${isTestnet ? 'https://sepolia.basescan.org' : 'https://basescan.org'}/address/${d.paytoAddress}" target="_blank" rel="noopener" style="color:#818cf8">verify on Basescan ↗</a></li>
      </ul>
    </div>
  </div>

  <!-- Step 3: Verify -->
  <div class="card">
    <div class="step-label">3 · Confirm payment</div>

    ${!d.apiKey ? `
    <div class="field-label" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px">
      <span>Your API key</span>
      <span style="font-size:0.72rem;color:#555">No key? <a href="#" onclick="provisionKey(event)" id="provision-link" style="color:#818cf8">Get one →</a></span>
    </div>
    <div class="key-row">
      <input type="text" class="key-input" id="api-key" placeholder="bg_..." value="">
    </div>
    <div id="key-save-warning" style="display:none;background:#1a0808;border:1px solid #3a1414;color:#f87171;font-size:0.8rem;padding:8px 12px;border-radius:6px;margin-top:8px;line-height:1.5">
      ⚠ Save this key — it cannot be recovered. If you lose it, your credits are permanently lost.
    </div>
    ` : `<input type="hidden" id="api-key" value="${d.apiKey}">`}

    <div class="field-label" style="margin-top:${d.apiKey ? '0' : '12px'}">Transaction hash</div>
    <input type="text" id="tx-hash" placeholder="0x..." value="">

    <button class="btn btn-primary" onclick="verifyPayment()">Verify &amp; Credit my account</button>

    <div class="status" id="status"></div>
    <div id="next-steps" style="display:none;margin-top:14px">
      <hr class="divider">
      <div class="step-label">What's next</div>
      <ol class="instructions" style="margin-top:8px">
        <li>Set a spend cap for your agent — <code style="font-size:0.78rem;color:#a78bfa">PUT /v1/budget/envelope</code></li>
        <li>Call <code style="font-size:0.78rem;color:#a78bfa">budget_clear</code> before each LLM request</li>
        <li>Or add the MCP server to Claude Desktop / Claude Code:</li>
      </ol>
      <div class="mono" id="mcp-cmd" style="margin-top:10px;white-space:pre-wrap;word-break:break-all;font-size:0.75rem"></div>
    </div>
  </div>

  <footer>
    <div class="footer-row">
      <a href="/">Home</a>
      <span>·</span>
      <a href="/tos">Terms &amp; Refund Policy</a>
      <span>·</span>
      <a href="https://github.com/mightbesaad/gvnr/issues" target="_blank" rel="noopener">Support</a>
      <span>·</span>
      <a href="https://github.com/mightbesaad/gvnr" target="_blank" rel="noopener">GitHub</a>
    </div>
  </footer>
</div>

<script>
const PACK = ${JSON.stringify(d.packName)};
const USDC_CONTRACT = ${JSON.stringify(d.usdcContract)};
const PAYTO = ${JSON.stringify(d.paytoAddress)};
const RAW_AMOUNT = ${JSON.stringify(d.usdcAmountRaw)};
const CHAIN_ID_HEX = ${JSON.stringify(chainHex)};
const CHAIN_ID = ${d.chainId};
const NETWORK_NAME = ${JSON.stringify(d.networkName)};
const EXPLORER = ${JSON.stringify(d.explorerUrl)};

function copy(id, btn) {
  const text = document.getElementById(id).textContent;
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 1500);
  });
}

function showStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + type;
  el.style.display = 'block';
}

async function attemptVerify() {
  const apiKey = document.getElementById('api-key').value.trim();
  const txHash = document.getElementById('tx-hash').value.trim();
  if (!apiKey) return { localError: 'no_key' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { localError: 'bad_hash' };
  try {
    const res = await fetch('/v1/account/topup-verify/' + PACK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ tx_hash: txHash }),
    });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch {
    return { localError: 'network' };
  }
}

function showVerifyResult(result) {
  const apiKey = document.getElementById('api-key').value.trim();
  if (result.localError === 'no_key') return showStatus('Enter your API key.', 'err');
  if (result.localError === 'bad_hash') return showStatus('Enter a valid transaction hash (0x + 64 hex chars).', 'err');
  if (result.localError === 'network') return showStatus('Network error. Try again.', 'err');
  if (result.ok) {
    showStatus('Credited! ' + result.data.operations_remaining.toLocaleString() + ' governance ops available', 'ok');
    document.getElementById('mcp-cmd').textContent =
      'claude mcp add budget-governor --transport http \\\n  "https://gvnr.dev/mcp?api_key=' + apiKey + '"';
    document.getElementById('next-steps').style.display = 'block';
    return;
  }
  const msgs = {
    tx_not_found: 'Transaction not found yet. Wait for confirmation and try again.',
    tx_failed: 'Transaction failed on-chain.',
    transfer_not_found: 'No matching USDC transfer found in this transaction.',
    rpc_error: 'Could not reach Base RPC. Try again in a moment.',
    invalid_tx_hash: 'Invalid transaction hash format.',
  };
  showStatus(msgs[result.data.error] || ('Error: ' + result.data.error), 'err');
}

async function verifyPayment() {
  showStatus('Verifying on-chain...', 'info');
  showVerifyResult(await attemptVerify());
}

// Auto-verify after wallet pay — retries on transient errors (tx not indexed yet, RPC blip).
// Manual "Verify" button stays one-shot since the user controls when to retry.
const TRANSIENT_ERRORS = new Set(['tx_not_found', 'rpc_error']);
async function autoVerify(attempt, retryDelays) {
  const totalAttempts = retryDelays.length + 1;
  showStatus(
    attempt === 1
      ? 'Verifying on-chain...'
      : 'Tx not indexed yet — retry ' + attempt + '/' + totalAttempts + '...',
    'info',
  );
  const result = await attemptVerify();
  const transient = !result.ok && result.data && TRANSIENT_ERRORS.has(result.data.error);
  if (!transient || attempt >= totalAttempts) {
    if (transient) {
      showStatus(
        'Transaction still not visible on-chain. Once it appears on basescan, click "Verify & Credit my account" below.',
        'err',
      );
      return;
    }
    showVerifyResult(result);
    return;
  }
  setTimeout(() => autoVerify(attempt + 1, retryDelays), retryDelays[attempt - 1]);
}

// Preview mode — ?preview=success shows post-payment UI without a real transaction
(function () {
  if (new URLSearchParams(location.search).get('preview') === 'success') {
    showStatus('[preview mode] — simulating post-payment success state', 'info');
    document.getElementById('mcp-cmd').textContent =
      'claude mcp add budget-governor --transport http \\\n  "https://gvnr.dev/mcp?api_key=bg_YOUR_KEY"';
    document.getElementById('next-steps').style.display = 'block';
  }
})();

async function provisionKey(e) {
  e.preventDefault();
  var link = document.getElementById('provision-link');
  link.textContent = 'Getting...';
  try {
    var res = await fetch('/v1/account', { method: 'POST' });
    var data = await res.json();
    if (!res.ok) {
      link.textContent = data.error === 'rate_limited' ? 'Rate limited (try in 1h)' : 'Error: ' + data.error;
      return;
    }
    var input = document.getElementById('api-key');
    input.value = data.api_key;
    input.style.borderColor = '#4f46e5';
    link.textContent = 'Key ready ✓';
    link.style.color = '#4ade80';
    document.getElementById('key-save-warning').style.display = 'block';
  } catch (err) {
    link.textContent = 'Network error';
  }
}

async function connectAndPay() {
  if (!window.ethereum) {
    showStatus('No wallet detected. Install MetaMask or Coinbase Wallet, then use the manual flow above.', 'err');
    return;
  }

  const btn = document.getElementById('wallet-btn');
  btn.textContent = 'Connecting...';
  btn.disabled = true;

  try {
    const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
    const from = accounts[0];

    try {
      await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
    } catch (err) {
      if (err.code === 4902) {
        await ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CHAIN_ID_HEX,
            chainName: NETWORK_NAME,
            nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://' + (CHAIN_ID === 8453 ? 'mainnet' : 'sepolia') + '.base.org'],
            blockExplorerUrls: [EXPLORER],
          }],
        });
      } else throw err;
    }

    // Encode USDC transfer(address,uint256) calldata
    const selector = 'a9059cbb';
    const paddedTo = PAYTO.slice(2).toLowerCase().padStart(64, '0');
    const paddedAmt = BigInt(RAW_AMOUNT).toString(16).padStart(64, '0');
    const data = '0x' + selector + paddedTo + paddedAmt;

    btn.textContent = 'Approve in wallet...';
    const txHash = await ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: USDC_CONTRACT, data }],
    });

    document.getElementById('tx-hash').value = txHash;
    showStatus('Transaction submitted (' + txHash.slice(0, 10) + '...). Waiting for confirmation...', 'info');
    btn.textContent = 'Waiting for confirmation...';

    // First attempt at 6s, then retry on tx_not_found / rpc_error at +9s and +15s (≈30s total).
    setTimeout(() => autoVerify(1, [9000, 15000]), 6000);
  } catch (err) {
    showStatus(err.message || 'Wallet error.', 'err');
    btn.textContent = 'Connect wallet & pay automatically';
    btn.disabled = false;
  }
}
</script>
</body>
</html>`;
}
