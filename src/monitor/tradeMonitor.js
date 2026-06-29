// src/monitor/tradeMonitor.js
import { postResult, postSlUpdate, postPartialClose } from '../notify/dashboardClient.js';

export class TradeMonitor {
  constructor({ notifier, instrumentMap }) {
    this.notifier = notifier;
    this.instrumentMap = instrumentMap;
    this.trades = [];
  }

  addTrade(trade) {
    const id = `${trade.instrumentId}-${trade.cause}-${trade.entryTs}`;
    const pipSize  = trade.pipSize  ?? this.instrumentMap.get(trade.instrumentId)?.pipSize  ?? 0.0001;
    const decimals = trade.decimals ?? this.instrumentMap.get(trade.instrumentId)?.decimals ?? 5;

    // slDist = original distance from entry to SL in price terms
    const slDist = Math.abs(trade.sl - trade.entry);

    this.trades.push({
      id, ...trade, pipSize, decimals, open: true,
      originalSl:      trade.sl,   // original SL for reference
      originalLots:    trade.lots, // original full lot size
      slDist,                      // price distance of original SL
      partialDone:  false,         // scale-out (half close at 1R) done?
      beTriggered:  false,         // SL moved to break-even?
      slEvents:     [],            // [{type, fromSl, toSl, atPrice, atTs}]
      partialEvents: []            // [{exitPrice, exitTs, pips, lots}]
    });
    return id;
  }

  onTick(instrumentId, price, tsMs) {
    for (const t of this.trades) {
      if (!t.open || t.instrumentId !== instrumentId) continue;

      // ── 1R scale-out: close half at entry ± slDist (1:1 RR point) ─────────
      if (!t.partialDone) {
        const target1R =
          t.direction === 'buy'
            ? t.entry + t.slDist
            : t.entry - t.slDist;

        const reached1R =
          t.direction === 'buy' ? price >= target1R : price <= target1R;

        if (reached1R) {
          t.partialDone = true;
          const halfLots = Math.max(0.01, Math.round((t.lots / 2) * 100) / 100);
          t.lots = t.lots - halfLots; // remaining lots continue to full TP

          const partialPips = this._pips(t.direction, t.entry, price, t.pipSize);
          const partialEvent = { exitPrice: price, exitTs: tsMs, pips: partialPips, lots: halfLots };
          t.partialEvents.push(partialEvent);

          console.log(
            `[TradeMonitor] Partial close (1R): ${t.instrumentId} ${t.cause}` +
            ` closed ${halfLots} lots @ ${price} (${partialPips.toFixed(1)} pips)` +
            ` remaining ${t.lots} lots`
          );

          // Persist partial close to dashboard
          postPartialClose({
            instrumentId: t.instrumentId,
            strategy:     t.cause,
            entryTs:      t.entryTs,
            exitPrice:    price,
            exitTs:       tsMs,
            partialPips,
            partialLots:  halfLots,
            remainingLots: t.lots,
            slEvents:     t.slEvents
          }).catch(e => console.error('[monitor] partial_close error:', e?.message));

          // Also notify via email
          this.notifier?.sendSignal({
            type:         'result',
            instrumentId: t.instrumentId,
            direction:    t.direction,
            variant:      `${t.variantLabel || 'FixedPips'} [Partial 1R]`,
            outcome:      'partial',
            entry:        t.entry,
            exit:         price,
            pips:         partialPips,
            decimals:     t.decimals,
            tsMs:         tsMs,
            entryTs:      t.entryTs,
            sessions:     t.sessions,
            lots:         halfLots,
            meta: { cause: t.cause, models: t.models, score: t.score }
          }).catch(e => console.error('[mail] partial send error:', e?.message));
        }
      }

      // ── Move SL to break-even after partial close ──────────────────────────
      if (t.partialDone && !t.beTriggered) {
        t.beTriggered = true;
        const fromSl = t.sl;
        t.sl = t.entry; // move SL to entry

        const event = { type: 'break_even', fromSl, toSl: t.entry, atPrice: price, atTs: tsMs };
        t.slEvents.push(event);

        postSlUpdate({
          instrumentId: t.instrumentId,
          strategy:     t.cause,
          entryTs:      t.entryTs,
          newSl:        t.entry,
          slEvents:     t.slEvents
        }).catch(e => console.error('[monitor] SL update error:', e?.message));

        console.log(`[TradeMonitor] BE move after partial: ${t.instrumentId} ${t.cause} SL ${fromSl} → ${t.entry}`);
      }

      // ── Full close: SL or TP hit on remaining lots ─────────────────────────
      if (t.direction === 'buy') {
        if (price <= t.sl) { this._close(t, t.beTriggered ? 'be' : 'loss', price, tsMs); continue; }
        if (price >= t.tp) { this._close(t, 'profit', price, tsMs); continue; }
      } else {
        if (price >= t.sl) { this._close(t, t.beTriggered ? 'be' : 'loss', price, tsMs); continue; }
        if (price <= t.tp) { this._close(t, 'profit', price, tsMs); continue; }
      }
    }
    this.trades = this.trades.filter(t => t.open);
  }

  async _close(t, outcome, exitPx, exitTs) {
    t.open = false;
    const pips = this._pips(t.direction, t.entry, exitPx, t.pipSize);

    // outcome: 'profit' | 'loss' | 'be'
    this.notifier?.sendSignal({
      type:         'result',
      instrumentId: t.instrumentId,
      direction:    t.direction,
      variant:      t.variantLabel || 'FixedPips',
      outcome,
      entry:        t.entry,
      exit:         exitPx,
      pips,
      decimals:     t.decimals,
      tsMs:         exitTs,
      entryTs:      t.entryTs,
      sessions:     t.sessions,
      lots:         t.lots,
      meta: { cause: t.cause, models: t.models, score: t.score }
    }).catch(e => console.error('[mail] send error:', e?.message || e));

    await postResult({
      instrumentId:  t.instrumentId,
      strategy:      t.cause,
      entryTs:       t.entryTs,
      direction:     t.direction,
      exit:          exitPx,
      exitTs,
      outcome,
      pips,
      variant:       t.variantLabel || 'FixedPips',
      lots:          t.lots,
      partialEvents: t.partialEvents,
      slEvents:      t.slEvents
    });
  }

  _pips(direction, entry, exit, pipSize) {
    const diff = direction === 'buy' ? (exit - entry) : (entry - exit);
    return diff / pipSize;
  }
}
