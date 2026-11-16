// Portfolio tracker server: REST API + Server-Sent Events + static frontend.
// Zero dependencies — just Node 18.17+.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './src/store.js';
import { Notifier } from './src/notifier.js';
import { Monitor } from './src/monitor.js';
import { YahooProvider } from './src/providers/yahoo.js';
import { MockProvider } from './src/providers/mock.js';
import { sharesFromAmount, parsePortfolioCsv, holdingsFromRows } from './src/holdings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.APP_PASSWORD || ''; // set this if you expose the app beyond localhost
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');

const store = new Store(DB_FILE);
const provider = process.env.DATA_PROVIDER === 'mock' ? new MockProvider() : new YahooProvider();

const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

const notifier = new Notifier(store, broadcast);
const monitor = new Monitor({ store, provider, notifier, broadcast });

// ---------- helpers ----------
const sym = (s) => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9.\-^=*]/g, '');
const num = (v, d = null) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v));

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function state() {
  return {
    provider: provider.name,
    holdings: store.db.holdings,
    priceAlerts: store.db.priceAlerts,
    callRules: store.db.callRules,
    notifications: store.db.notifications.slice(0, 100),
    settings: store.db.settings,
    quotes: monitor.quotes,
    callMatches: monitor.callMatches,
    status: monitor.status,
  };
}

function cleanHolding(b) {
  const h = { symbol: sym(b.symbol), shares: num(b.shares, 0), costBasis: num(b.costBasis, 0) };
  if (!h.symbol) throw new Error('symbol is required');
  return h;
}

function cleanPriceAlert(b, prev = {}) {
  const a = {
    symbol: sym(b.symbol ?? prev.symbol),
    direction: (b.direction ?? prev.direction) === 'below' ? 'below' : 'above',
    target: num(b.target ?? prev.target),
    repeat: Boolean(b.repeat ?? prev.repeat),
    note: String(b.note ?? prev.note ?? '').slice(0, 200),
    active: b.active ?? prev.active ?? true,
  };
  if (!a.symbol) throw new Error('symbol is required');
  if (a.target == null || a.target <= 0) throw new Error('target price must be a positive number');
  return a;
}

function cleanCallRule(b, prev = {}) {
  const pick = (k, d) => b[k] ?? prev[k] ?? d;
  const r = {
    symbol: pick('symbol', '*') === '*' ? '*' : sym(pick('symbol')),
    minPremium: num(pick('minPremium'), 0),
    premiumBasis: ['bid', 'mid', 'last'].includes(pick('premiumBasis')) ? pick('premiumBasis') : 'bid',
    minDte: num(pick('minDte'), 0),
    maxDte: num(pick('maxDte'), 45),
    minOtmPct: num(pick('minOtmPct'), 0),
    minAnnualizedPct: num(pick('minAnnualizedPct'), 0),
    requireShares: Boolean(pick('requireShares', false)),
    active: pick('active', true),
  };
  if (!r.symbol) throw new Error('symbol is required (or * for all holdings)');
  if (r.maxDte < r.minDte) throw new Error('max DTE must be >= min DTE');
  if (r.maxDte > 730) throw new Error('max DTE must be <= 730');
  return r;
}

