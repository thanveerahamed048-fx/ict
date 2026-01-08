// src/strategies/candleRangeEntry.js
// ICT Candle Range Entry Strategy
// - Finds displacement after a liquidity sweep (Asia/PrevDay/DO)
// - Marks displacement range/body 50%, OB + 50%, FVG mid
// - Arms a prioritized list of levels; fires on touch/cross in NY window
// - One-or-multi trades per day and multi-per-setup (configurable)

import { msToNY, nyDayKey } from '../utils/time.js';
import { detectFVG } from '../patterns/fvg.js';
import { atr as atr14 } from '../utils/ta.js';

export class CandleRangeEntry {
  constructor({
    decimals = 5,
    pipSize = 0.0001,

    // NY window
    startHourNY = 8.5,      // 08:30 NY
    endHourNY = 11,         // 11:00 NY

    // sweep sources
    useAsia = true,
    usePrevDay = true,
    useDO = true,

    // displacement filter
    dispAtrMult = 1.2,      // body >= 1.2 * ATR(14)
    minBodyPips = 0,        // minimum absolute body in pips (0 = off)

    // arming/expiry
    expiryMin = 60,         // armed setup expiry in minutes

    // entry priorities (first valid touch wins per fire)
    levels = ['fvgMid', 'ob50', 'body50', 'range50', 'obOpen'],
    touchPips = 1,          // tolerance (in pips) for "touch"

    // guards
    oneTradePerDay = true,  // cap per day
    multiPerSetup = false,  // allow multiple signals from the same displacement
    minCooldownMs = 1000    // debounce between fires
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

    this.oneTradePerDay = !!oneTradePerDay;
    this.multiPerSetup = !!multiPerSetup;
    this.minCooldownMs = Math.max(0, minCooldownMs);
    this._lastFireTs = 0;

    // day/session state
    this.dayKey = null;
    this.enteredToday = false;

    // armed setup
    // { dir:'buy'|'sell', formedTs, body50, range50, ob?, fvg?, levelsList:[{name,px}], used:Set<string> }
    this.armed = null;
  }

  resetDay() {
    this.enteredToday = false;
    this.armed = null;
    this._lastFireTs = 0;
  }

  // NY window check
  inWindowNY(tsMs) {
    const d = msToNY(tsMs);
    const hr = d.hour + d.minute / 60;
    return hr >= this.startHourNY && hr <= this.endHourNY;
  }

  // Sweep direction inference: returns 'buy' if SSL swept, 'sell' if BSL swept
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
    if (this.useDO && dailyOpen != null) {
      // Node-aligned DO sweep
      if (c.low  <= dailyOpen && c.close > dailyOpen) sweptBuy  = true;
      if (c.high >= dailyOpen && c.close < dailyOpen) sweptSell = true;
    }

    if (sweptBuy && !sweptSell) return 'buy';
    if (sweptSell && !sweptBuy) return 'sell';
    if (sweptBuy && sweptSell)  return (c.close >= c.open ? 'buy' : 'sell');
    return null;
  }

  // Previous opposite-color candle as OB
  computeOrderBlock(M1, idx, dir) {
    if (idx <= 0) return null;
    const b = M1[idx - 1];
    if (!b) return null;
    if (dir === 'buy'  && b.close < b.open) return { high: b.high, low: b.low, open: b.open, mid: (b.high + b.low) / 2 };
    if (dir === 'sell' && b.close > b.open) return { high: b.high, low: b.low, open: b.open, mid: (b.high + b.low) / 2 };
    return null;
  }

  // recent FVG around idx
  computeFvgMidAround(M1, idx, dir) {
    // look ~20 closed bars back (idx is the last closed)
    const window = M1.slice(Math.max(0, idx - 20), idx + 1);
    const gaps = detectFVG(window, 40);
    if (!gaps || gaps.length === 0) return null;
    const last = gaps[gaps.length - 1];
    if (dir === 'buy'  && last.type !== 'bull') return null;
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
    if (!this.inWindowNY(candle.ts)) return;

    const M1 = M1Ref;
    const idx = M1.length - 1;
    const c = M1[idx];

    // displacement filter
    const atr = atr14(M1, 14) || 0;
    const body = Math.abs(c.close - c.open);
    const bodyPips = body / this.pipSize;
    const strongBody =
      (atr ? (body >= this.dispAtrMult * atr) : true) &&
      (this.minBodyPips > 0 ? bodyPips >= this.minBodyPips : true);
    if (!strongBody) return;

    const sweepDir = this.inferSweepDirection(c, sessions);
    if (!sweepDir) return;

    // displacement levels
    const range50 = (c.high + c.low) / 2;
    const body50  = (c.open + c.close) / 2;

    const ob  = this.computeOrderBlock(M1, idx, sweepDir);
    const fvg = this.computeFvgMidAround(M1, idx, sweepDir);

    // Build level list in requested priority
    const lvlList = [];
    const add = (name, px) => { if (Number.isFinite(px)) lvlList.push({ name, px }); };
    for (const key of this.levels) {
      if (key === 'fvgMid' && fvg) add('fvgMid', fvg.mid);
      if (key === 'ob50'   && ob)  add('ob50', ob.mid);
      if (key === 'body50')         add('body50', body50);
      if (key === 'range50')        add('range50', range50);
      if (key === 'obOpen' && ob)   add('obOpen', ob.open);
    }
    if (lvlList.length === 0) return;

    this.armed = {
      dir: sweepDir,
      formedTs: c.ts,
      body50,
      range50,
      ob: ob ? { ...ob } : null,
      fvg: fvg ? { ...fvg } : null,
      levelsList: lvlList,
      used: new Set()
    };
  }

  // called on each tick; returns {strategy, direction, entry, level} or null
  onTick(price, tsMs /*, sessions */) {
    if (!this.armed) return null;
    if (this.oneTradePerDay && this.enteredToday) return null;

    // expiry
    if (this.expiryMin > 0 && (tsMs - this.armed.formedTs) > this.expiryMin * 60_000) {
      this.armed = null;
      return null;
    }
    if (!this.inWindowNY(tsMs)) return null;

    // debounce
    if (tsMs - this._lastFireTs < this.minCooldownMs) return null;

    const tol = this.touchTol;
    const dir = this.armed.dir;

    // scan levels in priority order; allow multi-per-setup if enabled
    for (const L of this.armed.levelsList) {
      if (this.armed.used.has(L.name)) continue;

      const touched =
        Math.abs(price - L.px) <= tol ||
        (dir === 'buy'  && price >= L.px - tol) ||
        (dir === 'sell' && price <= L.px + tol);

      if (!touched) continue;

      // Fire one
      this._lastFireTs = tsMs;
      this.enteredToday = true;

      if (this.multiPerSetup) {
        this.armed.used.add(L.name);
        const remain = this.armed.levelsList.some(x => !this.armed.used.has(x.name));
        if (!remain) this.armed = null;
      } else {
        this.armed = null;
      }

      return { strategy: 'CandleRange', direction: dir, entry: L.px, level: L.name };
    }
    return null;
  }
}