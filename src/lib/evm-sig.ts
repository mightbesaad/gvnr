import { recoverMessageAddress } from 'viem';

// Binds an on-chain top-up to the account that actually paid. The payer signs this exact message
// (EIP-191 personal_sign) with the wallet that sent the USDC; the server then checks the recovered
// signer against the transfer's on-chain `from`. It is bound to account + tx + chain so a captured
// signature can't be replayed to a different account, a different tx, or another network — and a
// thief who scrapes the public tx_hash still can't produce it (they don't hold the wallet key).
// Issue #13.
export function buildTopupChallenge(params: { accountId: string; txHash: string; chainId: number }): string {
  return [
    'gvnr.dev top-up authorization',
    `account: ${params.accountId}`,
    `tx: ${params.txHash.toLowerCase()}`,
    `chain: ${params.chainId}`,
  ].join('\n');
}

// Recover the EOA that produced an EIP-191 personal_sign over `message`. Returns the address
// lowercased, or null on any malformed input or recovery failure (never throws). A 65-byte
// signature is 0x + 130 hex chars.
export async function recoverSigner(message: string, signature: string): Promise<string | null> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  try {
    const address = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
    return address.toLowerCase();
  } catch {
    return null;
  }
}
