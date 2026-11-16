// Finnhub quotes (free API key from https://finnhub.io, real-time US prices,
// 60 requests/minute). Finnhub's free plan has no option chains, so covered-call
// scans still use Yahoo (see the provider set-up in server.js).

const SPACING_MS = 1100; // stays under 60 requests/minute
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FinnhubProvider {
  constructor(apiKey, { fetchImpl = globalThis.fetch, wait = sleep } = {}) {
    this.name = 'finnhub';
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.wait = wait;
    this.cache = {};
  }

  async getQuotes(symbols) {
    const out = {};
    for (const [i, s] of symbols.entries()) {
      if (i) await this.wait(SPACING_MS);
      // Finnhub writes class shares with a dot: BRK.B
      const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s.replace('-', '.'))}&token=${encodeURIComponent(this.apiKey)}`;
      const res = await this.fetch(url);
      if (res.status === 401 || res.status === 403) throw new Error('Finnhub rejected the API key (check FINNHUB_API_KEY)');
      if (res.status === 429) {
        console.warn('[finnhub] rate limit reached; keeping the last prices this round');
        break;
      }
      if (!res.ok) {
        console.warn(`[finnhub] ${res.status} for ${s}`);
        continue;
      }
      const q = await res.json();
      if (!q || !q.c) {
        console.warn(`[finnhub] no price for ${s} (is the ticker right?)`);
        continue;
      }
      out[s] = {
        symbol: s,
        name: this.cache[s]?.name || s,
        price: q.c,
        regularPrice: q.c,
        prevClose: q.pc,
        change: q.d ?? q.c - q.pc,
        changePct: q.dp ?? (q.pc ? ((q.c - q.pc) / q.pc) * 100 : 0),
        currency: 'USD',
        marketState: 'UNKNOWN',
        session: 'regular',
        time: (q.t || Date.now() / 1000) * 1000,
      };
      this.cache[s] = out[s];
    }
    return out;
  }
}

