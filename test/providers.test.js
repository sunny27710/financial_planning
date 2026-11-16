import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YahooProvider, RateLimitError } from '../src/providers/yahoo.js';
import { FinnhubProvider } from '../src/providers/finnhub.js';

// Minimal fake of the fetch API. `routes` maps a URL substring to a handler returning [status, body].
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    url = String(url);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const [status, body, headers = {}] = key ? routes[key](url) : [404, ''];
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (h) => headers[h.toLowerCase()] ?? null, getSetCookie: () => ['A3=abc; Path=/'] },
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}
const chart = (price) => [200, { chart: { result: [{ meta: { regularMarketPrice: price, previousClose: price - 1, currency: 'USD' } }] } }];

test('429 on the quote endpoint pauses all Yahoo requests instead of retrying', async () => {
  let t = 1_000_000;
  const f = fakeFetch({
    'fc.yahoo.com': () => [404, ''],
    getcrumb: () => [200, 'crumb123'],
    'v7/finance/quote': () => [429, 'Too Many Requests'],
  });
  const y = new YahooProvider({ fetchImpl: f, now: () => t, wait: async () => {} });
  await assert.rejects(y.getQuotes(['GOOG', 'VOO']), RateLimitError);
  const n = f.calls.length;
  await assert.rejects(y.getQuotes(['GOOG']), RateLimitError);
  assert.equal(f.calls.length, n, 'no requests while paused');
  t += 61_000; // after the 1-minute backoff, it tries again
  await assert.rejects(y.getQuotes(['GOOG']), RateLimitError);
  assert.ok(f.calls.length > n);
  t += 61_000; // second backoff is 2 minutes, so still paused
  const m = f.calls.length;
  await assert.rejects(y.getQuotes(['GOOG']), RateLimitError);
  assert.equal(f.calls.length, m);
});

test('without a crumb, falls back to per-symbol chart requests and caches them for a minute', async () => {
  let t = 1_000_000;
  const f = fakeFetch({
    'fc.yahoo.com': () => [404, ''],
    getcrumb: () => [429, ''],
    'chart/GOOG': () => chart(300),
    'chart/VOO': () => chart(690),
  });
  const y = new YahooProvider({ fetchImpl: f, now: () => t, wait: async () => {} });
  // The crumb request was rate-limited, so the first call is paused…
  await assert.rejects(y.getQuotes(['GOOG', 'VOO']), RateLimitError);
  t += 61_000;
  const q = await y.getQuotes(['GOOG', 'VOO']); // …then crumb is skipped for 10 min and chart is used
  assert.equal(q.GOOG.price, 300);
  assert.equal(q.VOO.price, 690);
  const n = f.calls.length;
  const again = await y.getQuotes(['GOOG', 'VOO']);
  assert.equal(again.GOOG.price, 300);
  assert.equal(f.calls.length, n, 'served from the 1-minute cache');
});

test('a 429 midway through the chart fallback keeps the prices already fetched', async () => {
  const f = fakeFetch({
    'fc.yahoo.com': () => [404, ''],
    getcrumb: () => [500, ''],
    'chart/GOOG': () => chart(300),
    'chart/VOO': () => [429, ''],
  });
  const y = new YahooProvider({ fetchImpl: f, wait: async () => {} });
  const q = await y.getQuotes(['GOOG', 'VOO', 'MSFT']);
  assert.deepEqual(Object.keys(q), ['GOOG']);
  assert.ok(!f.calls.some((u) => u.includes('chart/MSFT')), 'stops after the 429');
});

test('Finnhub quotes, with BRK-B sent as BRK.B', async () => {
  const f = fakeFetch({ 'finnhub.io': (u) => [200, u.includes('BRK.B') ? { c: 500, pc: 495, d: 5, dp: 1.01, t: 1 } : { c: 0 }] });
  const p = new FinnhubProvider('k', { fetchImpl: f, wait: async () => {} });
  const q = await p.getQuotes(['BRK-B', 'NOPE']);
  assert.equal(q['BRK-B'].price, 500);
  assert.equal(q.NOPE, undefined);
});
