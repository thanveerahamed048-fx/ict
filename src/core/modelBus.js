// src/core/modelBus.js
import { DateTime } from 'luxon';
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
import { ORB } from '../strategies/orb.js';
import { GoldTimeStrategy } from '../strategies/goldTime.js';

export class ModelBus {
  constructor({ instrument, aggregator, log, notifier, monitor, propFirmManager, tradesCollection, enabledStrategies }) {
    this.instrument = instrument;
    this.aggregator = aggregator;
    this.log = log || console.log;
    this.notifier = notifier;
    this.monitor = monitor;
    this.propFirmManager = propFirmManager;
    this.tradesCollection = tradesCollection;
    this._asiaSavedForKey = null;

    // null = all enabled; Set = only named strategies fire
    this.enabledStrategies = enabledStrategies || null;

    // Crypto instruments skip FX session-based strategies
    this.isCrypto = !!instrument.isCrypto;

    // Do NOT call initEnteredStrategies() here — it is async and must be
    // awaited by the caller (startBot) before ticks arrive. (#13 fix)
    this.enteredStrategiesToday = new Set();

    // FX-only strategies (require NY session context)
    if (!this.isCrypto) {
      this.po3 = new PO3({ decimals: instrument.decimals, pipSize: instrument.pipSize, asset: 'fx' });
      this.fvgc = new FVGContinuation({ decimals: instrument.decimals, pipSize: instrument.pipSize });
      this.breaker = new BreakerReversal({ decimals: instrument.decimals, pipSize: instrument.pipSize });
      this.judas = new JudasSwing({ decimals: instrument.decimals, pipSize: instrument.pipSize });
      this.pdifvg = new PrevDayIFVG({ decimals: instrument.decimals, pipSize: instrument.pipSize, touchPips: 3 });
      this.nyRangeOB = new NyRangeOB({ decimals: instrument.decimals, pipSize: instrument.pipSize });
      this.candleRange = new CandleRangeEntry({
        decimals: instrument.decimals,
        pipSize: instrument.pipSize,
        startHourNY: 8.5,
        endHourNY: 11,
        useAsia: true,
        usePrevDay: true,
        useDO: true,
        dispAtrMult: 1.2,
        minBodyPips: 0,
        expiryMin: 60,
        levels: ['fvgMid', 'ob50', 'body50', 'range50', 'obOpen'],
        touchPips: 1,
        oneTradePerDay: false,
        multiPerSetup: true,
        minCooldownMs: 500
      });

      // Gold-specific
      this.goldTime = null;
      if (instrument.id === 'XAUUSD' || instrument.id.includes('XAU')) {
        this.goldTime = new GoldTimeStrategy({
          decimals: instrument.decimals,
          pipSize: instrument.pipSize,
          length: 14,
          checkHourNY: 4,
          tradeDurationHours: 8,
          oneTradePerDay: true
        });
      }
    }

    // ORB runs on all instruments.
    // Crypto: uses midnight NY as open, 1h range, runs all day.
    // FX: standard 9:30 NY open, 30min range, cuts off at 16:30.
    this.orb = new ORB({
      decimals: instrument.decimals,
      pipSize: instrument.pipSize,
      startHourNY: this.isCrypto ? 0 : 9.5,
      durationMin:  this.isCrypto ? 60 : 30,
      confirmByClose: true,
      reverseLogic: false,
      allowSecondChance: false,
      maxEntriesPerDay: 1,
      touchPips: 0,
      eodEndHourNY: this.isCrypto ? 23.5 : 16.5
    });

    this.lastDayKey = null;
    this.lastPrice = null;
  }

