import { inHourRangeNY, SESSIONS, msToNY } from '../utils/time.js';
import { atr, isDisplacement } from '../utils/ta.js';

// PO3 per instrument: detect London sweep + displacement, create entry zone and targets
export class PO3 {
  constructor({ decimals, pipSize, asset = 'fx' }) {
    this.decimals = decimals;
    this.pipSize = pipSize ?? 0.0001;
    this.asset = asset; // 'fx' or 'crypto'
    this.state = {};    // symbolically: sweep, displacement, pending
  }

  evaluate({ candles, sessions }) {
    const M1 = candles;
    if (M1.length < 30) return null;
    if (sessions.dailyOpen == null || sessions.asiaHi == null || sessions.asiaLo == null) return null;

    const last = M1[M1.length - 1];
    const dtNY = msToNY(last.ts);
    const a = atr(M1, 14);
    if (!a) return null;

    const inLondon = inHourRangeNY(dtNY, SESSIONS.LONDON_START, SESSIONS.LONDON_END);

    if (!this.state.sweep && inLondon) {
      // Sell candidate: sweep Asia high, close back inside
      if (last.high > sessions.asiaHi && last.close <= sessions.asiaHi) {
        this.state.sweep = { type: 'sell', level: last.high, ts: last.ts };
        return { model: 'PO3', event: 'sweep_high', data: { level: last.high } };
      }
      // Buy candidate: sweep Asia low, close back inside
      if (last.low < sessions.asiaLo && last.close >= sessions.asiaLo) {
        this.state.sweep = { type: 'buy', level: last.low, ts: last.ts };
        return { model: 'PO3', event: 'sweep_low', data: { level: last.low } };
      }
    }

    if (this.state.sweep && !this.state.disp) {
      if (this.state.sweep.type === 'sell') {
        if (isDisplacement(last, a, 1.2) && last.close < sessions.asiaHi) {
          const eqMid = (last.open + last.close) / 2;
          const zoneLow = eqMid, zoneHigh = Math.max(last.open, last.close);
          const stop = this._stop(this.state.sweep.level, 'sell');
          const targets = this._targets('sell', sessions);
          this.state.disp = { direction: 'sell', zoneLow, zoneHigh, stop, targets };
          return { model: 'PO3', event: 'displacement_down', data: { zoneLow, zoneHigh, stop, targets } };
        }
      } else {
        if (isDisplacement(last, a, 1.2) && last.close > sessions.asiaLo) {
          const eqMid = (last.open + last.close) / 2;
          const zoneLow = Math.min(last.open, last.close), zoneHigh = eqMid;
          const stop = this._stop(this.state.sweep.level, 'buy');
          const targets = this._targets('buy', sessions);
          this.state.disp = { direction: 'buy', zoneLow, zoneHigh, stop, targets };
          return { model: 'PO3', event: 'displacement_up', data: { zoneLow, zoneHigh, stop, targets } };
        }
      }
    }

    return null;
  }

  // On tick, check entry zone touch
  onPrice(price) {
    if (this.state.disp && !this.state.entry) {
      const { direction, zoneLow, zoneHigh, stop, targets } = this.state.disp;
      if (direction === 'sell' && price >= zoneLow && price <= zoneHigh) {
        this.state.entry = { direction, entry: price, stop, targets };
        return this.state.entry;
      }
      if (direction === 'buy' && price <= zoneHigh && price >= zoneLow) {
        this.state.entry = { direction, entry: price, stop, targets };
        return this.state.entry;
      }
    }
    return null;
  }

  resetDay() {
    this.state = {};
  }

  _stop(sweepLevel, dir) {
    if (this.asset === 'fx') {
      const buffer = 5 * (this.pipSize ?? 0.0001);
      return dir === 'sell' ? sweepLevel + buffer : sweepLevel - buffer;
    } else {
      // crypto: use 0.25 ATR-like buffer via % (approx)
      return dir === 'sell' ? sweepLevel * 1.0015 : sweepLevel * 0.9985;
    }
  }

  _targets(dir, sessions) {
    const t = [];
    if (sessions.dailyOpen != null) t.push(sessions.dailyOpen);
    if (dir === 'sell') {
      if (sessions.asiaLo != null) t.push(sessions.asiaLo);
      if (sessions.prevDayLow != null) t.push(sessions.prevDayLow);
      return [...new Set(t)].sort((a, b) => a - b);
    } else {
      if (sessions.asiaHi != null) t.push(sessions.asiaHi);
      if (sessions.prevDayHigh != null) t.push(sessions.prevDayHigh);
      return [...new Set(t)].sort((a, b) => b - a);
    }
  }
}