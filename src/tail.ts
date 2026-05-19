interface TailEnv {
  ALERT_WEBHOOK: string;
}

const CRASH_OUTCOMES = new Set(['exception', 'exceeded-cpu', 'exceeded-memory', 'crashed']);

export default {
  async tail(events: TraceItem[], env: TailEnv): Promise<void> {
    if (!env.ALERT_WEBHOOK) return;

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
        ? `**crash** · outcome: \`${event.outcome}\``
        : `**HTTP ${status}**`;

      const lines = [`🚨 budget-governor ${summary}`, `URL: \`${url}\``];
      if (excs) lines.push(`\`\`\`\n${excs}\n\`\`\``);

      await fetch(env.ALERT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: lines.join('\n') }),
      });
    }
  },
};
