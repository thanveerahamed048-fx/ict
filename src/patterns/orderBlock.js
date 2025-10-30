import { atr } from '../utils/ta.js';

// Heuristic: mark OB as the last opposite-color candle before a displacement break of structure
export function detectOrderBlocks(candles, { lookback = 200, atrMult = 1.2 } = {}) {
  const out = [];
  if (candles.length < 30) return out;
  const a = atr(candles, 14);
  const n = candles.length;

  // find last swing high/low broken with displacement
  const last = candles[n - 1];

  // Bullish BOS: close above any of the last N swing highs with a big candle
  const recentHigh = Math.max(...candles.slice(n - 10, n).map(c => c.high));
  const recentLow = Math.min(...candles.slice(n - 10, n).map(c => c.low));

  const body = Math.abs(last.close - last.open);
  const bullBOS = body >= atrMult * (a ?? 0) && last.close > recentHigh;
  const bearBOS = body >= atrMult * (a ?? 0) && last.close < recentLow;

  if (bullBOS) {
    // last down candle before the up displacement
    for (let i = n - 2; i >= Math.max(0, n - lookback); i--) {
      const c = candles[i];
      if (c.close < c.open) {
        out.push({
          type: 'bull',
          zoneLow: c.low,
          zoneHigh: c.high,
          index: i
        });
        break;
      }
    }
  }
  if (bearBOS) {
    // last up candle before the down displacement
    for (let i = n - 2; i >= Math.max(0, n - lookback); i--) {
      const c = candles[i];
      if (c.close > c.open) {
        out.push({
          type: 'bear',
          zoneLow: c.low,
          zoneHigh: c.high,
          index: i
        });
        break;
      }
    }
  }

  return out.slice(-5);
}