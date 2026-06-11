const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export const USDC_DECIMALS = 6;

export const NETWORK_CONFIGS = {
  'eip155:8453': {
    name: 'Base mainnet',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    usdcContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    explorerUrl: 'https://basescan.org',
  },
  'eip155:84532': {
    name: 'Base Sepolia (testnet)',
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    usdcContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    explorerUrl: 'https://sepolia.basescan.org',
  },
} as const;

export type NetworkKey = keyof typeof NETWORK_CONFIGS;

// Cents-safe USD -> raw USDC (6dp). BigInt(amountUsd) throws on any fractional dollar
// (e.g. BigInt(1.5) RangeErrors), so go via whole cents: round to cents, then scale by the
// remaining 4 decimals. Handles custom amounts like $1.50 that the pay page now allows.
export function usdToRawAmount(amountUsd: number): bigint {
  const cents = BigInt(Math.round(amountUsd * 100));
  return cents * BigInt(10 ** (USDC_DECIMALS - 2));
}

// Back-compat alias for whole-dollar preset amounts.
export function packToRawAmount(amountUsd: number): bigint {
  return usdToRawAmount(amountUsd);
}

function padAddress(address: string): string {
  return '0x' + address.slice(2).toLowerCase().padStart(64, '0');
}

interface RpcReceipt {
  status: string;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
  }>;
}

// Returns the receipt, `null` for a definite "not yet on chain" response, or throws on transport failure.
async function fetchReceipt(rpcUrl: string, txHash: string): Promise<RpcReceipt | null> {
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionReceipt', params: [txHash], id: 1 }),
  });
  const json = (await resp.json()) as { result: RpcReceipt | null };
  return json.result;
}

export async function verifyUsdcTransfer(
  txHash: string,
  payTo: string,
  usdcContract: string,
  rpcUrl: string,
  fallbackRpcUrl?: string,
): Promise<
  | { ok: true; amount_raw: string; from_addresses: string[] }
  | { ok: false; error: string }
> {
  let receipt: RpcReceipt | null;
  try {
    receipt = await fetchReceipt(rpcUrl, txHash);
  } catch {
    if (!fallbackRpcUrl) return { ok: false, error: 'rpc_error' };
    try {
      receipt = await fetchReceipt(fallbackRpcUrl, txHash);
    } catch {
      return { ok: false, error: 'rpc_error' };
    }
  }

  if (!receipt) return { ok: false, error: 'tx_not_found' };
  if (receipt.status !== '0x1') return { ok: false, error: 'tx_failed' };

  const paddedPayTo = padAddress(payTo);
  const usdcLower = usdcContract.toLowerCase();

  // Sum every USDC transfer to payTo in this tx and credit whatever actually arrived
  // (pay-as-you-go). No expected-amount gate: the old `>= expected` check rejected
  // under-payments while the user's USDC had already moved to payTo — i.e. it ate their
  // funds. Proportional crediting downstream removes that footgun. We also collect the
  // sender(s) of those transfers (Transfer.from = topics[1]) so the caller can require a
  // signature proving control of the paying wallet — without that binding, anyone watching
  // payTo on-chain could redeem a stranger's tx_hash (front-running, see issue #13).
  const senders = new Set<string>();
  let total = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcLower) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics[2]?.toLowerCase() !== paddedPayTo) continue;
    const from = log.topics[1];
    if (from) senders.add(`0x${from.slice(-40).toLowerCase()}`);
    total += BigInt(log.data);
  }

  if (total > 0n) return { ok: true, amount_raw: total.toString(), from_addresses: [...senders] };
  return { ok: false, error: 'transfer_not_found' };
}
