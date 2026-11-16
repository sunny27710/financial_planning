// Turn "I invested $X in TICKER" into shares, using the current price as cost basis.
export async function sharesFromAmount(provider, symbol, amount) {
  const quotes = await provider.getQuotes([symbol]);
  const price = quotes[symbol]?.price;
  if (!price) throw new Error(`Couldn't get a price for ${symbol}. Check the ticker, or enter shares instead.`);
  return { symbol, shares: +(amount / price).toFixed(4), costBasis: +price.toFixed(4) };
}

// Parse portfolio.csv lines: "TICKER, amount" or "TICKER, , shares, avgCost". '#' starts a comment.
export function parsePortfolioCsv(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    // "TICKER  142,587" / "TICKER, $142,587" / tab-separated: ticker + one amount (thousands commas allowed)
    const simple = line.match(/^([A-Za-z][A-Za-z0-9.\-]*)\s*[,\t ]\s*\$?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)$/);
    if (simple) {
      rows.push({ symbol: simple[1].toUpperCase(), amount: Number(simple[2].replaceAll(',', '')), shares: null, costBasis: null });
      continue;
    }
    const [symbol, amount, shares, costBasis] = line.split(',').map((x) => (x || '').trim().replace(/[$\s]/g, ''));
    if (!symbol || /^(ticker|symbol)$/i.test(symbol)) continue; // header row
    rows.push({
      symbol: symbol.toUpperCase(),
      amount: amount ? Number(amount) : null,
      shares: shares ? Number(shares) : null,
      costBasis: costBasis ? Number(costBasis) : null,
    });
  }
  return rows;
}

// Build holdings from parsed rows, fetching prices for rows given as dollar amounts.
export async function holdingsFromRows(provider, rows) {
  const needPrice = [...new Set(rows.filter((r) => !(r.shares > 0) && r.amount > 0).map((r) => r.symbol))];
  const quotes = needPrice.length ? await provider.getQuotes(needPrice) : {};
  const holdings = [];
  const problems = [];
  for (const r of rows) {
    if (r.shares > 0) holdings.push({ symbol: r.symbol, shares: r.shares, costBasis: r.costBasis || 0 });
    else if (r.amount > 0 && quotes[r.symbol]?.price) {
      const price = quotes[r.symbol].price;
      holdings.push({ symbol: r.symbol, shares: +(r.amount / price).toFixed(4), costBasis: +price.toFixed(4) });
    } else if (r.amount > 0) problems.push(`${r.symbol}: no price found (is the ticker right?)`);
    else problems.push(`${r.symbol}: needs an amount or a share count`);
  }
  return { holdings, problems };
}
