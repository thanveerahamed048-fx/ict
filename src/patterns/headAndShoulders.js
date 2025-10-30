import { findSwings } from '../utils/ta.js';

// Simple swing-based H&S detection; returns after neckline break
export function detectHeadAndShoulders(candles, { lookback = 400, tol = 0.01 } = {}) {
  const out = [];
  if (candles.length < 30) return out;
  const from = Math.max(0, candles.length - lookback);
  const slice = candles.slice(from);
  const { highs, lows } = findSwings(slice, 2, 2);

  // Bearish H&S: three swing highs where middle is highest
  for (let i = 2; i < highs.length; i++) {
    const L = highs[i - 2] + from;
    const H = highs[i - 1] + from;
    const R = highs[i] + from;
    const hL = candles[L].high;
    const hH = candles[H].high;
    const hR = candles[R].high;
    if (!(hH > hL && hH > hR)) continue;
    if (Math.abs(hL - hR) > tol * ((hL + hR) / 2)) continue; // shoulders roughly equal

    // Neckline = low between L-H and H-R
    const low1 = Math.min(...candles.slice(L, H).map(c => c.low));
    const low2 = Math.min(...candles.slice(H, R).map(c => c.low));
    const neckline = (low1 + low2) / 2;

    // Check break of neckline after R
    const tail = candles.slice(R + 1);
    const broke = tail.findIndex(c => c.close < neckline);
    if (broke !== -1) {
      out.push({ type: 'hs_bear', L, H, R, neckline });
    }
  }

  // Inverse H&S: three swing lows where middle is lowest
  for (let i = 2; i < lows.length; i++) {
    const L = lows[i - 2] + from;
    const H = lows[i - 1] + from;
    const R = lows[i] + from;
    const lL = candles[L].low;
    const lH = candles[H].low;
    const lR = candles[R].low;
    if (!(lH < lL && lH < lR)) continue;
    if (Math.abs(lL - lR) > tol * ((lL + lR) / 2)) continue;

    const high1 = Math.max(...candles.slice(L, H).map(c => c.high));
    const high2 = Math.max(...candles.slice(H, R).map(c => c.high));
    const neckline = (high1 + high2) / 2;

    const tail = candles.slice(R + 1);
    const broke = tail.findIndex(c => c.close > neckline);
    if (broke !== -1) {
      out.push({ type: 'hs_bull', L, H, R, neckline });
    }
  }

  return out.slice(-3);
}