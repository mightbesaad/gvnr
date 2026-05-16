import type { AccountRecord, BalanceRecord, EnvelopeRecord } from './types';

// Key builders
export const keys = {
  api: (apiKey: string) => `api:${apiKey}`,
  balance: (accountId: string) => `account:${accountId}:balance`,
  envelope: (accountId: string, agentId: string) => `envelope:${accountId}:${agentId}`,
};

export async function getAccount(kv: KVNamespace, apiKey: string): Promise<AccountRecord | null> {
  return kv.get<AccountRecord>(keys.api(apiKey), 'json');
}

export async function getBalance(kv: KVNamespace, accountId: string): Promise<BalanceRecord | null> {
  return kv.get<BalanceRecord>(keys.balance(accountId), 'json');
}

export async function setBalance(kv: KVNamespace, accountId: string, balance: BalanceRecord): Promise<void> {
  await kv.put(keys.balance(accountId), JSON.stringify(balance));
}

export async function getEnvelope(kv: KVNamespace, accountId: string, agentId: string): Promise<EnvelopeRecord | null> {
  return kv.get<EnvelopeRecord>(keys.envelope(accountId, agentId), 'json');
}

export async function setEnvelope(kv: KVNamespace, accountId: string, agentId: string, envelope: EnvelopeRecord): Promise<void> {
  await kv.put(keys.envelope(accountId, agentId), JSON.stringify(envelope));
}

export async function deleteEnvelope(kv: KVNamespace, accountId: string, agentId: string): Promise<void> {
  await kv.delete(keys.envelope(accountId, agentId));
}
