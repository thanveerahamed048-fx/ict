import { findSwings } from '../utils/ta.js';

export function detectDoubleTopsBottoms(candles, { lookback = 300, tolRatio = 0.0002 } = {}) {
  // tolRatio is relative tolerance (e.g., 0.0002 => 2 bps for FX; for crypto raise it)
  const res = [];
  if (candles.length < 20) return res;
  const from = Math.max(0, candles.length - lookback);
  const { highs, lows } = findSwings(candles.slice(from), 2, 2);
  const offset = from;

  // Double Top
  for (let i = 1; i < highs.length; i++) {
    const idx1 = highs[i - 1] + offset;
    const idx2 = highs[i] + offset;
    const p1 = candles[idx1].high;
    const p2 = candles[idx2].high;
    const midPx = (p1 + p2) / 2;
    if (Math.abs(p1 - p2) <= tolRatio * midPx && idx2 - idx1 >= 3) {
      res.push({ type: 'double_top', idx1, idx2, level: midPx });
    }
  }

  // Double Bottom
  for (let i = 1; i < lows.length; i++) {
    const idx1 = lows[i - 1] + offset;
    const idx2 = lows[i] + offset;
    const p1 = candles[idx1].low;
    const p2 = candles[idx2].low;
    const midPx = (p1 + p2) / 2;
    if (Math.abs(p1 - p2) <= tolRatio * midPx && idx2 - idx1 >= 3) {
      res.push({ type: 'double_bottom', idx1, idx2, level: midPx });
    }
  }

  return res.slice(-5);
}