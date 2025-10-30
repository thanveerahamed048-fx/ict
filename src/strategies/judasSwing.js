// Judas Swing: London sweep of Asia high/low and fade back into the range.
// Separate from PO3 (simpler, immediate fade).

import { msToNY, inHourRangeNY, SESSIONS } from '../utils/time.js';

export class JudasSwing {
  constructor({ decimals = 5, pipSize = 0.0001, bufferPips = 5 }) {
    this.decimals = decimals;
    this.pipSize = pipSize;
    this.buffer = bufferPips * pipSize;
    this.pending = null; // { dir, zoneLow, zoneHigh, stop }
    this.armedDayKey = null;
  }

  evaluate({ candles, sessions }) {
    const M1 = candles;
    if (!M1 || M1.length < 10 || sessions.asiaHi == null || sessions.asiaLo == null) return null;

    const c = M1.at(-1);
    const dt = msToNY(c.ts);
    const inLondon = inHourRangeNY(dt, SESSIONS.LONDON_START, SESSIONS.LONDON_END);
    if (!inLondon) return null;

    // Sweep above Asia high, close back inside => SELL setup
    if (c.high > sessions.asiaHi && c.close <= sessions.asiaHi) {
      const sweepHigh = c.high;
      const mid = (sessions.asiaHi + sweepHigh) / 2;
      this.pending = {
        dir: 'sell',
        zoneLow: sessions.asiaHi,
        zoneHigh: mid,
        stop: sweepHigh + this.buffer
      };
      return { model: 'JUDAS', event: 'setup_sell', data: { ...this.pending } };
    }

    // Sweep below Asia low, close back inside => BUY setup
    if (c.low < sessions.asiaLo && c.close >= sessions.asiaLo) {
      const sweepLow = c.low;
      const mid = (sessions.asiaLo + sweepLow) / 2;
      this.pending = {
        dir: 'buy',
        zoneLow: mid,
        zoneHigh: sessions.asiaLo,
        stop: sweepLow - this.buffer
      };
      return { model: 'JUDAS', event: 'setup_buy', data: { ...this.pending } };
    }

    return null;
  }

  onPrice(price) {
    if (!this.pending) return null;
    const { dir, zoneLow, zoneHigh, stop } = this.pending;
    const inZone = price >= Math.min(zoneLow, zoneHigh) && price <= Math.max(zoneLow, zoneHigh);
    if (!inZone) return null;

    const entry = price;
    const targets = dir === 'sell' ? [zoneLow] : [zoneHigh]; // fade to boundary
    this.pending = null;
    return { direction: dir, entry, stop, targets, strategy: 'JUDAS' };
  }

  resetDay() {
    this.pending = null;
  }
}