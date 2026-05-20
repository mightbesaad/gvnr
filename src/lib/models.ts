// Per-million-token prices in USD. Input and output priced separately so the
// Reconciler can compute actual cost; budget_clear uses only the output rate
// (pre-call we have no way to predict input tokens precisely).
//
// Keys are matched by prefix (longest first) so versioned IDs like
// "claude-haiku-4-5-20251001" resolve to "claude-haiku-4-5".
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-4-7':    { in: 15,    out: 75 },
  'claude-opus-4-6':    { in: 15,    out: 75 },
  'claude-sonnet-4-6':  { in: 3,     out: 15 },
  'claude-haiku-4-5':   { in: 0.8,   out: 4 },
  'gpt-4o-mini':        { in: 0.15,  out: 0.6 },
  'gpt-4o':             { in: 2.5,   out: 10 },
  'gpt-4-turbo':        { in: 10,    out: 30 },
  'gemini-1-5-pro':     { in: 1.25,  out: 3.5 },
  'gemini-1-5-flash':   { in: 0.075, out: 0.3 },
};

// Sorted once at module load — longest prefix wins (e.g. "gpt-4o-mini" before "gpt-4o").
const MODEL_PRICE_ENTRIES = Object.entries(MODEL_PRICES).sort((a, b) => b[0].length - a[0].length);

// Fail-safe direction: unknown model strings price at the highest known rates (Opus)
// so a typo or new model can never silently under-bill the agent's envelope.
const DEFAULT_PRICE: { in: number; out: number } = { in: 15, out: 75 };

function modelPrice(model: string): { in: number; out: number } {
  const entry = MODEL_PRICE_ENTRIES.find(([prefix]) => model.startsWith(prefix));
  return entry ? entry[1] : DEFAULT_PRICE;
}

export function estimateCostUsd(model: string, output_tokens: number): number {
  return (output_tokens / 1_000_000) * modelPrice(model).out;
}

export function actualCostUsd(model: string, input_tokens: number, output_tokens: number): number {
  const p = modelPrice(model);
  return (input_tokens / 1_000_000) * p.in + (output_tokens / 1_000_000) * p.out;
}

export function roundUsd(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

export function nextDailyReset(): number {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.getTime();
}
