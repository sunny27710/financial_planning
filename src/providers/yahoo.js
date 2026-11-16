// Yahoo Finance provider (free, no API key). Uses the same endpoints as the
// finance.yahoo.com website. Quotes are near-real-time for most US exchanges.
//
// Yahoo requires a cookie + "crumb" for the quote and options endpoints. We fetch
// one on startup and refresh it automatically when it expires.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DAY_MS = 86_400_000;

export class YahooProvider {
  constructor() {
    this.name = 'yahoo';
    this.cookie = '';
    this.crumb = '';
    this.crumbPromise = null;
  }

  async _ensureCrumb(force = false) {
    if (this.crumb && !force) return;
    if (!this.crumbPromise) {
      this.crumbPromise = (async () => {
        // fc.yahoo.com returns 404 but sets the session cookie we need.
        const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
        const setCookies = typeof r1.headers.getSetCookie === 'function' ? r1.headers.getSetCookie() : [];
        this.cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
        const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
          headers: { 'User-Agent': UA, Cookie: this.cookie },
        });
        const crumb = (await r2.text()).trim();
        if (!r2.ok || !crumb || crumb.includes('<')) throw new Error(`crumb request failed (${r2.status})`);
        this.crumb = crumb;
      })().finally(() => {
        this.crumbPromise = null;
      });
    }
    await this.crumbPromise;
  }

  async _get(url, { auth = true } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (auth) await this._ensureCrumb(attempt > 0);
      const u = new URL(url);
      if (auth) u.searchParams.set('crumb', this.crumb);
      const res = await fetch(u, { headers: { 'User-Agent': UA, Cookie: this.cookie, Accept: 'application/json' } });
      if ((res.status === 401 || res.status === 403) && auth && attempt === 0) continue; // stale crumb
      if (!res.ok) throw new Error(`Yahoo ${res.status} for ${u.pathname}`);
      return res.json();
    }
    throw new Error('Yahoo auth failed');
  }

  async getQuotes(symbols) {
    if (!symbols.length) return {};
    const out = {};
    try {
      const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}`;
      const json = await this._get(url);
      for (const q of json?.quoteResponse?.result || []) {
        // Use extended-hours price when the market is closed and it's available.
        let price = q.regularMarketPrice;
        let session = 'regular';
        if (q.marketState?.startsWith('PRE') && q.preMarketPrice) {
          price = q.preMarketPrice;
          session = 'pre';
        } else if ((q.marketState?.startsWith('POST') || q.marketState === 'CLOSED') && q.postMarketPrice) {
          price = q.postMarketPrice;
          session = 'post';
        }
        const prevClose = q.regularMarketPreviousClose ?? q.previousClose;
        out[q.symbol] = {
          symbol: q.symbol,
          name: q.shortName || q.longName || q.symbol,
          price,
          regularPrice: q.regularMarketPrice,
          prevClose,
          change: price - prevClose,
          changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
          currency: q.currency,
          marketState: q.marketState,
          session,
          time: (q.regularMarketTime || Date.now() / 1000) * 1000,
        };
      }
    } catch (err) {
      // Fallback: the chart endpoint doesn't need a crumb (one request per symbol).
      console.warn('[yahoo] quote endpoint failed, using chart fallback:', err.message);
      await Promise.all(
        symbols.map(async (s) => {
          try {
            const json = await this._get(
              `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1m&range=1d`,
              { auth: false },
            );
            const m = json?.chart?.result?.[0]?.meta;
            if (!m) return;
            const prevClose = m.chartPreviousClose ?? m.previousClose;
            out[s] = {
              symbol: s,
              name: m.shortName || m.longName || s,
              price: m.regularMarketPrice,
              regularPrice: m.regularMarketPrice,
              prevClose,
              change: m.regularMarketPrice - prevClose,
              changePct: prevClose ? ((m.regularMarketPrice - prevClose) / prevClose) * 100 : 0,
              currency: m.currency,
              marketState: 'UNKNOWN',
              session: 'regular',
              time: (m.regularMarketTime || Date.now() / 1000) * 1000,
            };
          } catch (e) {
            console.warn(`[yahoo] chart fallback failed for ${s}:`, e.message);
          }
        }),
      );
    }
    return out;
  }

  // Returns call contracts expiring within [minDte, maxDte] days.
  async getCallChain(symbol, { minDte = 0, maxDte = 60 } = {}) {
    const base = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
    const first = await this._get(base);
    const result = first?.optionChain?.result?.[0];
    if (!result) return [];
    const now = Date.now();
    const wanted = (result.expirationDates || []).filter((ts) => {
      const dte = (ts * 1000 - now) / DAY_MS;
      return dte >= minDte - 1 && dte <= maxDte + 1;
    });

    const chains = [];
    for (const ts of wanted) {
      const json =
        ts === result.options?.[0]?.expirationDate ? first : await this._get(`${base}?date=${ts}`);
      const calls = json?.optionChain?.result?.[0]?.options?.[0]?.calls || [];
      for (const c of calls) {
        const expiration = c.expiration * 1000;
        chains.push({
          contractSymbol: c.contractSymbol,
          strike: c.strike,
          bid: c.bid ?? 0,
          ask: c.ask ?? 0,
          last: c.lastPrice ?? 0,
          expiration,
          dte: Math.max(0, Math.ceil((expiration - now) / DAY_MS)),
          openInterest: c.openInterest ?? 0,
          volume: c.volume ?? 0,
          iv: c.impliedVolatility ?? null,
        });
      }
    }
    return chains;
  }
}
