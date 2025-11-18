// src/core/modelBus.js
import { fmtPx } from '../utils/format.js';
import { PO3 } from '../strategies/po3.js';
import { msToNY, nyDayKey } from '../utils/time.js';
import { saveAsiaSnapshot } from '../utils/persist.js';
import { FVGContinuation } from '../strategies/fvgContinuation.js';
import { BreakerReversal } from '../strategies/breakerReversal.js';
import { JudasSwing } from '../strategies/judasSwing.js';
import { PrevDayIFVG } from '../strategies/prevDayIFVG.js';
import { postStrategyEntry } from '../notify/dashboardClient.js';
import { NyRangeOB } from '../strategies/nyRangeOB.js';
import { CandleRangeEntry } from '../strategies/candleRangeEntry.js';
import { RR_BY_SYMBOL, DEFAULT_RR } from '../config/rr.js';

export class ModelBus {
  constructor({ instrument, aggregator, log, notifier, monitor }) {
    this.instrument = instrument;
    this.aggregator = aggregator;
    this.log = log || console.log;
    this.notifier = notifier;
    this.monitor = monitor;
    this._asiaSavedForKey = null;

    this.po3 = new PO3({ decimals: instrument.decimals, pipSize: instrument.pipSize, asset: 'fx' });
    this.fvgc = new FVGContinuation({ decimals: instrument.decimals, pipSize: instrument.pipSize });
    this.breaker = new BreakerReversal({ decimals: instrument.decimals, pipSize: instrument.pipSize });
    this.judas = new JudasSwing({ decimals: instrument.decimals, pipSize: instrument.pipSize });
    this.pdifvg = new PrevDayIFVG({ decimals: instrument.decimals, pipSize: instrument.pipSize, touchPips: 3 });
    this.nyRangeOB = new NyRangeOB({ decimals: instrument.decimals, pipSize: instrument.pipSize });

    this.candleRange = new CandleRangeEntry({
      decimals: instrument.decimals,
      pipSize: instrument.pipSize,
      startHourNY: 8.5,   // 08:30
      endHourNY: 11,
      useAsia: true,
      usePrevDay: true,
      useDO: true,
      dispAtrMult: 1.2,
      minBodyPips: 0,
      expiryMin: 60,
      levels: ['fvgMid', 'ob50', 'body50', 'range50', 'obOpen'],
      touchPips: 1,
      oneTradePerDay: true
    });

    this.lastDayKey = null;
    this.lastPrice = null;
  }

  // Per-instrument TP/SL pips
  _getRR() {
    const id = this.instrument?.id || '';
    return RR_BY_SYMBOL[id] || DEFAULT_RR; // { tpPips, slPips }
  }

  onM1Close(candle) {
    const M1 = this.aggregator.getM1();
    const M5 = this.aggregator.getM5();
    const sessions = this.aggregator.getSessions();

    const dKey = nyDayKey(msToNY(candle.ts));
    if (this.lastDayKey !== dKey) {
      this.po3.resetDay?.();
      this.judas.resetDay?.();
      this.pdifvg.resetDay?.();
      this.nyRangeOB.resetDay?.();
      this.candleRange.resetDay?.();
      this.lastDayKey = dKey;
      this._log(`New NY day. Prev H/L: ${fmtPx(sessions.prevDayHigh, this.instrument.decimals)} / ${fmtPx(sessions.prevDayLow, this.instrument.decimals)}`);
    }

    if (sessions.asiaDone && this._asiaSavedForKey !== dKey && sessions.asiaHi != null && sessions.asiaLo != null) {
      this._asiaSavedForKey = dKey;
      saveAsiaSnapshot(this.instrument.id, dKey, sessions).catch(() => {});
      this._log(`Asia snapshot saved for ${dKey}: [${sessions.asiaLo?.toFixed(this.instrument.decimals)} - ${sessions.asiaHi?.toFixed(this.instrument.decimals)}], DO=${sessions.dailyOpen != null ? sessions.dailyOpen.toFixed(this.instrument.decimals) : 'n/a'}`);
    }

    // Evaluate setups (entries fire on tick)
    this.po3.evaluate({ candles: M1, sessions });
    this.fvgc.evaluate({ candles: M1, m5: M5, sessions });
    this.breaker.evaluate({ candles: M1, sessions });
    this.judas.evaluate({ candles: M1, sessions });
    this.pdifvg.evaluate({ m5: M5, sessions });
    this.nyRangeOB.onM1Close(candle);
    this.candleRange.onM1Close(candle, sessions, M1);
  }

