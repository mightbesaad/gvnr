import type { AccountRecord } from './types';

export async function hashApiKey(key: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function getAccount(kv: KVNamespace, apiKeyPlaintext: string): Promise<AccountRecord | null> {
  const hash = await hashApiKey(apiKeyPlaintext);
  return kv.get<AccountRecord>(`api:${hash}`, 'json');
}
