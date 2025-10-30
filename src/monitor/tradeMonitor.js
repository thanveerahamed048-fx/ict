// src/monitor/tradeMonitor.js
import { postResult } from '../notify/dashboardClient.js';

export class TradeMonitor {
  constructor({ notifier, instrumentMap }) {
    this.notifier = notifier;
    this.instrumentMap = instrumentMap;
    this.trades = [];
  }

  addTrade(trade) {
    const id = `${trade.instrumentId}-${trade.cause}-${trade.entryTs}`;
    const pipSize = trade.pipSize ?? this.instrumentMap.get(trade.instrumentId)?.pipSize ?? 0.0001;
    const decimals = trade.decimals ?? this.instrumentMap.get(trade.instrumentId)?.decimals ?? 5;
    this.trades.push({ id, ...trade, pipSize, decimals, open: true });
    return id;
  }

  onTick(instrumentId, price, tsMs) {
    for (const t of this.trades) {
      if (!t.open || t.instrumentId !== instrumentId) continue;

      if (t.direction === 'buy') {
        if (price <= t.sl) { this._close(t, 'loss', price, tsMs); continue; }
        if (price >= t.tp) { this._close(t, 'profit', price, tsMs); continue; }
      } else {
        if (price >= t.sl) { this._close(t, 'loss', price, tsMs); continue; }
        if (price <= t.tp) { this._close(t, 'profit', price, tsMs); continue; }
      }
    }
    this.trades = this.trades.filter(t => t.open);
  }

  async _close(t, outcome, exitPx, exitTs) {
    t.open = false;
    const pips = this._pips(t.direction, t.entry, exitPx, t.pipSize);

    this.notifier?.sendSignal({
      type: 'result',
      instrumentId: t.instrumentId,
      direction: t.direction,
      variant: t.variantLabel || 'FixedPips',
      outcome,
      entry: t.entry,
      exit: exitPx,
      pips,
      decimals: t.decimals,
      tsMs: exitTs,
      entryTs: t.entryTs,
      sessions: t.sessions,
      meta: { cause: t.cause, models: t.models, score: t.score }
    }).catch(() => {});

    // Post to dashboard (await for better error surfacing)
    await postResult({
      instrumentId: t.instrumentId,
      strategy: t.cause,
      entryTs: t.entryTs,
      direction: t.direction,
      exit: exitPx,
      exitTs,
      outcome,
      pips,
      variant: t.variantLabel || 'FixedPips'
    });
  }

  _pips(direction, entry, exit, pipSize) {
    const diff = direction === 'buy' ? (exit - entry) : (entry - exit);
    return diff / pipSize;
  }
}