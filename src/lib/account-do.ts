import { DurableObject } from 'cloudflare:workers';
import type { EnvelopeRecord } from './types';
import { estimateCostUsd, nextDailyReset, roundUsd } from './models';

interface DoEnv {
  BUDGET_KV: KVNamespace;
}

export interface ClearanceResult {
  approved: boolean;
  remaining_usd: number;
  reason?: 'no_credits' | 'no_envelope' | 'envelope_exceeded';
}

export class AccountState extends DurableObject<DoEnv> {
  private balance = 0;
  private envelopes = new Map<string, EnvelopeRecord>();

  constructor(ctx: DurableObjectState, env: DoEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const storedBalance = await ctx.storage.get<number>('balance');
      if (storedBalance !== undefined) {
        this.balance = storedBalance;
      } else {
        // Lazy migration from KV on first DO access for this account
        const accountId = ctx.id.name;
        if (accountId) {
          const kvRecord = await env.BUDGET_KV.get<{ balance_usd: number }>(
            `account:${accountId}:balance`, 'json',
          );
          this.balance = kvRecord?.balance_usd ?? 0;
        }
        await ctx.storage.put('balance', this.balance);
      }

      const storedEnvelopes = await ctx.storage.get<Record<string, EnvelopeRecord>>('envelopes');
      if (storedEnvelopes !== undefined) {
        this.envelopes = new Map(Object.entries(storedEnvelopes));
      } else {
        await ctx.storage.put('envelopes', {});
      }
    });
  }

  async credit(amount: number): Promise<{ balance_usd: number }> {
    this.balance += amount;
    await this.ctx.storage.put('balance', this.balance);
    return { balance_usd: this.balance };
  }

  async getBalance(): Promise<number> {
    return this.balance;
  }

  async runClearance(agentId: string, model: string, estimatedTokens: number): Promise<ClearanceResult> {
    const estimatedCost = estimateCostUsd(model, estimatedTokens);

    if (this.balance < estimatedCost) {
      return { approved: false, remaining_usd: 0, reason: 'no_credits' };
    }

    const env = this.envelopes.get(agentId);
    if (!env) {
      return { approved: false, remaining_usd: 0, reason: 'no_envelope' };
    }

    const now = Date.now();
    if (env.window === 'daily' && now >= env.reset_at) {
      env.spent_usd = 0;
      env.reset_at = nextDailyReset();
    }

    const remaining = env.limit_usd - env.spent_usd;

    if (estimatedCost > remaining) {
      return { approved: false, remaining_usd: roundUsd(remaining), reason: 'envelope_exceeded' };
    }

    env.spent_usd += estimatedCost;
    this.balance = roundUsd(this.balance - estimatedCost);
    this.envelopes.set(agentId, env);
    await this.ctx.storage.put('envelopes', Object.fromEntries(this.envelopes));
    await this.ctx.storage.put('balance', this.balance);

    return { approved: true, remaining_usd: roundUsd(env.limit_usd - env.spent_usd) };
  }

  async setEnvelope(agentId: string, envelope: EnvelopeRecord): Promise<void> {
    this.envelopes.set(agentId, envelope);
    await this.ctx.storage.put('envelopes', Object.fromEntries(this.envelopes));
  }

  async getEnvelope(agentId: string): Promise<EnvelopeRecord | null> {
    return this.envelopes.get(agentId) ?? null;
  }

  async deleteEnvelope(agentId: string): Promise<boolean> {
    const existed = this.envelopes.has(agentId);
    if (existed) {
      this.envelopes.delete(agentId);
      await this.ctx.storage.put('envelopes', Object.fromEntries(this.envelopes));
    }
    return existed;
  }
}
