// src/strategies/prevDayIFVG.js
import { detectFVG } from '../patterns/fvg.js';

export class PrevDayIFVG {
  constructor({ decimals = 5, pipSize = 0.0001, touchPips = 3 }) {
    this.decimals = decimals;
    this.pipSize = pipSize;
    this.touchTol = Math.max(1e-10, touchPips * pipSize); // touch tolerance
    this.prevPrice = null;

    this.touched = null; // { levelType:'open'|'close', level, side:'from_above'|'from_below', ts }
    this.lastFvgKey = null;
    this.armed = null;   // { dir:'buy'|'sell', ts }
  }

  // Call on each tick to capture level touches
  onTickTouch(price, sessions) {
    const pdo = sessions.prevDayOpen;
    const pdc = sessions.prevDayClose;
    if (pdo == null && pdc == null) { this.prevPrice = price; return; }

    const checkLevel = (level, levelType) => {
      if (level == null) return;
      if (Math.abs(price - level) <= this.touchTol && !this.touched) {
        const side = this.prevPrice == null ? 'equal' : (this.prevPrice > level ? 'from_above' : (this.prevPrice < level ? 'from_below' : 'equal'));
        this.touched = { levelType, level, side, ts: Date.now() };
      }
    };

    checkLevel(pdo, 'open');
    checkLevel(pdc, 'close');

    this.prevPrice = price;
  }

  // Call on M1 close (with M5 available)
  evaluate({ m5, sessions }) {
    if (!this.touched) return null;
    if (!m5 || m5.length < 3) return null;

    const gaps = detectFVG(m5, 40);
    const last = gaps.at(-1);
    if (!last) return null;

    const key = `${last.type}:${last.endIndex}`;
    if (key === this.lastFvgKey) return null;

    // Inverse logic: touch from above -> need bull gap; touch from below -> need bear gap
    const need = this.touched.side === 'from_above' ? 'bull'
               : this.touched.side === 'from_below' ? 'bear'
               : null;
    if (!need) return null;

    if (last.type === need) {
      this.lastFvgKey = key;
      const dir = need === 'bull' ? 'buy' : 'sell';
      this.armed = { dir, ts: m5[m5.length - 1].ts };
      // optional: return an event object if you want to log setups
      return { model: 'PDIFVG', event: 'armed', data: { dir, touched: this.touched } };
    }
    return null;
  }

  // Call on each tick to emit a market entry once armed
  onPrice(price) {
    if (!this.armed) return null;
    const entry = price;
    const dir = this.armed.dir;

    // Fire once then clear for the day
    this.armed = null;
    this.touched = null;

    return { direction: dir, entry, strategy: 'PDIFVG' };
  }

  resetDay() {
    this.prevPrice = null;
    this.touched = null;
    this.armed = null;
    this.lastFvgKey = null;
  }
}