import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortfolioCsv, holdingsFromRows } from '../src/holdings.js';

const fakeProvider = { getQuotes: async (syms) => Object.fromEntries(syms.filter((s) => s !== 'NOPE').map((s) => [s, { price: 50 }])) };

test('parses amounts, exact shares, comments and $ signs', () => {
  const rows = parsePortfolioCsv('ticker,amount\n# comment\nvoo, $10,000\nSCHD\t142,587\nBRK-B 500.5\nAAPL,,100,150.25 # exact\n\n');
  assert.deepEqual(rows.map((r) => [r.symbol, r.amount]).slice(0, 3), [['VOO', 10000], ['SCHD', 142587], ['BRK-B', 500.5]]);
  assert.deepEqual(rows[3], { symbol: 'AAPL', amount: null, shares: 100, costBasis: 150.25 });
});

test('builds holdings and reports problems', async () => {
  const { holdings, problems } = await holdingsFromRows(fakeProvider, parsePortfolioCsv('VOO, 1000\nAAPL,,10,20\nNOPE, 500\nBAD'));
  assert.deepEqual(holdings, [{ symbol: 'VOO', shares: 20, costBasis: 50 }, { symbol: 'AAPL', shares: 10, costBasis: 20 }]);
  assert.equal(problems.length, 2);
});
