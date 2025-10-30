import { inHourRangeNY, SESSIONS, msToNY } from '../utils/time.js';

export function findEqualHighsLows(candles, { lookback = 300, tolRatio = 0.00015 } = {}) {
  const out = { equalHighs: [], equalLows: [] };
  const from = Math.max(0, candles.length - lookback);
  for (let i = from + 2; i < candles.length; i++) {
    const a = candles[i - 2], b = candles[i - 1], c = candles[i];
    const midH = (a.high + b.high) / 2;
    const midL = (a.low + b.low) / 2;
    if (Math.abs(a.high - b.high) <= tolRatio * midH) out.equalHighs.push({ idxs: [i - 2, i - 1], level: midH });
    if (Math.abs(a.low - b.low) <= tolRatio * midL) out.equalLows.push({ idxs: [i - 2, i - 1], level: midL });
  }
  return out;
}

export function roundNumbers(level, step) {
  // step e.g., 0.005 for FX, 10 for BTC
  const base = Math.round(level / step) * step;
  return [base - step, base, base + step];
}

export function asiaRangeFromCandles(candles) {
  // Useful if you want to recompute; aggregator already tracks it
  let hi = null, lo = null;
  for (const c of candles) {
    const d = msToNY(c.ts);
    if (inHourRangeNY(d, SESSIONS.ASIA_START, SESSIONS.ASIA_END)) {
      hi = hi == null ? c.high : Math.max(hi, c.high);
      lo = lo == null ? c.low  : Math.min(lo, c.low);
    }
  }
  return { hi, lo };
}