// src/strategies/orb.js
// ORB (Opening Range Breakout) strategy for your Node engine
// - Builds the NY Opening Range (default: 9:30–10:00 NY or 9:30–9:45 NY)
// - After the range completes, enters on breakout of high/low
// - Optional reverse logic and M1 close-confirmation
// - Max entries per day (1 or 2 if second chance enabled)
// - Uses ModelBus TP/SL (not computed here)

import { msToNY, nyDayKey } from '../utils/time.js';

export class ORB {
  constructor({
    decimals = 5,
    pipSize = 0.0001,

    // Opening Range window (NY time)
    startHourNY = 9.5,     // 9:30 NY
    durationMin = 30,      // 15 or 30

    // Entry confirmation and behavior
    confirmByClose = true, // require M1 close beyond range
    reverseLogic = false,  // true: short on break above, long on break below
    allowSecondChance = false, // allow opposite-side entry after first
    maxEntriesPerDay = 1,  // 1 or 2
    touchPips = 0,         // tolerance to consider "touch" (in pips)
    eodEndHourNY = 16.5,   // ignore breakouts after this (16:30 NY)

  } = {}) {
    this.decimals = decimals;
    this.pipSize = pipSize;

    this.startHourNY = startHourNY;
    this.durationMin = durationMin;
    this.confirmByClose = confirmByClose;
    this.reverseLogic = reverseLogic;
    this.allowSecondChance = allowSecondChance;
    this.maxEntriesPerDay = Math.max(1, Math.min(2, maxEntriesPerDay));
    this.touchTol = Math.max(0, touchPips * pipSize);
    this.eodEndHourNY = eodEndHourNY;

    // day/session state
    this.dayKey = null;
    this.orStarted = false;
    this.orComplete = false;
    this.orHigh = null;
    this.orLow = null;
    this.entriesTaken = 0;

    // last closed M1 price for confirmByClose
    this.lastClose = null;
  }

  resetDay() {
    this.orStarted = false;
    this.orComplete = false;
    this.orHigh = null;
    this.orLow = null;
    this.entriesTaken = 0;
    this.lastClose = null;
  }

  _inORWindow(tsMs) {
    const d = msToNY(tsMs);
    const hr = d.hour + d.minute / 60;
    return hr >= this.startHourNY && hr < (this.startHourNY + this.durationMin / 60);
  }

  _afterOR(tsMs) {
    const d = msToNY(tsMs);
    const hr = d.hour + d.minute / 60;
    return hr >= (this.startHourNY + this.durationMin / 60);
  }

  _beforeEOD(tsMs) {
    const d = msToNY(tsMs);
    const hr = d.hour + d.minute / 60;
    return hr <= this.eodEndHourNY;
  }

  // Expose range (optional)
  getOpeningRange() {
    return { started: this.orStarted, complete: this.orComplete, high: this.orHigh, low: this.orLow };
  }

  // Call on each closed M1 candle
  onM1Close(candle /* {ts, open, high, low, close} */, sessions /* unused */) {
    const dKey = nyDayKey(msToNY(candle.ts));
    if (this.dayKey !== dKey) {
      this.dayKey = dKey;
      this.resetDay();
    }
    // track last closed price for confirmByClose
    this.lastClose = candle.close;

    // build OR
    if (this._inORWindow(candle.ts)) {
      this.orStarted = true;
      this.orHigh = this.orHigh == null ? candle.high : Math.max(this.orHigh, candle.high);
      this.orLow  = this.orLow  == null ? candle.low  : Math.min(this.orLow, candle.low);
    }

    // lock OR at exact end
    if (!this.orComplete && this.orStarted && this._afterOR(candle.ts)) {
      if (this.orHigh != null && this.orLow != null) this.orComplete = true;
    }
  }

  // Call on each tick; returns {strategy, direction, entry} or null
  onTick(price, tsMs /*, sessions */) {
    if (!this.orComplete) return null;
    if (!this._beforeEOD(tsMs)) return null;
    if (this.entriesTaken >= this.maxEntriesPerDay) return null;
    if (this.orHigh == null || this.orLow == null) return null;

    // If confirmByClose, require last M1 close to be beyond range
    // else accept tick cross/touch
    let breakAbove = false, breakBelow = false;

    if (this.confirmByClose) {
      if (this.lastClose != null) {
        breakAbove = this.lastClose >= (this.orHigh - this.touchTol);
        breakBelow = this.lastClose <= (this.orLow + this.touchTol);
      }
    } else {
      breakAbove = price >= (this.orHigh - this.touchTol);
      breakBelow = price <= (this.orLow + this.touchTol);
    }

    if (!breakAbove && !breakBelow) return null;

    // Direction: normal or reversed
    // normal: break above → long; break below → short
    // reverse: break above → short; break below → long
    let dir = null;
    if (!this.reverseLogic) {
      if (breakAbove) dir = 'buy';
      else if (breakBelow) dir = 'sell';
    } else {
      if (breakAbove) dir = 'sell';
      else if (breakBelow) dir = 'buy';
    }
    if (!dir) return null;

    // entry price anchored to the range edge (like your Pine version using session_high/session_low)
    const entry = breakAbove ? this.orHigh : this.orLow;

    // First entry ok; second chance:
    // Note: exact “second chance only if first trade lost” needs trade result feedback.
    // Here we simply allow up to maxEntriesPerDay entries (possibly opposite side).
    this.entriesTaken += 1;

    return { strategy: 'ORB', direction: dir, entry };
  }
}