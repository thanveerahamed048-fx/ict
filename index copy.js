// src/index.js (FX only + XAUUSD, direct config vars, email alerts)
// Requires: npm i ws luxon nodemailer
// Also requires: src/notify/mailer.js (Mailer class), src/core/modelBus.js with notifier support

import { FX_INSTRUMENTS } from './src/config/instruments.js';
import { FinnhubWS } from './src/feeds/finnhub.js';
import { CandleAggregator } from './src/core/candleAggregator.js';
import { ModelBus } from './src/core/modelBus.js';
import { nowNY } from './src/utils/time.js';
import { fmtPx } from './src/utils/format.js';
import { Mailer } from './src/notify/mailer.js';

// ===================== DIRECT CONFIG (edit me) =====================
// Finnhub API (for FX WebSocket)
const FINNHUB_API_KEY = 'd3s8dshr01qs1aprkmigd3s8dshr01qs1aprkmj0';

// Email settings (use an App Password if Gmail/Outlook)
const MAIL_ENABLED = true; // set false to disable emails
const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465;         // 465 = SSL, 587 = STARTTLS
const SMTP_SECURE = true;      // true for 465, false for 587
const SMTP_USER = '123ninjaboy456@gmail.com';
const SMTP_PASS = 'gvmd euwp agco fhfo';
const MAIL_FROM = 'PO3 Signals <thanveerahamed048@gmail.com>';
const MAIL_TO = ['thanveerahamed048@gmail.com']; // list of recipients
const MAIL_THROTTLE_MS = 60_000;    // min interval per instrument+signal

// Add XAUUSD (Gold) via Finnhub/OANDA
const XAUUSD = {
  id: 'XAUUSD',
  feed: 'finnhub',
  feedSymbol: 'OANDA:XAU_USD',
  pipSize: 0.1,  // ~0.1 "pip" (adjust if you prefer)
  decimals: 2
};
// ==================================================================

const INSTRUMENTS = [...FX_INSTRUMENTS, XAUUSD];

if (!FINNHUB_API_KEY || FINNHUB_API_KEY.includes('PASTE')) {
  console.warn('Set FINNHUB_API_KEY at the top of index.js to stream FX.');
}

console.log('Starting multi-model live engine (FX only, includes XAUUSD)...');

// Create mailer using direct config vars
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

const aggById = new Map();
const busById = new Map();

// Init aggregators and model buses per instrument
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
    notifier: mailer, // emails on confluence signals and PO3 entries
    log: (line) => console.log(`[${nowNY().toFormat('yyyy-LL-dd HH:mm:ss')} NY] ${line}`)
  });
  busById.set(inst.id, bus);
}

// Connect FX via Finnhub WS only
if (FINNHUB_API_KEY && !FINNHUB_API_KEY.includes('PASTE')) {
  const finnhub = new FinnhubWS({
    apiKey: FINNHUB_API_KEY,
    symbols: INSTRUMENTS.map(i => i.feedSymbol), // e.g., OANDA:EUR_USD, OANDA:XAU_USD
    onTick: (feedSymbol, price, tsMs) => {
      const inst = INSTRUMENTS.find(i => i.feedSymbol === feedSymbol);
      if (!inst) return;
      aggById.get(inst.id)?.ingestTick(price, tsMs);
      busById.get(inst.id)?.onTick(price, tsMs);
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