  async initEnteredStrategies() {
    if (!this.tradesCollection) return;
    try {
      const todayStr = DateTime.now().setZone('America/New_York').toFormat('yyyy-LL-dd');
      const docs = await this.tradesCollection.find({
        instrumentId: this.instrument.id,
        entryDateNY: todayStr
      }).toArray();
      for (const doc of docs) {
        if (doc.strategy) {
          this.enteredStrategiesToday.add(doc.strategy);
        }
      }

    } catch (e) {
      console.error(`[ModelBus] Error initializing entered strategies for ${this.instrument.id}:`, e);
    }
  }

  // Per-instrument TP/SL pips
  _getRR() {
    const id = this.instrument?.id || '';
    return RR_BY_SYMBOL[id] || DEFAULT_RR;
  }

  // Returns true if this strategy name is allowed to fire
  _isEnabled(name) {
    return !this.enabledStrategies || this.enabledStrategies.has(name);
  }

  onM1Close(candle) {
    const M1 = this.aggregator.getM1();
    const M5 = this.aggregator.getM5();
    const sessions = this.aggregator.getSessions();

    const dKey = nyDayKey(msToNY(candle.ts));
    if (this.lastDayKey !== dKey) {
      if (!this.isCrypto) {
        this.po3.resetDay?.();
        this.judas.resetDay?.();
        this.breaker.resetDay?.();
        this.pdifvg.resetDay?.();
        this.nyRangeOB.resetDay?.();
        this.candleRange.resetDay?.();
        this.goldTime?.resetDay?.();
      }
      this.orb.resetDay?.();
      this.enteredStrategiesToday.clear();
      this.lastDayKey = dKey;
      this._log(`New NY day. Prev H/L: ${fmtPx(sessions.prevDayHigh, this.instrument.decimals)} / ${fmtPx(sessions.prevDayLow, this.instrument.decimals)}`);
    }

    if (sessions.asiaDone && this._asiaSavedForKey !== dKey && sessions.asiaHi != null && sessions.asiaLo != null) {
      this._asiaSavedForKey = dKey;
      saveAsiaSnapshot(this.instrument.id, dKey, sessions).catch(() => {});
      this._log(`Asia snapshot saved for ${dKey}: [${sessions.asiaLo?.toFixed(this.instrument.decimals)} - ${sessions.asiaHi?.toFixed(this.instrument.decimals)}], DO=${sessions.dailyOpen != null ? sessions.dailyOpen.toFixed(this.instrument.decimals) : 'n/a'}`);
    }

    // FX-only strategies — skip for crypto
    if (!this.isCrypto) {
      if (this._isEnabled('PO3'))         this.po3.evaluate({ candles: M1, sessions });
      if (this._isEnabled('FVGC'))        this.fvgc.evaluate({ candles: M1, m5: M5, sessions });
      if (this._isEnabled('BREAKER'))     this.breaker.evaluate({ candles: M1, sessions });
      if (this._isEnabled('JUDAS'))       this.judas.evaluate({ candles: M1, sessions });
      if (this._isEnabled('PDIFVG'))      this.pdifvg.evaluate({ m5: M5, sessions });
      if (this._isEnabled('NYRangeOB'))   this.nyRangeOB.onM1Close(candle);
      if (this._isEnabled('CandleRange')) this.candleRange.onM1Close(candle, sessions, M1);
      if (this._isEnabled('GoldTime'))    this.goldTime?.onM1Close(candle, sessions, M1);
    }

    // ORB runs on all instruments
    if (this._isEnabled('ORB')) this.orb.onM1Close(candle, sessions);
  }

