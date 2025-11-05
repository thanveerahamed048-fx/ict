// src/index.js (FX only + XAUUSD, direct vars, mailer + trade monitor)
// Requires: npm i ws luxon nodemailer

import { FX_INSTRUMENTS } from './src/config/instruments.js';
import { FinnhubWS } from './src/feeds/finnhub.js';
import { CandleAggregator } from './src/core/candleAggregator.js';
import { ModelBus } from './src/core/modelBus.js';
import { fmtPx } from './src/utils/format.js';
import { Mailer } from './src/notify/mailer.js';
import { TradeMonitor } from './src/monitor/tradeMonitor.js';
import { DateTime } from 'luxon';
import { loadAsiaSnapshot } from './src/utils/persist.js';
import { nowNY, nyDayKey } from './src/utils/time.js';
import dotenv from "dotenv";
dotenv.config();
// ===================== DIRECT CONFIG (edit me) =====================
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

console.log(FINNHUB_API_KEY);

// Email settings (use an App Password if Gmail/Outlook)
const MAIL_ENABLED = true; // set false to disable emails
const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465;         // 465 = SSL, 587 = STARTTLS
const SMTP_SECURE = true;      // true for 465, false for 587
const SMTP_USER = '123ninjaboy456@gmail.com';
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = 'Forex Signals <thanveerahamed048@gmail.com>';
const MAIL_TO = ['thanveerahamed048@gmail.com','bhuvaneshkumar234123@gmail.com']; // list of recipients
const MAIL_THROTTLE_MS = 60_000;    // min interval per instrument+signal



// Only Gold (XAUUSD via OANDA feed on Finnhub)
const XAUUSD = {
  id: 'XAUUSD',
  feed: 'finnhub',
  feedSymbol: 'OANDA:XAU_USD',
  pipSize: 0.1, // 1 pip = 0.1 in price
  decimals: 2
};
const INSTRUMENTS = [XAUUSD ,...FX_INSTRUMENTS];
// ==================================================================

if (!FINNHUB_API_KEY || FINNHUB_API_KEY.includes('PASTE')) {
  console.warn('Set FINNHUB_API_KEY at the top of index.js to stream FX.');
}

console.log('Starting multi-model live engine (FX only, includes XAUUSD)...');

// Mailer
const mailer = new Mailer({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  user: SMTP_USER,
  pass: SMTP_PASS,
  from: MAIL_FROM,
  to: MAIL_TO,
  enabled: MAIL_ENABLED,
  throttleMs: MAIL_THROTTLE_MS
});

// Instrument map for monitor
const instrumentMap = new Map(INSTRUMENTS.map(i => [i.id, i]));

// Monitor (sends "result" emails when TP/SL hit)
const monitor = new TradeMonitor({ notifier: mailer, instrumentMap });

const aggById = new Map();
const busById = new Map();

// Helper: seed aggregator from saved Asia snapshot
function seedAggregatorFromSnapshot(aggregator, snap) {
  // Prefer dedicated method if your CandleAggregator has it
  if (typeof aggregator.seedSession === 'function') {
    aggregator.seedSession({
      dayKey: snap.dayKey,
      dailyOpen: snap.dailyOpen,
      asiaHi: snap.asiaHi,
      asiaLo: snap.asiaLo,
      asiaDone: true,
      prevDayHigh: snap.prevDayHigh,
      prevDayLow: snap.prevDayLow
    });
  } else {
    // Fallback: assign fields directly
    aggregator.dayKey = snap.dayKey;
    aggregator.dailyOpen = snap.dailyOpen;
    aggregator.asiaHi = snap.asiaHi;
    aggregator.asiaLo = snap.asiaLo;
    aggregator.asiaDone = true;
    aggregator.prevDayHigh = snap.prevDayHigh ?? null;
    aggregator.prevDayLow = snap.prevDayLow ?? null;
  }
}

(async function main() {
  // Init aggregator + model bus for each instrument (Gold only here)
  for (const inst of INSTRUMENTS) {
    const aggregator = new CandleAggregator({
      instrument: inst,
      onM1: (c) => busById.get(inst.id)?.onM1Close(c),
      onM5: () => {}
    });
    aggById.set(inst.id, aggregator);

    const bus = new ModelBus({
      instrument: inst,
      aggregator,
      notifier: mailer, // emails only for strategy_entry (PO3/FVGC/BREAKER/JUDAS) per your ModelBus
      monitor,          // hands trades to monitor so results are emailed
      log: (line) => console.log(`[${nowNY().toFormat('yyyy-LL-dd HH:mm:ss')} NY] ${line}`)
    });
    busById.set(inst.id, bus);

    // Load today's Asia snapshot (if previously saved) so Asia isn't n/a after 05:00 NY
    const todayKey = nyDayKey(nowNY());
    const snap = await loadAsiaSnapshot(inst.id, todayKey);
    if (snap && snap.asiaDone && snap.asiaHi != null && snap.asiaLo != null) {
      seedAggregatorFromSnapshot(aggregator, snap);
      console.log(
        `[${nowNY().toFormat('yyyy-LL-dd HH:mm:ss')} NY] ${inst.id} | Loaded Asia snapshot: `
        + `DO=${fmtPx(snap.dailyOpen, inst.decimals)} `
        + `Asia=[${fmtPx(snap.asiaLo, inst.decimals)}-${fmtPx(snap.asiaHi, inst.decimals)}]`
      );
    }
  }

  // Connect Finnhub WS (FX only)
  if (FINNHUB_API_KEY && !FINNHUB_API_KEY.includes('PASTE')) {
    const finnhub = new FinnhubWS({
      apiKey: FINNHUB_API_KEY,
      symbols: INSTRUMENTS.map(i => i.feedSymbol), // OANDA:XAU_USD
      onTick: (feedSymbol, price, tsMs) => {
        const inst = INSTRUMENTS.find(i => i.feedSymbol === feedSymbol);
        if (!inst) return;
        // Route ticks: aggregator -> model bus -> monitor
        aggById.get(inst.id)?.ingestTick(price, tsMs);
        busById.get(inst.id)?.onTick(price, tsMs);
        monitor.onTick(inst.id, price, tsMs);
      }
    });
  }

  // Periodic status line (no pattern logs)
  setInterval(() => {
    for (const inst of INSTRUMENTS) {
      const agg = aggById.get(inst.id);
      const sessions = agg.getSessions();
      const lastM1 = agg.getM1().at(-1);
      if (!lastM1) continue;
      console.log(
        `${inst.id} px=${fmtPx(lastM1.close, inst.decimals)} `
        + `DO=${fmtPx(sessions.dailyOpen, inst.decimals)} `
        + `Asia=[${fmtPx(sessions.asiaLo, inst.decimals)}-${fmtPx(sessions.asiaHi, inst.decimals)}]`
      );
    }
  }, 60_000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    process.exit(0);
  });
})();