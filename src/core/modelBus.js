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

// CONFIG: fixed pip distances (keep equal => 1:1 RR)
const TP_PIPS = 60;
const SL_PIPS = 60;

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
    this.pdifvg = new PrevDayIFVG({ decimals: instrument.decimals, pipSize: instrument.pipSize, touchPips: 3 }); // NEW

    this.lastDayKey = null;
    this.lastPrice = null;
  }

  onM1Close(candle) {
    const M1 = this.aggregator.getM1();
    const M5 = this.aggregator.getM5();
    const sessions = this.aggregator.getSessions();

    const dKey = nyDayKey(msToNY(candle.ts));
    if (this.lastDayKey !== dKey) {
      this.po3.resetDay?.(); this.judas.resetDay?.(); this.pdifvg.resetDay?.(); // NEW
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
    this.pdifvg.evaluate({ m5: M5, sessions }); // NEW (needs M5 + sessions)
  }

  onTick(price, tsMs) {
    this.lastPrice = price;
    const sessions = this.aggregator.getSessions();

    const handleEntry = async (strategyName, direction, entryPx, slPx, tpPx, entryTs) => {
      const tid = `${this.instrument.id}-${strategyName}-${entryTs}`;
      this._log(`${strategyName} ENTRY ${direction.toUpperCase()} @ ${entryPx.toFixed(this.instrument.decimals)} SL ${slPx.toFixed(this.instrument.decimals)} TP ${tpPx.toFixed(this.instrument.decimals)} (TP+${TP_PIPS}p / SL-${SL_PIPS}p) id=${tid}`);

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
        slPips: SL_PIPS,
        tpPips: TP_PIPS,
        sessions,
        tsMs: entryTs
      }).catch(() => {});

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
        variantLabel: `TP${TP_PIPS}/SL${SL_PIPS}`,
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
        tpPips: TP_PIPS,
        slPips: SL_PIPS,
        sessions,
        models: [strategyName],
        score: 0,
        variantLabel: `TP${TP_PIPS}/SL${SL_PIPS}`
      }).catch(() => {});
    };

    // PO3
    const p = this.po3.onPrice(price);
    if (p) {
      const { sl, tp } = this._buildFixedStops(p.entry, p.direction);
      handleEntry('PO3', p.direction, p.entry, sl, tp, tsMs);
    }

    // Notify PDIFVG about touches (prev-day open/close)
    this.pdifvg.onTickTouch(price, sessions);
    const pd = this.pdifvg.onPrice(price);
    if (pd) {
      const { sl, tp } = this._buildFixedStops(pd.entry, pd.direction);
      handleEntry('PDIFVG', pd.direction, pd.entry, sl, tp, tsMs);
    }

    // FVGC, BREAKER, JUDAS
    for (const strat of [
      { name: 'FVGC', ref: this.fvgc },
      { name: 'BREAKER', ref: this.breaker },
      { name: 'JUDAS', ref: this.judas }
    ]) {
      const e = strat.ref.onPrice(price);
      if (!e) continue;
      const { sl, tp } = this._buildFixedStops(e.entry, e.direction);
      handleEntry(strat.name, e.direction, e.entry, sl, tp, tsMs);
    }
  }

  _buildFixedStops(entry, direction) {
    const pip = this.instrument.pipSize;
    const tpDist = TP_PIPS * pip;
    const slDist = SL_PIPS * pip;
    if (direction === 'buy') return { sl: entry - slDist, tp: entry + tpDist };
    return { sl: entry + slDist, tp: entry - tpDist };
  }

  _log(msg) {
    this.log(`${this.instrument.id} | ${msg}`);
  }
}