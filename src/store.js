// Tiny JSON-file store. Everything lives in data/db.json so it survives restarts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_DB = {
  holdings: [],          // { id, symbol, shares, costBasis }
  priceAlerts: [],       // { id, symbol, direction: 'above'|'below', target, repeat, active, lastTriggeredAt }
  callRules: [],         // { id, symbol ('*' = every holding), minPremium, premiumBasis, minDte, maxDte, minOtmPct, minAnnualizedPct, requireContracts, active }
  notifications: [],     // { id, type, title, body, symbol, createdAt }
  callNotified: {},      // dedupe map: `${ruleId}|${contractSymbol}` -> ISO timestamp
  settings: {
    quoteIntervalSec: 15,
    optionsIntervalSec: 300,
    callCooldownHours: 24,
    ntfyTopic: '',       // e.g. "my-portfolio-alerts-x7f2" -> push to phone via https://ntfy.sh
    ntfyServer: 'https://ntfy.sh',
    webhookUrl: '',      // optional Discord / Slack-compatible webhook
  },
};

export class Store {
  constructor(file) {
    this.file = file;
    this.db = structuredClone(DEFAULT_DB);
    if (file && fs.existsSync(file)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.db = { ...this.db, ...loaded, settings: { ...this.db.settings, ...(loaded.settings || {}) } };
      } catch (err) {
        console.error(`Could not read ${file}, starting fresh:`, err.message);
      }
    }
    this._timer = null;
  }

  static id() {
    return crypto.randomUUID().slice(0, 8);
  }

  save() {
    if (!this.file) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
