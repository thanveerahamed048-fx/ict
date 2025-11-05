// src/strategies/nyRangeOB.js
//
// Strategy (NY time):
//  1) Build the 4‑hour candle from 17:00–21:00 NY (capture its high/low).
//  2) Lock those levels at 21:00 NY (when the 4H candle closes).
//  3) After 21:00 NY, wait for price to sweep either the 17–21h high or low.
//  4) After the sweep, detect an Order Block (OB) on synthetic M3 bars via displacement.
//  5) Enter on the first retest of the OB midpoint in the displacement direction.
//  6) ModelBus applies your fixed pip TP/SL (e.g., 60/60 or 150/150), enforcing 1:1.

import { msToNY, nyDayKey } from '../utils/time.js';

const FOUR_H_START = 17;  // 17:00 NY
const FOUR_H_END   = 21;  // 21:00 NY (lock time)
const SESSION_START= 21;  // start looking for sweeps/entries

export class NyRangeOB {
  constructor({ decimals = 5, pipSize = 0.0001 } = {}) {
    this.decimals = decimals;
    this.pipSize = pipSize;

    // intra‑day state
    this.dayKey = null;
    this.rangeHi17_4h = null; // 17–21h 4H high
    this.rangeLo17_4h = null; // 17–21h 4H low
    this.rangeLocked = false;

    this.sweepSide = null;       // 'high'|'low'
    this.lastSweepTs = null;
    this.armed = null;           // {side:'sell'|'buy', obHigh, obLow, mid, formedTs}
    this.doneForDay = false;

    // 3‑minute bars (built from M1)
    this.m3Bars = [];
    this._m3Key = null;
    this._m3Cur = null;

    // tick memory
    this.prevPrice = null;
  }

  resetDay() {
    this.dayKey = null;
    this.rangeHi17_4h = null;
    this.rangeLo17_4h = null;
    this.rangeLocked = false;

    this.sweepSide = null;
    this.lastSweepTs = null;
    this.armed = null;
    this.doneForDay = false;

    this.m3Bars = [];
    this._m3Key = this._m3Cur = null;

    this.prevPrice = null;
  }

  // Feed M1 closes (call from ModelBus.onM1Close)
  onM1Close(candle) {
    const dt = msToNY(candle.ts);
    const dKey = nyDayKey(dt);
    const hr = dt.hour + dt.minute / 60;

    // New NY day -> reset
    if (this.dayKey !== dKey) { this.resetDay(); this.dayKey = dKey; }

    // Build the 4H bar from 17:00–21:00 NY (capture high/low while forming)
    if (hr >= FOUR_H_START && hr < FOUR_H_END) {
      this.rangeHi17_4h = this.rangeHi17_4h == null ? candle.high : Math.max(this.rangeHi17_4h, candle.high);
      this.rangeLo17_4h = this.rangeLo17_4h == null ? candle.low  : Math.min(this.rangeLo17_4h, candle.low);
    }

    // Lock levels at/after 21:00 NY
    if (!this.rangeLocked && hr >= FOUR_H_END) this.rangeLocked = true;

    // Build M3 bars and try to detect OB after a sweep
    this._ingestM1ToM3(candle);
    if (this.m3Bars.length >= 3) this._detectOrderBlocks();
  }

  // Feed ticks (call from ModelBus.onTick) — returns { strategy, direction, entry } or null
  onTick(price, tsMs) {
    const dt = msToNY(tsMs);
    const hr = dt.hour + dt.minute / 60;

    if (!this.rangeLocked || this.doneForDay) { this.prevPrice = price; return null; }
    if (hr < SESSION_START) { this.prevPrice = price; return null; }

    // Detect sweep crosses vs locked levels
    if (this.rangeHi17_4h != null && this.prevPrice != null && this.prevPrice < this.rangeHi17_4h && price >= this.rangeHi17_4h) {
      this.sweepSide = 'high'; this.lastSweepTs = tsMs; this.armed = null;
    }
    if (this.rangeLo17_4h != null && this.prevPrice != null && this.prevPrice > this.rangeLo17_4h && price <= this.rangeLo17_4h) {
      this.sweepSide = 'low';  this.lastSweepTs = tsMs; this.armed = null;
    }

    // Entry trigger: retest/cross of OB midpoint in displacement direction
    if (this.armed) {
      const { mid, side } = this.armed;
      if (side === 'sell' && this.prevPrice > mid && price <= mid) {
        this.doneForDay = true; this.armed = null; this.prevPrice = price;
        return { strategy: 'NYRangeOB', direction: 'sell', entry: mid };
      }
      if (side === 'buy' && this.prevPrice < mid && price >= mid) {
        this.doneForDay = true; this.armed = null; this.prevPrice = price;
        return { strategy: 'NYRangeOB', direction: 'buy', entry: mid };
      }
    }

    this.prevPrice = price;
    return null;
  }

  // ---- internals ------------------------------------------------------------

  _ingestM1ToM3(m1) {
    const minuteKey = Math.floor(m1.ts / 60000);
    const m3Key = Math.floor(minuteKey / 3);

    if (this._m3Key == null) {
      this._m3Key = m3Key;
      this._m3Cur = { ts: m1.ts, open: m1.open, high: m1.high, low: m1.low, close: m1.close };
      return;
    }

    if (m3Key !== this._m3Key) {
      this.m3Bars.push(this._m3Cur);
      if (this.m3Bars.length > 500) this.m3Bars.shift();
      this._m3Key = m3Key;
      this._m3Cur = { ts: m1.ts, open: m1.open, high: m1.high, low: m1.low, close: m1.close };
    } else {
      const c = this._m3Cur;
      c.high = Math.max(c.high, m1.high);
      c.low  = Math.min(c.low, m1.low);
      c.close = m1.close;
    }
  }

  _detectOrderBlocks() {
    if (this.m3Bars.length < 3 || !this.lastSweepTs || this.armed || this.doneForDay) return;

    const last3 = this.m3Bars.slice(-3);
    const [, prev, cur] = last3;

    // Displacement vs recent average range
    const win = this.m3Bars.slice(-10);
    if (win.length < 3) return;
    const avgRange = win.reduce((a, b) => a + (b.high - b.low), 0) / win.length;
    const curRange = cur.high - cur.low;
    const displacement = curRange > 1.3 * avgRange;
    if (!displacement) return;

    if (this.sweepSide === 'high') {
      // Bearish OB: prior M3 was up; now strong close below its low
      if (prev.close > prev.open && cur.close < prev.low) {
        const obHigh = prev.high, obLow = prev.low, mid = (obHigh + obLow) / 2;
        this.armed = { side: 'sell', obHigh, obLow, mid, formedTs: cur.ts };
      }
    } else if (this.sweepSide === 'low') {
      // Bullish OB: prior M3 was down; now strong close above its high
      if (prev.close < prev.open && cur.close > prev.high) {
        const obHigh = prev.high, obLow = prev.low, mid = (obHigh + obLow) / 2;
        this.armed = { side: 'buy', obHigh, obLow, mid, formedTs: cur.ts };
      }
    }
  }
}