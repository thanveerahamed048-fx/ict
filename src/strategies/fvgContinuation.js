// FVG Continuation (trend continuation using the most recent FVG)
// Uses M5 to decide trend; M1 FVG as entry zone; entry on retest.

import { detectFVG } from '../patterns/fvg.js';

export class FVGContinuation {
  constructor({ decimals = 5, pipSize = 0.0001, bufferPips = 2 }) {
    this.decimals = decimals;
    this.pipSize = pipSize;
    this.buffer = bufferPips * pipSize;
    this.pending = null; // { dir, zoneLow, zoneHigh, stop }
    this.lastFvgKey = null;
  }

  evaluate({ candles, m5 }) {
    const M1 = candles;
    if (!M1 || M1.length < 50 || !m5 || m5.length < 30) return null;

    // Trend filter from M5: breakout of recent 10-candle range
    const last5 = m5[m5.length - 1];
    const prev10 = m5.slice(-11, -1);
    if (prev10.length < 10) return null;
    const hi10 = Math.max(...prev10.map(c => c.high));
    const lo10 = Math.min(...prev10.map(c => c.low));
    let trend = null;
    if (last5.close > hi10) trend = 'up';
    else if (last5.close < lo10) trend = 'down';
    else return null;

    // Latest FVG on M1 aligned with trend
    const gaps = detectFVG(M1, 120);
    if (!gaps.length) return null;
    const want = trend === 'up' ? gaps.filter(g => g.type === 'bull') : gaps.filter(g => g.type === 'bear');
    const fvg = want.at(-1);
    if (!fvg) return null;

    const key = `${fvg.type}:${fvg.endIndex}`;
    if (this.lastFvgKey === key) return null; // avoid repeating same FVG
    this.lastFvgKey = key;

    if (trend === 'up') {
      this.pending = {
        dir: 'buy',
        zoneLow: fvg.gapLow,
        zoneHigh: fvg.gapHigh,
        stop: fvg.gapLow - this.buffer
      };
      return { model: 'FVGC', event: 'setup', data: { ...this.pending } };
    } else {
      this.pending = {
        dir: 'sell',
        zoneLow: fvg.gapLow,
        zoneHigh: fvg.gapHigh,
        stop: fvg.gapHigh + this.buffer
      };
      return { model: 'FVGC', event: 'setup', data: { ...this.pending } };
    }
  }

  onPrice(price) {
    if (!this.pending) return null;
    const { dir, zoneLow, zoneHigh, stop } = this.pending;
    const inZone = price >= Math.min(zoneLow, zoneHigh) && price <= Math.max(zoneLow, zoneHigh);
    if (!inZone) return null;

    const entry = price;
    // Optional native targets (can be ignored if you use % TP/SL)
    const targets = dir === 'buy'
      ? [zoneHigh]  // mitigation to the other side of the gap
      : [zoneLow];

    // Clear after firing once
    this.pending = null;

    return { direction: dir, entry, stop, targets, strategy: 'FVGC' };
  }
}