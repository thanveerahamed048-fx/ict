// src/strategies/candleRangeEntry.js
// ICT Candle Range Entry Strategy
// - Finds displacement after a liquidity sweep (Asia/PrevDay/DO)
// - Marks displacement range/body 50%, OB + 50%, FVG mid
// - Arms and enters on first touch in priority order (during NY window)
// - One trade per day

import { msToNY, nyDayKey } from '../utils/time.js';
import { detectFVG } from '../patterns/fvg.js';
import { atr as atr14 } from '../util/ts.js';

export class CandleRangeEntry {
  constructor({
    decimals = 5,
    pipSize = 0.0001,
    // NY window for entries (default: 08:30–11:00 NY)
    startHourNY = 8.5,
    endHourNY = 11,
    // sweep sources
    useAsia = true,
    usePrevDay = true,
    useDO = true,
    // displacement filter
    dispAtrMult = 1.2,     // body >= 1.2 * ATR(14)
    minBodyPips = 0,       // optional absolute body size in pips
    // arming/expiry
    expiryMin = 60,        // how long the setup stays armed
    // entry priorities (first touch wins)
    levels = ['fvgMid', 'ob50', 'body50', 'range50', 'obOpen'],
    touchPips = 1,         // tolerance in pips for touch
    // guards
    oneTradePerDay = true
  } = {}) {
    this.decimals = decimals;
    this.pipSize = pipSize;
    this.startHourNY = startHourNY;
    this.endHourNY = endHourNY;
    this.useAsia = useAsia;
    this.usePrevDay = usePrevDay;
    this.useDO = useDO;
    this.dispAtrMult = dispAtrMult;
    this.minBodyPips = minBodyPips;
    this.expiryMin = expiryMin;
    this.levels = Array.isArray(levels) ? levels : ['fvgMid', 'ob50', 'body50', 'range50', 'obOpen'];
    this.touchTol = Math.max(1e-10, touchPips * pipSize);
    this.oneTradePerDay = oneTradePerDay;

    // day/session state
    this.dayKey = null;
    this.enteredToday = false;

    // armed setup
    this.armed = null; // { dir:'buy'|'sell', formedTs, levels:{...}, fvg?, ob? }
  }

  resetDay() {
    this.enteredToday = false;
    this.armed = null;
  }

  // NY window check
  inWindowNY(tsMs) {
    const d = msToNY(tsMs);
    const hr = d.hour + d.minute / 60;
    return hr >= this.startHourNY && hr <= this.endHourNY;
  }

  // sweep detection (returns 'buy' if it swept SSL (below Asia/prevDay/DO) → expect up; 'sell' for BSL sweep)
  inferSweepDirection(c, sessions) {
    const { asiaHi, asiaLo, prevDayHigh, prevDayLow, dailyOpen } = sessions || {};
    let sweptBuy = false, sweptSell = false;

    if (this.useAsia) {
      if (asiaHi != null && c.high >= asiaHi) sweptSell = true;
      if (asiaLo != null && c.low  <= asiaLo) sweptBuy  = true;
    }
    if (this.usePrevDay) {
      if (prevDayHigh != null && c.high >= prevDayHigh) sweptSell = true;
      if (prevDayLow  != null && c.low  <= prevDayLow)  sweptBuy  = true;
    }
    if (this.useDO) {
      if (dailyOpen != null) {
        if (c.low <= dailyOpen && c.close > dailyOpen) sweptBuy = true;   // dipped below DO, closed above
        if (c.high >= dailyOpen && c.close < dailyOpen) sweptSell = true; // poked above DO, closed below
      }
    }

    if (sweptBuy && !sweptSell) return 'buy';
    if (sweptSell && !sweptBuy) return 'sell';
    // if both: pick direction by candle body
    if (sweptBuy && sweptSell) {
      return (c.close >= c.open) ? 'buy' : 'sell';
    }
    return null;
  }

  // compute OB (previous opposite candle) before displacement candle idx
  computeOrderBlock(M1, idx, dir) {
    if (idx <= 0) return null;
    const b = M1[idx - 1];
    if (!b) return null;
    // bull displacement → last down candle
    if (dir === 'buy' && b.close < b.open) {
      return { high: b.high, low: b.low, open: b.open, mid: (b.high + b.low) / 2 };
    }
    // bear displacement → last up candle
    if (dir === 'sell' && b.close > b.open) {
      return { high: b.high, low: b.low, open: b.open, mid: (b.high + b.low) / 2 };
    }
    return null;
  }