  onTick(price, tsMs) {
    this.lastPrice = price;
    const sessions = this.aggregator.getSessions();

    const rr = this._getRR();
    const variant = `TP${rr.tpPips}/SL${rr.slPips}`;

    // Skip trade entries if prop firm account has failed
    if (this.propFirmManager) {
      const acc = this.propFirmManager.getAccount();
      if (acc && acc.failed) {
        return;
      }
    }

    const handleEntry = async (strategyName, direction, entryPx, slPx, tpPx, entryTs) => {
      // Enforce only one entry per strategy per day
      if (this.enteredStrategiesToday.has(strategyName)) {
        return;
      }
      this.enteredStrategiesToday.add(strategyName);

      // Calculate lots
      let lots = 2.0;
      if (this.propFirmManager) {
        lots = this.propFirmManager.calculateLots(this.instrument.id, rr.slPips);
      }

      const tid = `${this.instrument.id}-${strategyName}-${entryTs}`;
      this._log(`${strategyName} ENTRY ${direction.toUpperCase()} @ ${entryPx.toFixed(this.instrument.decimals)} SL ${slPx.toFixed(this.instrument.decimals)} TP ${tpPx.toFixed(this.instrument.decimals)} (${variant}) id=${tid} lots=${lots}`);

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
        tsMs: entryTs,
        lots
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
        score: 0,
        lots
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
        variantLabel: variant,
        lots
      }).catch((e) => console.error('[Dashboard] post error:', e?.message || e));
    };

    // FX-only on-tick entries
    if (!this.isCrypto) {
      // PO3
      if (this._isEnabled('PO3')) {
        const p = this.po3.onPrice(price);
        if (p) {
          const { sl, tp } = this._buildFixedStops(p.entry, p.direction);
          handleEntry('PO3', p.direction, p.entry, sl, tp, tsMs);
        }
      }

      // PrevDay IFVG
      this.pdifvg.onTickTouch(price, sessions);
      if (this._isEnabled('PDIFVG')) {
        const pd = this.pdifvg.onPrice(price);
        if (pd) {
          const { sl, tp } = this._buildFixedStops(pd.entry, pd.direction);
          handleEntry('PDIFVG', pd.direction, pd.entry, sl, tp, tsMs);
        }
      }

      // NYRangeOB
      if (this._isEnabled('NYRangeOB')) {
        const nyob = this.nyRangeOB.onTick(price, tsMs);
        if (nyob) {
          const { sl, tp } = this._buildFixedStops(nyob.entry, nyob.direction);
          handleEntry('NYRangeOB', nyob.direction, nyob.entry, sl, tp, tsMs);
        }
      }

      // CandleRange
      if (this._isEnabled('CandleRange')) {
        const sigCR = this.candleRange.onTick(price, tsMs, sessions);
        if (sigCR) {
          const { sl, tp } = this._buildFixedStops(sigCR.entry, sigCR.direction);
          handleEntry('CandleRange', sigCR.direction, sigCR.entry, sl, tp, tsMs);
        }
      }

      // BREAKER — retest of breaker block zone
      if (this._isEnabled('BREAKER')) {
        const br = this.breaker.onPrice(price);
        if (br) {
          const { sl, tp } = this._buildFixedStops(br.entry, br.direction);
          handleEntry('BREAKER', br.direction, br.entry, sl, tp, tsMs);
        }
      }

      // JUDAS — London sweep fade
      if (this._isEnabled('JUDAS')) {
        const jd = this.judas.onPrice(price);
        if (jd) {
          const { sl, tp } = this._buildFixedStops(jd.entry, jd.direction);
          handleEntry('JUDAS', jd.direction, jd.entry, sl, tp, tsMs);
        }
      }

      // GoldTime (XAUUSD only)
      if (this._isEnabled('GoldTime')) {
        const gt = this.goldTime?.onTick(price, tsMs, sessions);
        if (gt) {
          const { sl, tp } = this._buildFixedStops(gt.entry, gt.direction);
          handleEntry('GoldTime', gt.direction, gt.entry, sl, tp, tsMs);
        }
      }
    }

    // ORB entry — runs on all instruments (FX + crypto)
    if (this._isEnabled('ORB')) {
      const sigORB = this.orb.onTick(price, tsMs, sessions);
      if (sigORB) {
        const { sl, tp } = this._buildFixedStops(sigORB.entry, sigORB.direction);
        handleEntry('ORB', sigORB.direction, sigORB.entry, sl, tp, tsMs);
      }
    }
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