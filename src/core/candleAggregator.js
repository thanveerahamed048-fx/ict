// src/core/candleAggregator.js
import { msToNY, nyDayKey, inHourRangeNY, SESSIONS } from '../utils/time.js';

export class CandleAggregator {
  constructor({ onM1, onM5, instrument }) {
    this.instrument = instrument;
    this.onM1 = onM1;
    this.onM5 = onM5;

    this.currentM1 = null;
    this.m1 = [];
    this.m5 = [];

    // Session/day state
    this.dayKey = null;
    this.dailyOpen = null;
    this.asiaHi = null;
    this.asiaLo = null;
    this.asiaDone = false;
    this.prevDayHigh = null;
    this.prevDayLow = null;
    this.prevDayOpen = null;   // NEW
    this.prevDayClose = null;  // NEW
    this.todayHigh = null;
    this.todayLow = null;
  }

  ingestTick(price, tsMs) {
    const minuteKey = Math.floor(tsMs / 60000);
    if (!this.currentM1) {
      this.currentM1 = { minuteKey, candle: this._newCandle(minuteKey, price) };
      return;
    }
    const entry = this.currentM1;

    if (minuteKey !== entry.minuteKey) {
      this._finalizeM1(entry.candle);
      this.currentM1 = { minuteKey, candle: this._newCandle(minuteKey, price) };
      return;
    }

    const c = entry.candle;
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
  }

  getM1() { return this.m1; }
  getM5() { return this.m5; }

  getSessions() {
    return {
      dayKey: this.dayKey,
      dailyOpen: this.dailyOpen,
      asiaHi: this.asiaHi,
      asiaLo: this.asiaLo,
      asiaDone: this.asiaDone,
      prevDayHigh: this.prevDayHigh,
      prevDayLow: this.prevDayLow,
      prevDayOpen: this.prevDayOpen,     // NEW
      prevDayClose: this.prevDayClose,   // NEW
      todayHigh: this.todayHigh,
      todayLow: this.todayLow
    };
  }

  // Seed historical M1 candles (ascending). Silent by default (no callbacks).
  seedM1History(candles, { silent = true } = {}) {
    const savedOnM1 = this.onM1;
    const savedOnM5 = this.onM5;
    if (silent) { this.onM1 = null; this.onM5 = null; }
    for (const c of candles) this._finalizeM1(c);
    if (silent) { this.onM1 = savedOnM1; this.onM5 = savedOnM5; }
  }

  // Seed session fields directly (e.g., from a saved snapshot)
  seedSession({ dayKey, dailyOpen, asiaHi, asiaLo, asiaDone, prevDayHigh, prevDayLow, prevDayOpen, prevDayClose, todayHigh, todayLow }) {
    if (dayKey) this.dayKey = dayKey;
    if (dailyOpen != null) this.dailyOpen = dailyOpen;
    if (asiaHi != null) this.asiaHi = asiaHi;
    if (asiaLo != null) this.asiaLo = asiaLo;
    if (asiaDone != null) this.asiaDone = asiaDone;
    if (prevDayHigh != null) this.prevDayHigh = prevDayHigh;
    if (prevDayLow != null) this.prevDayLow = prevDayLow;
    if (prevDayOpen != null) this.prevDayOpen = prevDayOpen;     // NEW
    if (prevDayClose != null) this.prevDayClose = prevDayClose;  // NEW
    if (todayHigh != null) this.todayHigh = todayHigh;
    if (todayLow != null) this.todayLow = todayLow;
  }

  _newCandle(minuteKey, price) {
    const ts = minuteKey * 60000;
    return { ts, open: price, high: price, low: price, close: price, volume: 0 };
  }

  _finalizeM1(c) {
    const dtNY = msToNY(c.ts);
    const dKey = nyDayKey(dtNY);

    // Day roll: the candle 'c' belongs to dKey (maybe new day)
    if (this.dayKey !== dKey) {
      if (this.dayKey !== null) {
        // Close out previous day stats before reset
        this.prevDayHigh = this.todayHigh;
        this.prevDayLow = this.todayLow;
        this.prevDayOpen = this.dailyOpen;                         // NEW
        this.prevDayClose = this.m1.length ? this.m1[this.m1.length - 1].close : null; // NEW (last M1 close of prior day)
      }
      // Reset for new day
      this.dayKey = dKey;
      this.dailyOpen = null;
      this.asiaHi = null;
      this.asiaLo = null;
      this.asiaDone = false;
      this.todayHigh = null;
      this.todayLow = null;
    }

    // Daily open at 00:00 NY
    if (dtNY.hour === 0 && dtNY.minute === 0 && this.dailyOpen == null) {
      this.dailyOpen = c.open;
    }

    // Track today H/L
    this.todayHigh = this.todayHigh == null ? c.high : Math.max(this.todayHigh, c.high);
    this.todayLow  = this.todayLow  == null ? c.low  : Math.min(this.todayLow, c.low);

    // Asia range 00:00–05:00 NY
    if (inHourRangeNY(dtNY, SESSIONS.ASIA_START, SESSIONS.ASIA_END)) {
      this.asiaHi = this.asiaHi == null ? c.high : Math.max(this.asiaHi, c.high);
      this.asiaLo = this.asiaLo == null ? c.low  : Math.min(this.asiaLo, c.low);
      if (dtNY.hour === SESSIONS.ASIA_END && dtNY.minute === 0) this.asiaDone = true;
    }

    // Push M1
    this.m1.push(c);
    if (this.m1.length > 5000) this.m1.shift();
    if (this.onM1) this.onM1(c);

    // Build M5 every 5 candles
    if (this.m1.length >= 5) {
      const last5 = this.m1.slice(-5);
      const first = last5[0], last = last5[last5.length - 1];
      const m5c = {
        ts: first.ts, open: first.open,
        high: Math.max(...last5.map(x => x.high)),
        low: Math.min(...last5.map(x => x.low)),
        close: last.close, volume: 0
      };
      this.m5.push(m5c);
      if (this.m5.length > 2000) this.m5.shift();
      if (this.onM5) this.onM5(m5c);
    }
  }
}