  // find latest FVG around idx
  computeFvgMidAround(M1, idx, dir) {
    // Build a small window of candles into a "candles" array expected by detectFVG
    const window = M1.slice(Math.max(0, idx - 10), idx + 2); // a bit before and include current
    const gaps = detectFVG(window, 20);
    if (!gaps || gaps.length === 0) return null;
    // last gap
    const last = gaps[gaps.length - 1];
    // ensure direction matches
    if (dir === 'buy' && last.type !== 'bull') return null;
    if (dir === 'sell' && last.type !== 'bear') return null;
    const mid = (last.gapLow + last.gapHigh) / 2;
    return { mid, gapLow: last.gapLow, gapHigh: last.gapHigh };
  }

  // called on each closed M1 candle
  onM1Close(candle, sessions, M1Ref) {
    const dKey = nyDayKey(msToNY(candle.ts));
    if (this.dayKey !== dKey) {
      this.dayKey = dKey;
      this.resetDay();
    }
    if (!M1Ref || M1Ref.length < 20) return;

    // Only arm inside NY window
    if (!this.inWindowNY(candle.ts)) return;

    // find displacement after sweep
    const M1 = M1Ref;
    const idx = M1.length - 1; // just closed
    const c = M1[idx];

    // displacement filter
    const atr = atr14(M1, 14);
    const body = Math.abs(c.close - c.open);
    const bodyPips = body / this.pipSize;
    const strongBody = (atr ? (body >= this.dispAtrMult * atr) : true)
                    && (this.minBodyPips > 0 ? bodyPips >= this.minBodyPips : true);
    if (!strongBody) return;

    const sweepDir = this.inferSweepDirection(c, sessions);
    if (!sweepDir) return;

    // Build displacement levels
    const range50 = (c.high + c.low) / 2;
    const body50  = (c.open + c.close) / 2;
    const ob      = this.computeOrderBlock(M1, idx, sweepDir);
    const fvg     = this.computeFvgMidAround(M1, idx, sweepDir);

    const formedTs = c.ts;
    this.armed = {
      dir: sweepDir,
      formedTs,
      // displacement candle levels
      high: c.high, low: c.low, body50, range50,
      // OB + FVG
      ob: ob ? { ...ob } : null,
      fvg: fvg ? { ...fvg } : null
    };
  }

  // called on each tick; returns entry when first level touched
  onTick(price, tsMs, sessions) {
    if (!this.armed) return null;
    if (this.oneTradePerDay && this.enteredToday) return null;

    // expire
    if (this.expiryMin > 0 && (tsMs - this.armed.formedTs) > this.expiryMin * 60_000) {
      this.armed = null;
      return null;
    }

    if (!this.inWindowNY(tsMs)) return null;

    // produce array of level objects with name+price in priority order
    const lv = [];
    for (const key of this.levels) {
      if (key === 'range50' && Number.isFinite(this.armed.range50)) lv.push({ name: 'range50', px: this.armed.range50 });
      if (key === 'body50'  && Number.isFinite(this.armed.body50))  lv.push({ name: 'body50',  px: this.armed.body50 });
      if (key === 'obOpen'  && this.armed.ob?.open != null)         lv.push({ name: 'obOpen',  px: this.armed.ob.open });
      if (key === 'ob50'    && this.armed.ob?.mid  != null)         lv.push({ name: 'ob50',    px: this.armed.ob.mid });
      if (key === 'fvgMid'  && this.armed.fvg?.mid != null)         lv.push({ name: 'fvgMid',  px: this.armed.fvg.mid });
    }
    if (lv.length === 0) return null;

    // touch detection
    for (const L of lv) {
      if (Math.abs(price - L.px) <= this.touchTol) {
        const dir = this.armed.dir;
        const entry = L.px;
        // fire once per day
        this.armed = null;
        this.enteredToday = true;
        return { strategy: 'CandleRange', direction: dir, entry, level: L.name };
      }
      // crossing check (from correct side)
      if (this.armed.dir === 'buy') {
        if (price >= L.px && (L.px - price) <= this.touchTol) {
          const entry = L.px;
          this.armed = null;
          this.enteredToday = true;
          return { strategy: 'CandleRange', direction: 'buy', entry, level: L.name };
        }
      } else {
        if (price <= L.px && (price - L.px) <= this.touchTol) {
          const entry = L.px;
          this.armed = null;
          this.enteredToday = true;
          return { strategy: 'CandleRange', direction: 'sell', entry, level: L.name };
        }
      }
    }
    return null;
  }
}