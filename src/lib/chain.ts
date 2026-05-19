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

export function packToRawAmount(amountUsd: number): bigint {
  return BigInt(amountUsd) * BigInt(10 ** USDC_DECIMALS);
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
  expectedRawAmount: bigint,
  usdcContract: string,
  rpcUrl: string,
  fallbackRpcUrl?: string,
): Promise<{ ok: boolean; error?: string; overpaid_raw?: string }> {
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

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcLower) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics[2]?.toLowerCase() !== paddedPayTo) continue;

    const transferAmount = BigInt(log.data);
    if (transferAmount >= expectedRawAmount) {
      const overpay = transferAmount - expectedRawAmount;
      return { ok: true, overpaid_raw: overpay > 0n ? overpay.toString() : undefined };
    }
  }

  return { ok: false, error: 'transfer_not_found' };
}
