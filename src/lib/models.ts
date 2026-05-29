// Per-million-token prices in USD. Input and output priced separately so the
// Reconciler can compute actual cost. budget_clear uses the output rate for
// chat models (pre-call we have no way to predict input tokens precisely),
// and the input rate for input_only models (embeddings — output is always 0
// and input is exactly known pre-call).
//
// Keys are matched by prefix (longest first) so versioned IDs like
// "claude-haiku-4-5-20251001" resolve to "claude-haiku-4-5".
type PriceEntry = { in: number; out: number; input_only?: boolean };

// Provider rates only feed the per-agent spend cap (the envelope), NOT gvnr's revenue —
// revenue is a flat per-operation quota (see PACKS / operations_remaining). So these
// numbers must track each provider's real list price for accurate caps. Verified against
// platform.claude.com / OpenAI / Google pricing, May 2026.
export const MODEL_PRICES: Record<string, PriceEntry> = {
  'claude-opus-4-8':       { in: 5,     out: 25 },
  'claude-opus-4-7':       { in: 5,     out: 25 },
  'claude-opus-4-6':       { in: 5,     out: 25 },
  'claude-sonnet-4-6':     { in: 3,     out: 15 },
  'claude-haiku-4-5':      { in: 1,     out: 5 },
  'gpt-4o-mini':           { in: 0.15,  out: 0.6 },
  'gpt-4o':                { in: 2.5,   out: 10 },
  'gpt-4-turbo':           { in: 10,    out: 30 },
  'text-embedding-3-small': { in: 0.02, out: 0, input_only: true },
  'text-embedding-3-large': { in: 0.13, out: 0, input_only: true },
  'gemini-embedding-001':  { in: 0.15,  out: 0, input_only: true },
  'gemini-embedding-2':    { in: 0.20,  out: 0, input_only: true },
};

// Sorted once at module load — longest prefix wins (e.g. "gpt-4o-mini" before "gpt-4o").
const MODEL_PRICE_ENTRIES = Object.entries(MODEL_PRICES).sort((a, b) => b[0].length - a[0].length);

// Fail-safe direction: unknown model strings price above every listed rate so a typo or
// a brand-new model can never silently under-bill the agent's envelope (cap only).
const DEFAULT_PRICE: PriceEntry = { in: 15, out: 75 };

function modelPrice(model: string): PriceEntry {
  const entry = MODEL_PRICE_ENTRIES.find(([prefix]) => model.startsWith(prefix));
  return entry ? entry[1] : DEFAULT_PRICE;
}

export function isInputOnlyModel(model: string): boolean {
  return modelPrice(model).input_only === true;
}

// `billed_tokens` means output tokens for chat models, input tokens for input_only models.
// The caller passes whichever count is meaningful for the model class they're calling.
export function estimateCostUsd(model: string, billed_tokens: number): number {
  const p = modelPrice(model);
  const rate = p.input_only ? p.in : p.out;
  return (billed_tokens / 1_000_000) * rate;
}

export function actualCostUsd(model: string, input_tokens: number, output_tokens: number): number {
  const p = modelPrice(model);
  return (input_tokens / 1_000_000) * p.in + (output_tokens / 1_000_000) * p.out;
}

export function roundUsd(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

// Renders the public "Model pricing" block straight from MODEL_PRICES so the homepage
// table can never drift from the rates the cap actually uses (they did, once — Opus was
// 3× stale). Insertion order in MODEL_PRICES is the display order.
export function renderPriceTable(): string {
  const rows = Object.entries(MODEL_PRICES);
  const nameW = Math.max(...rows.map(([k]) => k.length)) + 2;
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const chat = rows.filter(([, p]) => !p.input_only)
    .map(([k, p], i) => `${k.padEnd(nameW)}${usd(p.in).padStart(7)} / ${usd(p.out).padStart(7)}${i === 0 ? '  per M tokens (in / out)' : ''}`);
  const embed = rows.filter(([, p]) => p.input_only)
    .map(([k, p]) => `${k.padEnd(nameW)}${usd(p.in).padStart(7)} / M   (input-only)`);
  return [...chat, '', ...embed].join('\n');
}

export function nextDailyReset(): number {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.getTime();
}
