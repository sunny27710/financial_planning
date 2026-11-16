// Simulated market data for demos and offline development (DATA_PROVIDER=mock).
// Prices follow a random walk; call premiums are priced with Black-Scholes.

const DAY_MS = 86_400_000;
// Starting prices (approximate mid-November 2026 levels) and volatility per symbol.
const BASE = {
  SCHD: 36.12, VOO: 693.38, VUG: 480, QQQ: 679.9, VT: 140, VXUS: 75, JEPQ: 56.2, O: 58.82,
  GOOGL: 290, AMZN: 266.66, MSFT: 500, 'BRK-B': 500, DIVSTOCKS: 100,
  AAPL: 230, NVDA: 140, TSLA: 250, META: 560, SPY: 640, AMD: 150,
};
const VOL = { SCHD: 0.14, VOO: 0.15, VUG: 0.19, QQQ: 0.2, VT: 0.14, VXUS: 0.15, JEPQ: 0.16, O: 0.2, 'BRK-B': 0.18, DIVSTOCKS: 0.15 };
const NAMES = {
  SCHD: 'Schwab US Dividend Equity ETF', VOO: 'Vanguard S&P 500 ETF', VUG: 'Vanguard Growth ETF', QQQ: 'Invesco QQQ Trust',
  VT: 'Vanguard Total World Stock ETF', VXUS: 'Vanguard Total International Stock ETF', JEPQ: 'JPMorgan Nasdaq Equity Premium Income ETF',
  O: 'Realty Income (REIT)', GOOGL: 'Alphabet (Google)', AMZN: 'Amazon', MSFT: 'Microsoft', 'BRK-B': 'Berkshire Hathaway B',
  DIVSTOCKS: 'Dividend stocks (basket)',
};
// Holdings that aren't a single optionable ticker.
const NO_OPTIONS = new Set(['DIVSTOCKS']);

function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function normCdf(x) {
  // Abramowitz & Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

export function blackScholesCall(S, K, T, sigma, r = 0.04) {
  if (T <= 0) return Math.max(0, S - K);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
}

export class MockProvider {
  constructor() {
    this.name = 'mock';
    this.state = {}; // symbol -> { price, prevClose, vol }
  }

  _sym(symbol) {
    if (!this.state[symbol]) {
      const h = hash(symbol);
      const base = BASE[symbol] ?? 20 + (h % 300);
      this.state[symbol] = { price: base, prevClose: base * (1 + ((h % 7) - 3) / 200), vol: VOL[symbol] ?? 0.25 + (h % 30) / 100 };
    }
    return this.state[symbol];
  }

  async getQuotes(symbols) {
    const out = {};
    for (const s of symbols) {
      const st = this._sym(s);
      // ~0.15% std-dev move per tick
      st.price = Math.max(0.5, st.price * (1 + (Math.random() - 0.5) * 0.005));
      out[s] = {
        symbol: s,
        name: `${NAMES[s] || s} (simulated)`,
        price: +st.price.toFixed(2),
        regularPrice: +st.price.toFixed(2),
        prevClose: +st.prevClose.toFixed(2),
        change: st.price - st.prevClose,
        changePct: ((st.price - st.prevClose) / st.prevClose) * 100,
        currency: 'USD',
        marketState: 'REGULAR',
        session: 'regular',
        time: Date.now(),
      };
    }
    return out;
  }

  async getCallChain(symbol, { minDte = 0, maxDte = 60 } = {}) {
    if (NO_OPTIONS.has(symbol)) return [];
    const st = this._sym(symbol);
    const S = st.price;
    const now = new Date();
    const contracts = [];
    // Weekly Friday expirations
    const d = new Date(now);
    d.setUTCHours(20, 0, 0, 0);
    while (d.getUTCDay() !== 5 || d <= now) d.setTime(d.getTime() + DAY_MS);
    for (; ; d.setTime(d.getTime() + 7 * DAY_MS)) {
      const dte = Math.ceil((d - now) / DAY_MS);
      if (dte > maxDte) break;
      if (dte < minDte) continue;
      const step = S < 50 ? 1 : S < 200 ? 2.5 : 5;
      const atm = Math.round(S / step) * step;
      for (let i = -4; i <= 12; i++) {
        const K = +(atm + i * step).toFixed(2);
        if (K <= 0) continue;
        const mid = blackScholesCall(S, K, dte / 365, st.vol);
        const spread = Math.max(0.01, mid * 0.04);
        const yymmdd = d.toISOString().slice(2, 10).replaceAll('-', '');
        contracts.push({
          contractSymbol: `${symbol}${yymmdd}C${String(Math.round(K * 1000)).padStart(8, '0')}`,
          strike: K,
          bid: +Math.max(0, mid - spread / 2).toFixed(2),
          ask: +(mid + spread / 2).toFixed(2),
          last: +mid.toFixed(2),
          expiration: d.getTime(),
          dte,
          openInterest: 100 + (hash(symbol + K) % 5000),
          volume: hash(symbol + K + dte) % 800,
          iv: st.vol,
        });
      }
    }
    return contracts;
  }
}
