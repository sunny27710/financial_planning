// In-browser stand-in for server.js + monitor.js, used only by the standalone demo.
// It reuses the real alert logic (src/alerts.js) and simulated data (src/providers/mock.js).
(function () {
  const KEY = 'portfolio-demo-v1';
  const uid = () => Math.random().toString(36).slice(2, 10);
  const nowIso = () => new Date().toISOString();
  const seed = () => ({
    holdings: [
      { id: uid(), symbol: 'AAPL', shares: 200, costBasis: 180 },
      { id: uid(), symbol: 'NVDA', shares: 300, costBasis: 95 },
      { id: uid(), symbol: 'MSFT', shares: 50, costBasis: 390 },
    ],
    priceAlerts: [
      { id: uid(), symbol: 'NVDA', direction: 'above', target: 142, repeat: true, note: 'Example: consider trimming', active: true },
      { id: uid(), symbol: 'MSFT', direction: 'below', target: 415, repeat: false, note: 'Example: add on dip', active: true },
    ],
    callRules: [
      { id: uid(), symbol: '*', minPremium: 4, premiumBasis: 'bid', minDte: 7, maxDte: 45, minOtmPct: 3, minAnnualizedPct: 0, requireShares: false, active: true },
    ],
    notifications: [],
    callNotified: {},
    settings: { quoteIntervalSec: 3, optionsIntervalSec: 60, callCooldownHours: 24, ntfyTopic: '', ntfyServer: 'https://ntfy.sh', webhookUrl: '' },
  });
  let db;
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch {}
  if (!db || !db.settings) db = seed();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };

  const provider = new MockProvider();
  const quotes = {};
  const callMatches = {};
  const status = { lastQuoteAt: null, lastOptionsAt: null, quoteError: null, optionsError: null };
  const listeners = {};
  const emit = (ev, data) => (listeners[ev] || []).forEach((fn) => fn({ data: JSON.stringify(data) }));

  window.EventSource = class {
    constructor() { setTimeout(() => { emit('open', {}); emit('state', state()); }, 0); }
    addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); }
  };

  const state = () => ({ provider: 'mock', holdings: db.holdings, priceAlerts: db.priceAlerts, callRules: db.callRules,
    notifications: db.notifications.slice(0, 100), settings: db.settings, quotes, callMatches, status });

  function notify({ type, title, body, symbol }) {
    const n = { id: uid(), type, title, body, symbol, createdAt: nowIso() };
    db.notifications.unshift(n);
    if (db.notifications.length > 300) db.notifications.length = 300;
    save();
    emit('notification', n);
    const t = db.settings.ntfyTopic;
    if (t) fetchReal(`${(db.settings.ntfyServer || 'https://ntfy.sh').replace(/\/$/, '')}/${encodeURIComponent(t)}`, { method: 'POST', body }).catch(() => {});
  }

  function watched() {
    const s = new Set();
    db.holdings.forEach((h) => s.add(h.symbol));
    db.priceAlerts.filter((a) => a.active).forEach((a) => s.add(a.symbol));
    db.callRules.filter((r) => r.active && r.symbol !== '*').forEach((r) => s.add(r.symbol));
    return [...s];
  }

  async function pollQuotes() {
    const syms = watched();
    if (!syms.length) return;
    Object.assign(quotes, await provider.getQuotes(syms));
    status.lastQuoteAt = nowIso();
    emit('quotes', { quotes, status });
    let changed = false;
    db.priceAlerts = db.priceAlerts.map((a) => {
      const q = quotes[a.symbol];
      if (!q) return a;
      const { fire, next } = evaluatePriceAlert(a, q.price);
      if (next !== a) changed = true;
      if (fire) notify({ type: 'price', symbol: a.symbol,
        title: `${a.direction === 'above' ? '▲' : '▼'} ${a.symbol} ${a.direction} $${a.target.toFixed(2)}`,
        body: `${a.symbol} is at $${q.price.toFixed(2)} (${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}% today). Target: ${a.direction} $${a.target.toFixed(2)}.${a.note ? ` Note: ${a.note}` : ''}` });
      return next;
    });
    if (changed) { save(); emit('priceAlerts', db.priceAlerts); }
  }

  async function scan(onlyRuleId) {
    const rules = db.callRules.filter((r) => r.active && (!onlyRuleId || r.id === onlyRuleId));
    const shares = sharesBySymbol(db.holdings);
    for (const rule of rules) {
      const per = {};
      for (const sym of ruleSymbols(rule, db.holdings)) {
        if (!quotes[sym]) Object.assign(quotes, await provider.getQuotes([sym]));
        const q = quotes[sym];
        const chain = await provider.getCallChain(sym, { minDte: rule.minDte, maxDte: rule.maxDte });
        const matches = findCoveredCallMatches(rule, q.price, chain, shares[sym] || 0);
        per[sym] = matches.slice(0, 25);
        const fresh = filterNew(matches, rule.id, db.callNotified, db.settings.callCooldownHours);
        if (!fresh.length) continue;
        const b = fresh[0];
        notify({ type: 'covered-call', symbol: sym,
          title: `💰 ${sym} covered call: $${b.premium.toFixed(2)}/sh premium`,
          body: `${sym} ${new Date(b.expiration).toISOString().slice(0, 10)} $${b.strike} call — ${rule.premiumBasis} $${b.premium.toFixed(2)} (${b.yieldPct}% / ${b.annualizedPct}% annualized, ${b.otmPct}% OTM, ${b.dte} DTE). Stock at $${q.price.toFixed(2)}.` +
            (b.contracts ? ` Writing ${b.contracts} contract${b.contracts > 1 ? 's' : ''} ≈ $${b.totalPremium.toFixed(2)}.` : '') +
            (fresh.length > 1 ? ` +${fresh.length - 1} more matching.` : '') });
        fresh.forEach((m) => (db.callNotified[`${rule.id}|${m.contractSymbol}`] = nowIso()));
      }
      callMatches[rule.id] = per;
    }
    save();
    status.lastOptionsAt = nowIso();
    emit('callMatches', { callMatches, status });
  }

  const sym = (s) => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9.\-^=*]/g, '');
  const num = (v, d = null) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v));
  const clean = {
    holdings: (b) => { const h = { symbol: sym(b.symbol), shares: num(b.shares, 0), costBasis: num(b.costBasis, 0) }; if (!h.symbol) throw new Error('Enter a ticker symbol.'); return h; },
    priceAlerts: (b, p = {}) => { const a = { symbol: sym(b.symbol ?? p.symbol), direction: (b.direction ?? p.direction) === 'below' ? 'below' : 'above', target: num(b.target ?? p.target), repeat: Boolean(b.repeat ?? p.repeat), note: String(b.note ?? p.note ?? ''), active: b.active ?? p.active ?? true };
      if (!a.symbol) throw new Error('Enter a ticker symbol.'); if (!(a.target > 0)) throw new Error('Enter a target price above 0.'); return a; },
    callRules: (b, p = {}) => { const g = (k, d) => b[k] ?? p[k] ?? d; const r = { symbol: g('symbol', '*') === '*' ? '*' : sym(g('symbol')), minPremium: num(g('minPremium'), 0), premiumBasis: ['bid', 'mid', 'last'].includes(g('premiumBasis')) ? g('premiumBasis') : 'bid', minDte: num(g('minDte'), 0), maxDte: num(g('maxDte'), 45), minOtmPct: num(g('minOtmPct'), 0), minAnnualizedPct: num(g('minAnnualizedPct'), 0), requireShares: Boolean(g('requireShares', false)), active: g('active', true) };
      if (!r.symbol) throw new Error('Enter a ticker, or * for all holdings.'); if (r.maxDte < r.minDte) throw new Error('Max days must be at least min days.'); return r; },
  };
  const coll = { holdings: 'holdings', 'price-alerts': 'priceAlerts', 'call-rules': 'callRules' };

  async function handle(method, path, body) {
    const [, , resource, id, action] = path.split('/');
    if (coll[resource]) {
      const key = coll[resource]; const items = db[key];
      if (!id && method === 'POST') { const item = { id: uid(), ...clean[key](body) }; items.push(item); save(); after(resource, item); return item; }
      const i = items.findIndex((x) => x.id === id);
      if (i < 0) throw new Error('Not found');
      if (action === 'scan') { await scan(id); return {}; }
      if (method === 'DELETE') { const [r] = items.splice(i, 1); delete callMatches[r.id]; save(); emit('state', state()); return r; }
      const u = { ...items[i], ...clean[key](body, items[i]) }; if (key === 'priceAlerts') u.armed = true;
      items[i] = u; save(); after(resource, u); return u;
    }
    if (resource === 'settings') {
      const s = db.settings;
      s.quoteIntervalSec = Math.max(2, num(body.quoteIntervalSec, s.quoteIntervalSec));
      s.optionsIntervalSec = Math.max(15, num(body.optionsIntervalSec, s.optionsIntervalSec));
      s.callCooldownHours = Math.max(0, num(body.callCooldownHours, s.callCooldownHours));
      ['ntfyTopic', 'ntfyServer', 'webhookUrl'].forEach((k) => body[k] !== undefined && (s[k] = String(body[k]).trim()));
      save(); emit('state', state()); return s;
    }
    if (resource === 'notifications') { db.notifications = []; save(); emit('state', state()); return {}; }
    if (resource === 'test-notification') { notify({ type: 'test', title: 'Test notification', body: 'Notifications are working.' }); return {}; }
    throw new Error('Not found');
  }
  function after(resource, item) { emit('state', state()); if (resource === 'call-rules') scan(item.id); else pollQuotes(); }

  const fetchReal = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    if (typeof url !== 'string' || !url.startsWith('/api/')) return fetchReal(url, opts);
    try {
      const out = await handle(opts.method || 'GET', url, opts.body ? JSON.parse(opts.body) : {});
      return new Response(JSON.stringify(out), { status: 200 });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 400 });
    }
  };

  // The artifact viewer blocks alert()/confirm(): show errors as toasts, skip confirmations.
  window.alert = (msg) => { const t = document.createElement('div'); t.className = 'toast price'; t.innerHTML = '<div class="t"></div>'; t.firstChild.textContent = msg; document.getElementById('toasts').prepend(t); setTimeout(() => t.remove(), 6000); };
  window.confirm = () => true;

  // Demo controls
  window.demo = {
    shock(pct) {
      for (const s of Object.values(provider.state)) s.price *= 1 + pct / 100;
      pollQuotes();
    },
    reset() { try { localStorage.removeItem(KEY); } catch {} db = seed(); Object.keys(callMatches).forEach((k) => delete callMatches[k]); emit('state', state()); pollQuotes().then(() => scan()); },
  };

  (function loopQ() { pollQuotes().finally(() => setTimeout(loopQ, db.settings.quoteIntervalSec * 1000)); })();
  setTimeout(function loopO() { scan().finally(() => setTimeout(loopO, db.settings.optionsIntervalSec * 1000)); }, 800);
})();
