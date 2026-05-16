// Output token price per million tokens (USD) — used to estimate cost per clearance call.
// Worst-case (output) price used since that's the expensive side.
// Keys are matched by prefix (longest first) so versioned IDs like
// "claude-haiku-4-5-20251001" correctly resolve to "claude-haiku-4-5".
const MODEL_PRICES: Record<string, number> = {
  'claude-opus-4-7':    75,
  'claude-opus-4-6':    75,
  'claude-sonnet-4-6':  15,
  'claude-haiku-4-5':    4,
  'gpt-4o-mini':         0.6,
  'gpt-4o':             10,
  'gpt-4-turbo':        30,
  'gemini-1-5-pro':      3.5,
  'gemini-1-5-flash':    0.075,
};

// Sorted once at module load — longest prefix wins (e.g. "gpt-4o-mini" before "gpt-4o").
const MODEL_PRICE_ENTRIES = Object.entries(MODEL_PRICES).sort((a, b) => b[0].length - a[0].length);

const DEFAULT_PRICE_PER_MTOK = 15; // fallback for unknown models

export function estimateCostUsd(model: string, tokens: number): number {
  const entry = MODEL_PRICE_ENTRIES.find(([prefix]) => model.startsWith(prefix));
  const pricePerMtok = entry ? entry[1] : DEFAULT_PRICE_PER_MTOK;
  return (tokens / 1_000_000) * pricePerMtok;
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
