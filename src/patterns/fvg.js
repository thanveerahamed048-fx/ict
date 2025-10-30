// Fair Value Gaps (3-candle gaps)
export function detectFVG(candles, lookback = 100) {
  const res = [];
  const n = candles.length;
  const start = Math.max(2, n - lookback);
  for (let i = start; i < n - 1; i++) {
    const a = candles[i - 1];
    const b = candles[i];
    const c = candles[i + 1];
    // Bullish FVG if a.high < c.low
    if (a.high < c.low) {
      res.push({
        type: 'bull',
        startIndex: i - 1,
        endIndex: i + 1,
        gapLow: a.high,
        gapHigh: c.low
      });
    }
    // Bearish FVG if a.low > c.high
    if (a.low > c.high) {
      res.push({
        type: 'bear',
        startIndex: i - 1,
        endIndex: i + 1,
        gapLow: c.high,
        gapHigh: a.low
      });
    }
  }
  return dedupeLatest(res);
}

function dedupeLatest(arr) {
  // Keep the most recent of overlapping same-direction gaps
  const out = [];
  for (const g of arr) {
    const last = out[out.length - 1];
    if (last && last.type === g.type && Math.abs(last.endIndex - g.endIndex) <= 2) {
      out[out.length - 1] = g;
    } else {
      out.push(g);
    }
  }
  return out.slice(-10);
}