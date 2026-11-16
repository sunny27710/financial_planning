// Pure alert-evaluation logic (no I/O) so it's easy to test.

/**
 * Price alerts are edge-triggered: they fire when the condition becomes true.
 * One-shot alerts deactivate after firing. Repeating alerts re-arm once the
 * price moves back across the target.
 * Returns { fire: boolean, next: updatedAlert }.
 */
export function evaluatePriceAlert(alert, price) {
  if (!alert.active || price == null || !Number.isFinite(price)) return { fire: false, next: alert };
  const hit = alert.direction === 'above' ? price >= alert.target : price <= alert.target;
  const armed = alert.armed !== false;
  if (hit && armed) {
    return {
      fire: true,
      next: {
        ...alert,
        armed: false,
        active: alert.repeat ? true : false,
        lastTriggeredAt: new Date().toISOString(),
        lastTriggeredPrice: price,
      },
    };
  }
  if (!hit && !armed && alert.repeat) return { fire: false, next: { ...alert, armed: true } };
  return { fire: false, next: alert };
}

export function premiumFor(contract, basis = 'bid') {
  if (basis === 'last') return contract.last || 0;
  if (basis === 'mid') {
    if (contract.bid > 0 && contract.ask > 0) return (contract.bid + contract.ask) / 2;
    return contract.bid || contract.last || 0;
  }
  return contract.bid || 0;
}

/**
 * Find call contracts that satisfy a covered-call rule.
 *  rule: { minPremium ($/share), premiumBasis, minDte, maxDte, minOtmPct, minAnnualizedPct }
 *  price: current underlying price
 *  shares: shares held (used to compute how many contracts you could write)
 * Returns matches sorted by premium (highest first).
 */
export function findCoveredCallMatches(rule, price, chain, shares = 0) {
  const minStrike = price * (1 + (Number(rule.minOtmPct) || 0) / 100);
  const minDte = Number(rule.minDte) || 0;
  const maxDte = rule.maxDte == null || rule.maxDte === '' ? Infinity : Number(rule.maxDte);
  const minPremium = Number(rule.minPremium) || 0;
  const minAnn = Number(rule.minAnnualizedPct) || 0;
  const contracts = Math.floor(shares / 100);

  const matches = [];
  for (const c of chain) {
    if (c.strike < minStrike) continue;
    if (c.dte < minDte || c.dte > maxDte) continue;
    const premium = premiumFor(c, rule.premiumBasis);
    if (premium <= 0 || premium < minPremium) continue;
    const yieldPct = (premium / price) * 100;
    const annualizedPct = yieldPct * (365 / Math.max(1, c.dte));
    if (annualizedPct < minAnn) continue;
    matches.push({
      ...c,
      premium: +premium.toFixed(2),
      otmPct: +(((c.strike - price) / price) * 100).toFixed(2),
      yieldPct: +yieldPct.toFixed(2),
      annualizedPct: +annualizedPct.toFixed(1),
      contracts,
      totalPremium: +(premium * 100 * contracts).toFixed(2),
    });
  }
  return matches.sort((a, b) => b.premium - a.premium);
}

/** Symbols a covered-call rule applies to. '*' means every holding with >= 100 shares. */
export function ruleSymbols(rule, holdings) {
  const shares = sharesBySymbol(holdings);
  if (rule.symbol === '*') return Object.keys(shares).filter((s) => shares[s] >= 100);
  if (rule.requireShares && (shares[rule.symbol] || 0) < 100) return [];
  return [rule.symbol];
}

export function sharesBySymbol(holdings) {
  const out = {};
  for (const h of holdings) out[h.symbol] = (out[h.symbol] || 0) + Number(h.shares || 0);
  return out;
}

/** Drop contracts we've already notified about within the cooldown window. */
export function filterNew(matches, ruleId, notified, cooldownHours, now = Date.now()) {
  return matches.filter((m) => {
    const prev = notified[`${ruleId}|${m.contractSymbol}`];
    return !prev || now - Date.parse(prev) > cooldownHours * 3_600_000;
  });
}
