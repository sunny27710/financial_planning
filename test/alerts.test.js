import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePriceAlert, findCoveredCallMatches, ruleSymbols, filterNew, premiumFor } from '../src/alerts.js';
import { MockProvider } from '../src/providers/mock.js';

test('one-shot "above" alert fires once then deactivates', () => {
  const a = { id: 'a', symbol: 'AAPL', direction: 'above', target: 200, active: true };
  assert.equal(evaluatePriceAlert(a, 199).fire, false);
  const r = evaluatePriceAlert(a, 200.5);
  assert.equal(r.fire, true);
  assert.equal(r.next.active, false);
  assert.equal(evaluatePriceAlert(r.next, 210).fire, false);
});

test('"below" alert', () => {
  const a = { direction: 'below', target: 50, active: true };
  assert.equal(evaluatePriceAlert(a, 51).fire, false);
  assert.equal(evaluatePriceAlert(a, 50).fire, true);
});

test('repeating alert re-arms after crossing back', () => {
  let a = { direction: 'above', target: 100, active: true, repeat: true };
  let r = evaluatePriceAlert(a, 101);
  assert.equal(r.fire, true);
  r = evaluatePriceAlert(r.next, 102); // still above: no spam
  assert.equal(r.fire, false);
  r = evaluatePriceAlert(r.next, 99); // re-arms
  assert.equal(r.fire, false);
  assert.equal(r.next.armed, true);
  r = evaluatePriceAlert(r.next, 100.1);
  assert.equal(r.fire, true);
});

test('ignores missing price', () => {
  assert.equal(evaluatePriceAlert({ direction: 'above', target: 1, active: true }, undefined).fire, false);
});

const chain = [
  { contractSymbol: 'X1', strike: 100, bid: 3.0, ask: 3.2, last: 3.1, dte: 30 }, // ATM
  { contractSymbol: 'X2', strike: 106, bid: 1.2, ask: 1.4, last: 1.3, dte: 30 }, // 6% OTM
  { contractSymbol: 'X3', strike: 110, bid: 0.5, ask: 0.7, last: 0.9, dte: 30 }, // 10% OTM
  { contractSymbol: 'X4', strike: 106, bid: 2.5, ask: 2.7, last: 2.6, dte: 90 }, // too far out
  { contractSymbol: 'X5', strike: 106, bid: 0, ask: 0.05, last: 0, dte: 2 },
];

test('covered call matching respects OTM, DTE and premium threshold', () => {
  const rule = { minPremium: 1, premiumBasis: 'bid', minDte: 7, maxDte: 45, minOtmPct: 5 };
  const m = findCoveredCallMatches(rule, 100, chain, 250);
  assert.deepEqual(m.map((x) => x.contractSymbol), ['X2']);
  assert.equal(m[0].contracts, 2);
  assert.equal(m[0].totalPremium, 240);
  assert.equal(m[0].yieldPct, 1.2);
});

test('premium basis and annualized yield filter', () => {
  assert.ok(Math.abs(premiumFor(chain[1], 'mid') - 1.3) < 1e-9);
  const rule = { minPremium: 0.6, premiumBasis: 'mid', minDte: 0, maxDte: 45, minOtmPct: 5, minAnnualizedPct: 10 };
  // X2: 1.3/100*365/30 = 15.8% ✓ ; X3: 0.6/100*365/30 = 7.3% ✗
  assert.deepEqual(findCoveredCallMatches(rule, 100, chain).map((x) => x.contractSymbol), ['X2']);
});

test('matches sorted by premium, highest first', () => {
  const rule = { minPremium: 0.1, minDte: 0, maxDte: 100, minOtmPct: 0 };
  assert.deepEqual(findCoveredCallMatches(rule, 100, chain).map((x) => x.contractSymbol), ['X1', 'X4', 'X2', 'X3']);
});

test('ruleSymbols: * means holdings with >= 100 shares', () => {
  const holdings = [{ symbol: 'A', shares: 150 }, { symbol: 'B', shares: 50 }, { symbol: 'B', shares: 60 }, { symbol: 'C', shares: 10 }];
  assert.deepEqual(ruleSymbols({ symbol: '*' }, holdings).sort(), ['A', 'B']);
  assert.deepEqual(ruleSymbols({ symbol: 'C', requireShares: true }, holdings), []);
  assert.deepEqual(ruleSymbols({ symbol: 'C' }, holdings), ['C']);
});

test('filterNew respects cooldown', () => {
  const now = Date.parse('2026-01-02T00:00:00Z');
  const notified = { 'r|X1': '2026-01-01T12:00:00Z', 'r|X2': '2025-12-30T00:00:00Z' };
  const m = [{ contractSymbol: 'X1' }, { contractSymbol: 'X2' }, { contractSymbol: 'X3' }];
  assert.deepEqual(filterNew(m, 'r', notified, 24, now).map((x) => x.contractSymbol), ['X2', 'X3']);
});

test('mock provider returns quotes and a usable call chain', async () => {
  const p = new MockProvider();
  const q = await p.getQuotes(['AAPL']);
  assert.ok(q.AAPL.price > 0);
  const c = await p.getCallChain('AAPL', { minDte: 0, maxDte: 45 });
  assert.ok(c.length > 0);
  assert.ok(c.every((x) => x.dte <= 45 && x.bid >= 0 && x.ask >= x.bid));
});