// ---------- routes ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', resource, id?, action?]
  const [, resource, id, action] = parts;
  const m = req.method;
  const db = store.db;

  if (resource === 'stream' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (resource === 'state' && m === 'GET') return send(res, 200, state());

  const collections = {
    holdings: { list: 'holdings', clean: cleanHolding },
    'price-alerts': { list: 'priceAlerts', clean: cleanPriceAlert },
    'call-rules': { list: 'callRules', clean: cleanCallRule },
  };

  if (collections[resource]) {
    const { list, clean } = collections[resource];
    const items = db[list];
    if (!id && m === 'POST') {
      let body = await readBody(req);
      // Holdings can be entered as a dollar amount instead of shares.
      if (resource === 'holdings' && !num(body.shares) && num(body.amount) > 0) {
        body = await sharesFromAmount(provider, sym(body.symbol), num(body.amount));
      }
      const item = { id: Store.id(), ...clean(body), createdAt: new Date().toISOString() };
      items.push(item);
      store.save();
      afterChange(resource, item);
      return send(res, 201, item);
    }
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) return send(res, 404, { error: 'not found' });

    if (action === 'scan' && resource === 'call-rules' && m === 'POST') {
      await monitor.scanCoveredCalls({ onlyRuleId: id });
      return send(res, 200, { matches: monitor.callMatches[id] || {} });
    }
    if (!action && (m === 'PUT' || m === 'PATCH')) {
      const body = await readBody(req);
      const updated = { ...items[idx], ...clean(body, items[idx]) };
      // Editing an alert re-arms it.
      if (resource === 'price-alerts') updated.armed = true;
      items[idx] = updated;
      store.save();
      afterChange(resource, updated);
      return send(res, 200, updated);
    }
    if (!action && m === 'DELETE') {
      const [removed] = items.splice(idx, 1);
      if (resource === 'call-rules') delete monitor.callMatches[removed.id];
      store.save();
      broadcast('state', state());
      return send(res, 200, removed);
    }
  }

  if (resource === 'settings' && m === 'PUT') {
    const b = await readBody(req);
    const s = db.settings;
    s.quoteIntervalSec = Math.max(5, num(b.quoteIntervalSec, s.quoteIntervalSec));
    s.optionsIntervalSec = Math.max(60, num(b.optionsIntervalSec, s.optionsIntervalSec));
    s.callCooldownHours = Math.max(0, num(b.callCooldownHours, s.callCooldownHours));
    if (b.ntfyTopic !== undefined) s.ntfyTopic = String(b.ntfyTopic).trim();
    if (b.ntfyServer !== undefined) s.ntfyServer = String(b.ntfyServer).trim() || 'https://ntfy.sh';
    if (b.webhookUrl !== undefined) s.webhookUrl = String(b.webhookUrl).trim();
    store.save();
    broadcast('state', state());
    return send(res, 200, s);
  }

  if (resource === 'notifications' && m === 'DELETE') {
    db.notifications = [];
    store.save();
    broadcast('state', state());
    return send(res, 200, { ok: true });
  }

  if (resource === 'test-notification' && m === 'POST') {
    const n = await notifier.notify({ type: 'test', title: 'Test notification', body: 'Notifications are working 🎉' });
    return send(res, 200, n);
  }

  send(res, 404, { error: 'not found' });
}

function afterChange(resource, item) {
  broadcast('state', state());
  // Fetch data for new symbols right away instead of waiting for the next tick.
  if (resource === 'call-rules') monitor.scanCoveredCalls({ onlyRuleId: item.id }).catch(() => {});
  else monitor.pollQuotes().catch(() => {});
}

// ---------- static files ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const PUBLIC = path.join(__dirname, 'public');

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function authorized(req) {
  if (!PASSWORD) return true;
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const pass = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
  return pass === PASSWORD;
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Portfolio"' });
    return res.end('Authentication required');
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    send(res, 400, { error: err.message });
  }
});

// On first run, load holdings from portfolio.csv (if present).
async function importPortfolioCsv() {
  const file = process.env.PORTFOLIO_CSV || path.join(__dirname, 'portfolio.csv');
  if (store.db.holdings.length || !fs.existsSync(file)) return;
  console.log(`Loading holdings from ${path.basename(file)}…`);
  try {
    const { holdings, problems } = await holdingsFromRows(provider, parsePortfolioCsv(fs.readFileSync(file, 'utf8')));
    for (const h of holdings) store.db.holdings.push({ id: Store.id(), ...h, createdAt: new Date().toISOString() });
    store.save();
    const total = holdings.reduce((t, h) => t + h.shares * h.costBasis, 0);
    console.log(`  Added ${holdings.length} holdings ($${Math.round(total).toLocaleString()} total).`);
    for (const p of problems) console.warn(`  Skipped ${p}`);
  } catch (err) {
    console.error(`  Could not load ${path.basename(file)}: ${err.message}. Restart the app to try again.`);
  }
}

server.listen(PORT, HOST, async () => {
  console.log(`Portfolio tracker running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (data: ${provider.name})`);
  await importPortfolioCsv();
  monitor.start();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    monitor.stop();
    store.flush();
    process.exit(0);
  });
}
