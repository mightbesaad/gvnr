interface TailEnv {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

const CRASH_OUTCOMES = new Set(['exception', 'exceeded-cpu', 'exceeded-memory', 'crashed']);

export default {
  async tail(events: TraceItem[], env: TailEnv): Promise<void> {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

    for (const event of events) {
      const isCrash = CRASH_OUTCOMES.has(event.outcome);
      const fetchInfo = event.event !== null && 'request' in (event.event as object)
        ? event.event as TraceItemFetchEventInfo
        : null;
      const is5xx = (fetchInfo?.response?.status ?? 0) >= 500;

      if (!isCrash && !is5xx) continue;

      const url = fetchInfo?.request.url ?? 'unknown';
      const status = fetchInfo?.response?.status;
      const excs = event.exceptions
        .map(e => `${e.name}: ${e.message}`)
        .join('\n')
        .slice(0, 800);

      const summary = isCrash
        ? `crash · outcome: ${event.outcome}`
        : `HTTP ${status}`;

      const lines = [`🚨 budget-governor ${summary}`, `URL: ${url}`];
      if (excs) lines.push(excs);

      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: lines.join('\n') }),
      });
    }
  },
};
