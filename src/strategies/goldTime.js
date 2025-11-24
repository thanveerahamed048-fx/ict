// src/strategies/goldTime.js
// Gold-only strategy (XAUUSD): "Gold Time Strategy"
// Logic (NY timezone):
// - Compute BBP = (high - EMA(close,len)) + (low - EMA(close,len))
// - At checkHourNY (minute==0), if the three previous hours' BBP are all < 0, go long
// - One trade per NY day
// - Entries only; TP/SL handled by ModelBus

import { msToNY, nyDayKey } from '../utils/time.js';

export class GoldTimeStrategy {
  constructor({
    decimals = 2,        // XAUUSD typically 2 decimals
    pipSize = 0.1,       // XAUUSD pip definition (1 pip = 0.1)
    length = 14,         // EMA length for BBP
    checkHourNY = 4,     // NY hour to check (e.g., 4 = 04:00 NY)
    tradeDurationHours = 8, // kept for future timed exit (not used here)
    oneTradePerDay = true
  } = {}) {
    this.decimals = decimals;
    this.pipSize = pipSize;

    this.length = Math.max(1, length);
    this.checkHourNY = Math.max(0, Math.min(23, checkHourNY));
    this.tradeDurationHours = Math.max(1, tradeDurationHours);
    this.oneTradePerDay = !!oneTradePerDay;

    // EMA state
    this.alpha = 2 / (this.length + 1);
    this.ema = null;

    // Day/entry state
    this.dayKey = null;
    this.enteredToday = false;

    // Storage for 3 prev hours BBP values (captured at minute==0)
    this.bbpH3 = null; // checkHour - 3
    this.bbpH2 = null; // checkHour - 2
    this.bbpH1 = null; // checkHour - 1
  }

  resetDay() {
    this.enteredToday = false;
    this.bbpH3 = this.bbpH2 = this.bbpH1 = null;
  }

  // update EMA incrementally
  _updateEma(close) {
    if (this.ema == null) {
      this.ema = close;
    } else {
      this.ema = this.alpha * close + (1 - this.alpha) * this.ema;
    }
  }

  // Called on each closed M1 candle
  onM1Close(candle, sessions, M1) {
    const dNY = msToNY(candle.ts);
    const dKey = nyDayKey(dNY);

    if (this.dayKey !== dKey) {
      this.dayKey = dKey;
      this.resetDay();
    }

    // Update EMA on M1 close
    this._updateEma(candle.close);

    if (this.ema == null) return;

    // BBP for this candle (uses its high/low vs current EMA)
    const bbp = (candle.high - this.ema) + (candle.low - this.ema);

    const hr = dNY.hour;
    const min = dNY.minute;

    // Only record at the top of each hour (minute == 0)
    if (min === 0) {
      // Compute the three target hours relative to checkHourNY
      const h3 = (this.checkHourNY - 3 + 24) % 24;
      const h2 = (this.checkHourNY - 2 + 24) % 24;
      const h1 = (this.checkHourNY - 1 + 24) % 24;

      if (hr === h3) this.bbpH3 = bbp;
      if (hr === h2) this.bbpH2 = bbp;
      if (hr === h1) this.bbpH1 = bbp;

      // Clear out old values when check time passes
      if (hr === this.checkHourNY) {
        // In Pine, they reset storage after the check
        // We'll do the same once we evaluate entry condition in onTick
      }
    }
  }

  // Called on tick; returns { strategy, direction, entry } or null
  onTick(price, tsMs /*, sessions */) {
    if (this.oneTradePerDay && this.enteredToday) return null;

    const dNY = msToNY(tsMs);
    const hr = dNY.hour;
    const min = dNY.minute;

    // Fire only exactly at the check hour, minute 0 (like Pine)
    if (hr !== this.checkHourNY || min !== 0) return null;

    // Require the three stored BBP readings to exist and be bearish (< 0)
    const ready = this.bbpH3 != null && this.bbpH2 != null && this.bbpH1 != null
               && this.bbpH3 < 0 && this.bbpH2 < 0 && this.bbpH1 < 0;

    if (!ready) {
      // Clear stored values at the check moment (to prep for next day)
      this.bbpH3 = this.bbpH2 = this.bbpH1 = null;
      return null;
    }

    // Long only at check time if all three prior hours were bearish BBP
    this.enteredToday = true;

    // Reset BBP storage like Pine (they reset after check)
    this.bbpH3 = this.bbpH2 = this.bbpH1 = null;

    return { strategy: 'GoldTime', direction: 'buy', entry: price };
  }
}