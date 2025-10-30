// Breaker Block Reversal: after a swing + structure shift, the last opposite candle becomes a breaker.
// Entry on retest of that breaker zone.

import { findSwings } from '../utils/ta.js';

export class BreakerReversal {
  constructor({ decimals = 5, pipSize = 0.0001, bufferPips = 3 }) {
    this.decimals = decimals;
    this.pipSize = pipSize;
    this.buffer = bufferPips * pipSize;
    this.pending = null; // { dir, zoneLow, zoneHigh, stop }
    this.lastBreakKey = null;
  }

  evaluate({ candles }) {
    const M1 = candles;
    if (!M1 || M1.length < 80) return null;

    const { highs, lows } = findSwings(M1, 2, 2);
    if (highs.length < 2 || lows.length < 2) return null;

    const n = M1.length;
    const lastClose = M1[n - 1].close;

    // Bearish breaker: recent swing high H, then break below next swing low L (shift down)
    const H = highs.at(-1);
    const lowAfterH = lows.filter(i => i > H).at(0);
    if (H != null && lowAfterH != null) {
      const Lpx = M1[lowAfterH].low;
      if (lastClose < Lpx) {
        // Breaker zone = last bullish candle before H
        let k = H - 1;
        let breaker = null;
        for (; k >= Math.max(0, H - 15); k--) {
          const c = M1[k];
          if (c.close > c.open) { breaker = c; break; }
        }
        if (breaker) {
          const zoneLow = breaker.low;
          const zoneHigh = breaker.high;
          const stop = zoneHigh + this.buffer;
          const key = `bear:${H}:${lowAfterH}`;
          if (this.lastBreakKey !== key) {
            this.lastBreakKey = key;
            this.pending = { dir: 'sell', zoneLow, zoneHigh, stop };
            return { model: 'BREAKER', event: 'setup_down', data: { ...this.pending } };
          }
        }
      }
    }

    // Bullish breaker: recent swing low L, then break above next swing high H (shift up)
    const L = lows.at(-1);
    const highAfterL = highs.filter(i => i > L).at(0);
    if (L != null && highAfterL != null) {
      const Hpx = M1[highAfterL].high;
      if (lastClose > Hpx) {
        // Breaker = last bearish candle before L
        let k = L - 1;
        let breaker = null;
        for (; k >= Math.max(0, L - 15); k--) {
          const c = M1[k];
          if (c.close < c.open) { breaker = c; break; }
        }
        if (breaker) {
          const zoneLow = breaker.low;
          const zoneHigh = breaker.high;
          const stop = zoneLow - this.buffer;
          const key = `bull:${L}:${highAfterL}`;
          if (this.lastBreakKey !== key) {
            this.lastBreakKey = key;
            this.pending = { dir: 'buy', zoneLow, zoneHigh, stop };
            return { model: 'BREAKER', event: 'setup_up', data: { ...this.pending } };
          }
        }
      }
    }

    return null;
  }

  onPrice(price) {
    if (!this.pending) return null;
    const { dir, zoneLow, zoneHigh, stop } = this.pending;
    const inZone = price >= Math.min(zoneLow, zoneHigh) && price <= Math.max(zoneLow, zoneHigh);
    if (!inZone) return null;

    const entry = price;
    const targets = dir === 'sell' ? [zoneLow] : [zoneHigh];
    this.pending = null;
    return { direction: dir, entry, stop, targets, strategy: 'BREAKER' };
  }
}