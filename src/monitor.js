// Background loops: poll quotes, evaluate price alerts, scan option chains for
// covered-call opportunities, and push everything to connected browsers.
import { evaluatePriceAlert, findCoveredCallMatches, ruleSymbols, sharesBySymbol, filterNew } from './alerts.js';

const fmt = (n) => `$${Number(n).toFixed(2)}`;

export class Monitor {
  constructor({ store, provider, notifier, broadcast }) {
    this.store = store;
    this.provider = provider;
    this.notifier = notifier;
    this.broadcast = broadcast;
    this.quotes = {};
    this.callMatches = {}; // ruleId -> { [symbol]: matches[] }
    this.status = { lastQuoteAt: null, lastOptionsAt: null, quoteError: null, optionsError: null };
  }

  watchedSymbols() {
    const db = this.store.db;
    const set = new Set();
    db.holdings.forEach((h) => set.add(h.symbol));
    db.priceAlerts.filter((a) => a.active).forEach((a) => set.add(a.symbol));
    db.callRules.filter((r) => r.active && r.symbol !== '*').forEach((r) => set.add(r.symbol));
    return [...set];
  }

  start() {
    const loopQuotes = async () => {
      await this.pollQuotes();
      this.quoteTimer = setTimeout(loopQuotes, this.store.db.settings.quoteIntervalSec * 1000);
    };
    const loopOptions = async () => {
      await this.scanCoveredCalls();
      this.optionsTimer = setTimeout(loopOptions, this.store.db.settings.optionsIntervalSec * 1000);
    };
    loopQuotes().then(() => setTimeout(loopOptions, 1000));
  }

  stop() {
    clearTimeout(this.quoteTimer);
    clearTimeout(this.optionsTimer);
  }

  async pollQuotes() {
    const symbols = this.watchedSymbols();
    if (!symbols.length) return;
    try {
      const fresh = await this.provider.getQuotes(symbols);
      Object.assign(this.quotes, fresh);
      this.status.lastQuoteAt = new Date().toISOString();
      this.status.quoteError = null;
      this.broadcast('quotes', { quotes: this.quotes, status: this.status });
      await this.checkPriceAlerts();
    } catch (err) {
      this.status.quoteError = err.message;
      console.warn('[quotes]', err.message);
      this.broadcast('status', this.status);
    }
  }

  async checkPriceAlerts() {
    const db = this.store.db;
    let changed = false;
    for (let i = 0; i < db.priceAlerts.length; i++) {
      const alert = db.priceAlerts[i];
      const q = this.quotes[alert.symbol];
      if (!q) continue;
      const { fire, next } = evaluatePriceAlert(alert, q.price);
      if (next !== alert) {
        db.priceAlerts[i] = next;
        changed = true;
      }
      if (fire) {
        const arrow = alert.direction === 'above' ? '▲' : '▼';
        await this.notifier.notify({
          type: 'price',
          symbol: alert.symbol,
          priority: 'high',
          title: `${arrow} ${alert.symbol} ${alert.direction} ${fmt(alert.target)}`,
          body: `${alert.symbol} is at ${fmt(q.price)} (${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}% today). Target: ${alert.direction} ${fmt(alert.target)}.${alert.note ? ` Note: ${alert.note}` : ''}`,
          data: { alertId: alert.id, price: q.price },
        });
      }
    }
    if (changed) {
      this.store.save();
      this.broadcast('priceAlerts', db.priceAlerts);
    }
  }

  async scanCoveredCalls({ onlyRuleId } = {}) {
    const db = this.store.db;
    const rules = db.callRules.filter((r) => r.active && (!onlyRuleId || r.id === onlyRuleId));
    if (!rules.length) return;
    const shares = sharesBySymbol(db.holdings);

    // Fetch each symbol's chain once, covering the widest DTE window any rule needs.
    const windows = {};
    for (const rule of rules) {
      for (const sym of ruleSymbols(rule, db.holdings)) {
        const w = (windows[sym] ||= { minDte: Infinity, maxDte: 0 });
        w.minDte = Math.min(w.minDte, Number(rule.minDte) || 0);
        w.maxDte = Math.max(w.maxDte, Number(rule.maxDte) || 60);
      }
    }
    const missing = Object.keys(windows).filter((s) => !this.quotes[s]);
    if (missing.length) Object.assign(this.quotes, await this.provider.getQuotes(missing).catch(() => ({})));

    const chains = {};
    const errors = [];
    for (const [sym, w] of Object.entries(windows)) {
      try {
        chains[sym] = await this.provider.getCallChain(sym, w);
      } catch (err) {
        errors.push(`${sym}: ${err.message}`);
      }
    }

    for (const rule of rules) {
      const perSymbol = {};
      for (const sym of ruleSymbols(rule, db.holdings)) {
        const q = this.quotes[sym];
        if (!q || !chains[sym]) continue;
        const matches = findCoveredCallMatches(rule, q.price, chains[sym], shares[sym] || 0);
        perSymbol[sym] = matches.slice(0, 25);
        const fresh = filterNew(matches, rule.id, db.callNotified, db.settings.callCooldownHours);
        if (!fresh.length) continue;
        const best = fresh[0];
        const exp = new Date(best.expiration).toISOString().slice(0, 10);
        const contractsLine = best.contracts
          ? ` Writing ${best.contracts} contract${best.contracts > 1 ? 's' : ''} ≈ ${fmt(best.totalPremium)}.`
          : '';
        await this.notifier.notify({
          type: 'covered-call',
          symbol: sym,
          title: `💰 ${sym} covered call: ${fmt(best.premium)}/sh premium`,
          body:
            `${sym} ${exp} $${best.strike} call — ${rule.premiumBasis || 'bid'} ${fmt(best.premium)} ` +
            `(${best.yieldPct}% / ${best.annualizedPct}% annualized, ${best.otmPct}% OTM, ${best.dte} DTE). ` +
            `Stock at ${fmt(q.price)}.${contractsLine}` +
            (fresh.length > 1 ? ` +${fresh.length - 1} more matching contract${fresh.length > 2 ? 's' : ''}.` : ''),
          data: { ruleId: rule.id, best, count: fresh.length },
        });
        const now = new Date().toISOString();
        for (const m of fresh) db.callNotified[`${rule.id}|${m.contractSymbol}`] = now;
      }
      this.callMatches[rule.id] = perSymbol;
    }

    // Forget dedupe entries older than a week.
    const cutoff = Date.now() - 7 * 86_400_000;
    for (const [k, v] of Object.entries(db.callNotified)) if (Date.parse(v) < cutoff) delete db.callNotified[k];
    this.store.save();

    this.status.lastOptionsAt = new Date().toISOString();
    this.status.optionsError = errors.length ? errors.join('; ') : null;
    this.broadcast('callMatches', { callMatches: this.callMatches, status: this.status });
  }
}
