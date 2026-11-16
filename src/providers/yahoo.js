// Yahoo Finance provider (free, no API key). Uses the same endpoints as the
// finance.yahoo.com website. Quotes are near-real-time for most US exchanges.
//
// Yahoo requires a cookie + "crumb" for the quote and options endpoints. We fetch
// one on startup and refresh it when it expires. Yahoo also rate-limits (HTTP 429):
// when that happens we stop sending requests and back off (1 min, 2 min, … up to 15 min)
// instead of retrying every poll, which would keep the block in place.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://finance.yahoo.com',
  Referer: 'https://finance.yahoo.com/',
};
const DAY_MS = 86_400_000;
const MIN_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const CHART_SPACING_MS = 400; // gap between per-symbol fallback requests
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RateLimitError extends Error {
  constructor(retryAt) {
    super(`Yahoo is rate-limiting requests (HTTP 429). Pausing until ${new Date(retryAt).toLocaleTimeString()}.`);
    this.retryAt = retryAt;
  }
}

export class YahooProvider {
  constructor({ fetchImpl = globalThis.fetch, now = () => Date.now(), wait = sleep } = {}) {
    this.name = 'yahoo';
    this.fetch = fetchImpl;
    this.now = now;
    this.wait = wait;
    this.cookie = '';
    this.crumb = '';
    this.crumbPromise = null;
    this.crumbRetryAt = 0; // after a failed crumb request, use the no-crumb fallback until then
    this.blockedUntil = 0;
    this.backoffMs = MIN_BACKOFF_MS;
  }

  // ---- rate limiting ----
  _checkBlocked() {
    if (this.now() < this.blockedUntil) throw new RateLimitError(this.blockedUntil);
  }

  _onRateLimited(res) {
    const retryAfter = Number(res?.headers?.get?.('retry-after')) * 1000;
    const wait = Math.min(MAX_BACKOFF_MS, Math.max(this.backoffMs, retryAfter || 0));
    this.blockedUntil = this.now() + wait;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    return new RateLimitError(this.blockedUntil);
  }

  _onSuccess() {
    this.backoffMs = MIN_BACKOFF_MS;
  }

  async _fetch(url, opts = {}) {
    this._checkBlocked();
    const res = await this.fetch(url, { ...opts, headers: { ...HEADERS, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(opts.headers || {}) } });
    if (res.status === 429) throw this._onRateLimited(res);
    return res;
  }

  // ---- crumb ----
  async _ensureCrumb(force = false) {
    if (this.crumb && !force) return;
    if (this.now() < this.crumbRetryAt) throw new Error('no Yahoo crumb (will retry later)');
    if (!this.crumbPromise) {
      this.crumbPromise = (async () => {
        try {
          // fc.yahoo.com returns 404 but sets the session cookie we need.
          const r1 = await this._fetch('https://fc.yahoo.com', { redirect: 'manual' });
          const setCookies = typeof r1.headers.getSetCookie === 'function' ? r1.headers.getSetCookie() : [];
          if (setCookies.length) this.cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
          let lastStatus = 0;
          for (const host of ['query1', 'query2']) {
            const r2 = await this._fetch(`https://${host}.finance.yahoo.com/v1/test/getcrumb`);
            const crumb = (await r2.text()).trim();
            lastStatus = r2.status;
            if (r2.ok && crumb && !crumb.includes('<') && !crumb.includes(' ')) {
              this.crumb = crumb;
              this._onSuccess();
              return;
            }
          }
          throw new Error(`crumb request failed (${lastStatus})`);
        } catch (err) {
          this.crumbRetryAt = this.now() + 10 * 60_000;
          throw err;
        }
      })().finally(() => {
        this.crumbPromise = null;
      });
    }
    await this.crumbPromise;
  }

  async _getJson(url, { auth = true } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (auth) await this._ensureCrumb(attempt > 0);
      const u = new URL(url);
      if (auth) u.searchParams.set('crumb', this.crumb);
      const res = await this._fetch(u);
      if ((res.status === 401 || res.status === 403) && auth && attempt === 0) {
        this.crumb = '';
        continue; // stale crumb
      }
      if (!res.ok) throw new Error(`Yahoo ${res.status} for ${u.pathname}`);
      this._onSuccess();
      return res.json();
    }
    throw new Error('Yahoo sign-in (crumb) was refused');
  }

  // ---- quotes ----
  async getQuotes(symbols) {
    if (!symbols.length) return {};
    this._checkBlocked();
    try {
      return await this._batchQuotes(symbols);
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      if (!this._warnedFallback) {
        console.warn(`[yahoo] quote endpoint unavailable (${err.message}); using the per-symbol chart endpoint.`);
        this._warnedFallback = true;
      }
      return this._chartQuotes(symbols);
    }
  }

  async _batchQuotes(symbols) {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}`;
    const json = await this._getJson(url);
    this._warnedFallback = false;
    const out = {};
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
        time: (q.regularMarketTime || this.now() / 1000) * 1000,
      };
    }
    return out;
  }

  // Fallback: the chart endpoint needs no crumb, but it's one request per symbol,
  // so requests are spaced out and we stop at the first rate-limit response.
  async _chartQuotes(symbols) {
    // One request per symbol is expensive: refresh each symbol at most once a minute.
    this.chartCache ||= {};
    const fresh = (s) => this.chartCache[s] && this.now() - this.chartCache[s].fetchedAt < 60_000;
    const out = {};
    for (const s of symbols) if (fresh(s)) out[s] = this.chartCache[s].quote;
    const todo = symbols.filter((s) => !fresh(s));
    for (const [i, s] of todo.entries()) {
      if (i) await this.wait(CHART_SPACING_MS);
      try {
        const json = await this._getJson(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=5d`,
          { auth: false },
        );
        const m = json?.chart?.result?.[0]?.meta;
        if (!m) continue;
        const closes = json.chart.result[0].indicators?.quote?.[0]?.close?.filter((c) => c != null) || [];
        const prevClose = m.previousClose ?? (closes.length > 1 ? closes[closes.length - 2] : m.chartPreviousClose);
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
          time: (m.regularMarketTime || this.now() / 1000) * 1000,
        };
        this.chartCache[s] = { quote: out[s], fetchedAt: this.now() };
      } catch (err) {
        if (err instanceof RateLimitError) {
          if (Object.keys(out).length) return out; // keep what we got; the rest waits for the backoff
          throw err;
        }
        console.warn(`[yahoo] no price for ${s}: ${err.message}`);
      }
    }
    return out;
  }

  // ---- options ----
  // Returns call contracts expiring within [minDte, maxDte] days.
  async getCallChain(symbol, { minDte = 0, maxDte = 60 } = {}) {
    const base = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
    const first = await this._getJson(base);
    const result = first?.optionChain?.result?.[0];
    if (!result) return [];
    const now = this.now();
    const wanted = (result.expirationDates || []).filter((ts) => {
      const dte = (ts * 1000 - now) / DAY_MS;
      return dte >= minDte - 1 && dte <= maxDte + 1;
    });

    const chains = [];
    for (const ts of wanted) {
      let json = first;
      if (ts !== result.options?.[0]?.expirationDate) {
        await this.wait(CHART_SPACING_MS);
        json = await this._getJson(`${base}?date=${ts}`);
      }
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
