// Delivers alerts to: the web app (live via SSE -> browser notifications),
// ntfy.sh (free phone/desktop push, works even when the browser is closed),
// and an optional Discord/Slack-style webhook.
import { Store } from './store.js';

export class Notifier {
  constructor(store, broadcast) {
    this.store = store;
    this.broadcast = broadcast;
  }

  async notify({ type, title, body, symbol, priority = 'default', data }) {
    const n = { id: Store.id(), type, title, body, symbol, data, createdAt: new Date().toISOString() };
    const list = this.store.db.notifications;
    list.unshift(n);
    if (list.length > 300) list.length = 300;
    this.store.save();
    this.broadcast('notification', n);
    console.log(`[alert] ${title} — ${body}`);

    const { ntfyTopic, ntfyServer, webhookUrl } = this.store.db.settings;
    const jobs = [];
    if (ntfyTopic) {
      jobs.push(
        fetch(`${(ntfyServer || 'https://ntfy.sh').replace(/\/$/, '')}/${encodeURIComponent(ntfyTopic)}`, {
          method: 'POST',
          body,
          headers: {
            Title: asciiHeader(title),
            Priority: priority,
            Tags: type === 'price' ? 'chart_with_upwards_trend' : 'moneybag',
          },
        }),
      );
    }
    if (webhookUrl) {
      const text = `**${title}**\n${body}`;
      jobs.push(
        fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text, text }), // Discord uses content, Slack uses text
        }),
      );
    }
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === 'rejected') console.warn('[notify] delivery failed:', r.reason?.message);
    return n;
  }
}

// HTTP header values must be Latin-1; strip anything else (e.g. emoji).
function asciiHeader(s) {
  return String(s).replace(/[^\x20-\x7E]/g, '').trim() || 'Portfolio alert';
}