  onTick(price, tsMs) {
    this.lastPrice = price;
    const sessions = this.aggregator.getSessions();

    const rr = this._getRR();
    const variant = `TP${rr.tpPips}/SL${rr.slPips}`;

    const handleEntry = async (strategyName, direction, entryPx, slPx, tpPx, entryTs) => {
      const tid = `${this.instrument.id}-${strategyName}-${entryTs}`;
      this._log(`${strategyName} ENTRY ${direction.toUpperCase()} @ ${entryPx.toFixed(this.instrument.decimals)} SL ${slPx.toFixed(this.instrument.decimals)} TP ${tpPx.toFixed(this.instrument.decimals)} (${variant}) id=${tid}`);

      // Email
      this.notifier?.sendSignal({
        type: 'strategy_entry',
        strategy: strategyName,
        instrumentId: this.instrument.id,
        decimals: this.instrument.decimals,
        direction,
        entry: entryPx,
        sl: slPx,
        tp: tpPx,
        slPips: rr.slPips,
        tpPips: rr.tpPips,
        sessions,
        tsMs: entryTs
      }).catch((e) => console.error('[mail] send error:', e?.message || e));

      // Monitor
      this.monitor?.addTrade({
        instrumentId: this.instrument.id,
        direction,
        entry: entryPx,
        entryTs,
        sl: slPx,
        tp: tpPx,
        pipSize: this.instrument.pipSize,
        decimals: this.instrument.decimals,
        cause: strategyName,
        variantLabel: variant,
        sessions,
        models: [strategyName],
        score: 0
      });

      // Dashboard
      postStrategyEntry({
        instrumentId: this.instrument.id,
        strategy: strategyName,
        direction,
        entry: entryPx,
        entryTs,
        sl: slPx,
        tp: tpPx,
        pipSize: this.instrument.pipSize,
        decimals: this.instrument.decimals,
        tpPips: rr.tpPips,
        slPips: rr.slPips,
        sessions,
        models: [strategyName],
        score: 0,
        variantLabel: variant
      }).catch((e) => console.error('[Dashboard] post error:', e?.message || e));
    };

    // PO3
    const p = this.po3.onPrice(price);
    if (p) {
      const { sl, tp } = this._buildFixedStops(p.entry, p.direction);
      handleEntry('PO3', p.direction, p.entry, sl, tp, tsMs);
    }

    // PrevDay IFVG: register touch + check entry
    this.pdifvg.onTickTouch(price, sessions);
    const pd = this.pdifvg.onPrice(price);
    if (pd) {
      const { sl, tp } = this._buildFixedStops(pd.entry, pd.direction);
      handleEntry('PDIFVG', pd.direction, pd.entry, sl, tp, tsMs);
    }

    // NYRangeOB
    const nyob = this.nyRangeOB.onTick(price, tsMs);
    if (nyob) {
      const { sl, tp } = this._buildFixedStops(nyob.entry, nyob.direction);
      handleEntry('NYRangeOB', nyob.direction, nyob.entry, sl, tp, tsMs);
    }

    // CandleRange (ICT displacement candle retrace)
    const sigCR = this.candleRange.onTick(price, tsMs, sessions);
    if (sigCR) {
      const { sl, tp } = this._buildFixedStops(sigCR.entry, sigCR.direction);
      handleEntry('CandleRange', sigCR.direction, sigCR.entry, sl, tp, tsMs);
    }

    // Others: BREAKER, JUDAS if you want to re-enable on-tick entry later.
  }

  _buildFixedStops(entry, direction) {
    const { tpPips, slPips } = this._getRR();
    const pip = this.instrument.pipSize;
    const tpDist = tpPips * pip;
    const slDist = slPips * pip;
    if (direction === 'buy') return { sl: entry - slDist, tp: entry + tpDist };
    return { sl: entry + slDist, tp: entry - tpDist };
  }

  _log(msg) {
    this.log(`${this.instrument.id} | ${msg}`);
  }
}