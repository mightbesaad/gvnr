import { getBalance, getEnvelope, setEnvelope } from './kv';
import { estimateCostUsd, nextDailyReset, roundUsd } from './models';

export interface ClearanceResult {
  approved: boolean;
  remaining_usd: number;
  reason?: 'no_credits' | 'no_envelope' | 'envelope_exceeded';
}

export async function runClearance(
  kv: KVNamespace,
  accountId: string,
  agentId: string,
  model: string,
  estimatedTokens: number,
): Promise<ClearanceResult> {
  const balance = await getBalance(kv, accountId);
  if (!balance || balance.balance_usd <= 0) {
    return { approved: false, remaining_usd: 0, reason: 'no_credits' };
  }

  const env = await getEnvelope(kv, accountId, agentId);
  if (!env) {
    return { approved: false, remaining_usd: 0, reason: 'no_envelope' };
  }

  const now = Date.now();
  if (env.window === 'daily' && now >= env.reset_at) {
    env.spent_usd = 0;
    env.reset_at = nextDailyReset();
  }

  const estimatedCost = estimateCostUsd(model, estimatedTokens);
  const remaining = env.limit_usd - env.spent_usd;

  if (estimatedCost > remaining) {
    return { approved: false, remaining_usd: roundUsd(remaining), reason: 'envelope_exceeded' };
  }

  env.spent_usd += estimatedCost;
  await setEnvelope(kv, accountId, agentId, env);
  return { approved: true, remaining_usd: roundUsd(env.limit_usd - env.spent_usd) };
}
