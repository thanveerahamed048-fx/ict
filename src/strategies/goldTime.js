// src/strategies/goldTime.js
// Gold-only strategy (XAUUSD): "Gold Time Strategy"
// Logic (NY timezone):
// - Compute BBP = (high - EMA(close,len)) + (low - EMA(close,len))
//   where EMA is the value BEFORE the current candle updates it (mirrors Pine)
// - Capture hourly BBP at minute==59 (last M1 of the hour, mirrors Pine's hourly bar close)
// - At checkHourNY minute==0 tick, if BBP of the 3 prior hours are all < 0, go long
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

    // Storage for 3 prev hours BBP values (captured at minute==59, last M1 of that hour)
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
  onM1Close(candle, _sessions, _M1) {
    const dNY = msToNY(candle.ts);
    const dKey = nyDayKey(dNY);

    if (this.dayKey !== dKey) {
      this.dayKey = dKey;
      this.resetDay();
    }

    // Snapshot EMA BEFORE updating — BBP must use the prior EMA value,
    // not the one that already absorbed the current candle's close.
    // (In Pine, ema[1] is used, which is the same thing.)
    const prevEma = this.ema;

    // Now update EMA with this candle's close
    this._updateEma(candle.close);

    // Need at least one prior EMA value to compute a meaningful BBP
    if (prevEma == null) return;

    // BBP = distance of high + distance of low from the PREVIOUS EMA
    const bbp = (candle.high - prevEma) + (candle.low - prevEma);

    const hr = dNY.hour;
    const min = dNY.minute;

    // Capture at minute==59 — the LAST M1 candle of that hour.
    // This mirrors Pine's hourly bar close (not the opening candle).
    if (min === 59) {
      const h3 = (this.checkHourNY - 3 + 24) % 24;
      const h2 = (this.checkHourNY - 2 + 24) % 24;
      const h1 = (this.checkHourNY - 1 + 24) % 24;

      if (hr === h3) this.bbpH3 = bbp;
      if (hr === h2) this.bbpH2 = bbp;
      if (hr === h1) this.bbpH1 = bbp;
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

    // Always clear BBP storage at check time — whether we fire or not
    this.bbpH3 = this.bbpH2 = this.bbpH1 = null;

    if (!ready) return null;

    // Long only at check time if all three prior hours were bearish BBP
    this.enteredToday = true;

    return { strategy: 'GoldTime', direction: 'buy', entry: price };
  }
}