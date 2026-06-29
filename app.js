// app.js — Monolith: Dashboard API + Bot + Web (ESM, Node 18+)
// Run: node app.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import { DateTime } from 'luxon';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'node:net';
// Bot pieces
import { FinnhubWS } from './src/feeds/finnhub.js';
import { BinanceWS } from './src/feeds/binance.js';
import { CandleAggregator } from './src/core/candleAggregator.js';
import { ModelBus } from './src/core/modelBus.js';
import { TradeMonitor } from './src/monitor/tradeMonitor.js';
import { Mailer } from './src/notify/mailer.js';
import { nowNY, nyDayKey } from './src/utils/time.js';
import { fmtPx } from './src/utils/format.js';
import { loadAsiaSnapshot } from './src/utils/persist.js';
import { INSTRUMENTS, CRYPTO_INSTRUMENTS } from './src/config/instruments.js';
import { PropFirmManager } from './src/core/propFirmManager.js';

// ====== ENV ======
const HTTP_PORT = Number(process.env.PORT || process.env.HTTP_PORT || 8080);
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'trade_dashboard';
const TRADES_COLL = process.env.TRADES_COLL || 'trades';

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// ====== STRATEGY TOGGLE ======
// Comma-separated list of strategy names to enable.
// If not set, ALL strategies are enabled.
// Example: ENABLED_STRATEGIES=PO3,ORB,CandleRange
const ENABLED_STRATEGIES = process.env.ENABLED_STRATEGIES
  ? new Set(process.env.ENABLED_STRATEGIES.split(',').map(s => s.trim()).filter(Boolean))
  : null; // null = all enabled
if (ENABLED_STRATEGIES) {
  console.log(`[config] ENABLED_STRATEGIES: ${[...ENABLED_STRATEGIES].join(', ')}`);
}

// ====== EMAIL CONFIG — all values from .env ======
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_ENABLED = process.env.MAIL_ENABLED === '1';
const SMTP_HOST    = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT    = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE  = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === '1' : SMTP_PORT === 465;
const SMTP_USER    = process.env.SMTP_USER || '';
const MAIL_FROM    = process.env.MAIL_FROM || `Forex Signals <${SMTP_USER}>`;
const MAIL_TO      = process.env.MAIL_TO   || '';
const MAIL_THROTTLE_MS = Number(process.env.MAIL_THROTTLE_MS || 60_000);

console.log(`[config] SMTP_USER=${SMTP_USER} PASS=${SMTP_PASS ? 'SET' : 'UNSET'} PORT=${SMTP_PORT} SECURE=${SMTP_SECURE} MAIL_ENABLED=${MAIL_ENABLED}`);

// Live feed tracker
const live = {
  ws: { connected: false, lastOpenAt: 0, lastMsgAt: 0 },
  ticks: new Map() // instrumentId -> { price, tsMs }
};

function updateTick(instId, price, tsMs) {
  live.ticks.set(instId, { price, tsMs });
  live.ws.lastMsgAt = Date.now();
}

// ====== SERVER (Express + Mongo) ======
const NY_ZONE = 'America/New_York';
const fmtNY = (ms) => DateTime.fromMillis(ms, { zone: NY_ZONE }).toFormat('yyyy-LL-dd HH:mm:ss');
const dateNY = (ms) => DateTime.fromMillis(ms, { zone: NY_ZONE }).toFormat('yyyy-LL-dd');
const sessionLabel = (ms) => {
  const dt = DateTime.fromMillis(ms, { zone: NY_ZONE });
  const hr = dt.hour + dt.minute / 60;
  if (hr >= 2 && hr < 5) return 'London KZ';
  if (hr >= 8.5 && hr < 11) return 'NY KZ';
  if (hr >= 0 && hr < 2) return 'Asia';
  if (hr >= 5 && hr < 8.5) return 'Pre-NY';
  if (hr >= 11 && hr < 17) return 'NY';
  return 'After-hours';
};

const client = new MongoClient(MONGO_URI);
await client.connect();
const db = client.db(DB_NAME);
const trades = db.collection(TRADES_COLL);

// Prop firm manager setup
const propFirmManager = new PropFirmManager({ db });
await propFirmManager.init();

// Indexes
await trades.createIndex({ entryTs: -1 });
await trades.createIndex({ entryDateNY: 1 });
await trades.createIndex({ status: 1, instrumentId: 1 });
await trades.createIndex({ instrumentId: 1, strategy: 1, entryTs: -1 });

// Express
const app = express();
app.use(cors());
app.use(express.json({ limit: '300kb' }));

// Static web (serve ./web)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'web')));


app.get('/api/ticks', (_req, res) => {
  const now = Date.now();
  const items = INSTRUMENTS.map(inst => {
    const t = live.ticks.get(inst.id);
    return {
      instrumentId: inst.id,
      price: t ? Number(t.price.toFixed(inst.decimals)) : null,
      decimals: inst.decimals,
      tsMs: t ? t.tsMs : null,
      ageSec: t ? Math.round((now - t.tsMs) / 1000) : null,
      isCrypto: inst.isCrypto || false
    };
  });
  res.json({ items, wsConnected: live.ws.connected });
});

app.get('/health', async (_req, res) => {
  try {
    const open = await trades.countDocuments({ status: 'open' });
    const now = Date.now();
    const lastMsgAgeSec = live.ws.lastMsgAt ? Math.round((now - live.ws.lastMsgAt) / 1000) : null;
    res.json({
      ok: true,
      open,
      ws: { connected: live.ws.connected, lastMsgAgeSec }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/debug/ticks', (_req, res) => {
  const now = Date.now();
  const items = INSTRUMENTS.map(inst => {
    const t = live.ticks.get(inst.id);
    return t
      ? {
        instrumentId: inst.id,
        price: Number(t.price.toFixed(inst.decimals)),
        tsMs: t.tsMs,
        ageSec: Math.round((now - t.tsMs) / 1000)
      }
      : { instrumentId: inst.id, price: null, tsMs: null, ageSec: null };
  });
  res.json({
    ws: { connected: live.ws.connected, lastMsgAt: live.ws.lastMsgAt || null },
    items
  });
});

// Create/Upsert trade on strategy entry
app.post('/_internal/strategy_entry', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.instrumentId || !b.strategy || !b.direction || !b.entryTs || b.entry == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const tradeId = `${b.instrumentId}-${b.strategy}-${b.entryTs}`;
    const entryTsMs = Number(b.entryTs);
    const nowMs = Date.now();
    const entryDateNY = dateNY(entryTsMs);

    // Double check single entry cap per strategy per day
    const existing = await trades.findOne({
      instrumentId: b.instrumentId,
      strategy: b.strategy,
      entryDateNY: entryDateNY
    });
    if (existing) {
      return res.status(400).json({ error: `Already have an entry for strategy ${b.strategy} today.` });
    }

    const lots = b.lots != null ? Number(b.lots) : 2.0;

    // Validate and record with prop firm manager
    try {
      await propFirmManager.onTradeOpen({
        instrumentId: b.instrumentId,
        strategy: b.strategy,
        direction: b.direction,
        entryPrice: Number(b.entry),
        entryTs: entryTsMs,
        slPips: b.slPips,
        lots
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const baseDoc = {
      _id: tradeId,
      instrumentId: b.instrumentId,
      strategy: b.strategy,
      direction: b.direction,
      entryTs: entryTsMs,
      entryTsNY: fmtNY(entryTsMs),
      entryDateNY: entryDateNY,
      entryPrice: Number(b.entry),
      slPrice: b.sl != null ? Number(b.sl) : null,
      tpPrice: b.tp != null ? Number(b.tp) : null,
      slPips: b.slPips != null ? Number(b.slPips) : null,
      tpPips: b.tpPips != null ? Number(b.tpPips) : null,
      pipSize: b.pipSize != null ? Number(b.pipSize) : null,
      decimals: b.decimals != null ? Number(b.decimals) : 5,
      variantLabel: b.variantLabel || null,
      status: 'open',
      lots,
      exitTs: null,
      exitTsNY: null,
      exitPrice: null,
      exitReason: null,
      resultPips: null,
      pnl: null,
      timeToCloseMin: null,
      session: sessionLabel(entryTsMs),
      context: {
        dailyOpen: b.sessions?.dailyOpen ?? null,
        asiaLo: b.sessions?.asiaLo ?? null,
        asiaHi: b.sessions?.asiaHi ?? null,
        prevDayHigh: b.sessions?.prevDayHigh ?? null,
        prevDayLow: b.sessions?.prevDayLow ?? null,
        prevDayOpen: b.sessions?.prevDayOpen ?? null,
        prevDayClose: b.sessions?.prevDayClose ?? null
      },
      models: Array.isArray(b.models) ? b.models : (b.models ? [b.models] : []),
      score: b.score ?? null,
      createdAt: nowMs
    };

    await trades.updateOne(
      { _id: tradeId },
      { $setOnInsert: baseDoc, $set: { updatedAt: nowMs } },
      { upsert: true }
    );

    res.status(201).json({ ok: true, tradeId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Close trade on result
app.post('/_internal/result', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.instrumentId || !b.strategy || !b.entryTs || !b.exitTs || b.exit == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const tradeId = `${b.instrumentId}-${b.strategy}-${b.entryTs}`;
    const exitTsMs = Number(b.exitTs);

    const doc = await trades.findOne({ _id: tradeId });
    if (!doc) return res.status(404).json({ error: 'Trade not found' });

    const resultPips = b.pips != null ? Number(b.pips) : null;
    const exitReason = b.outcome === 'profit' ? 'tp' : b.outcome === 'be' ? 'be' : b.outcome === 'loss' ? 'sl' : 'manual';
    const timeToCloseMin = Math.max(0, Math.round((exitTsMs - (doc.entryTs || exitTsMs)) / 60000));

    const tradeLots = doc.lots != null ? Number(doc.lots) : 2.0;
    const pnl = resultPips != null ? resultPips * tradeLots * 10 : 0;

    // Update with prop firm manager
    if (resultPips != null) {
      await propFirmManager.onTradeClose(tradeId, exitReason, resultPips, tradeLots);
    }

    await trades.updateOne(
      { _id: tradeId },
      {
        $set: {
          status: 'closed',
          exitTs: exitTsMs,
          exitTsNY: fmtNY(exitTsMs),
          exitPrice: Number(b.exit),
          exitReason,
          resultPips,
          pnl,
          timeToCloseMin,
          updatedAt: Date.now(),
          variantLabel: b.variant || doc.variantLabel || null,
          // Preserve final SL event log if provided
          ...(Array.isArray(b.slEvents) && b.slEvents.length > 0 ? { slEvents: b.slEvents } : {}),
          // Preserve partial close history if provided
          ...(Array.isArray(b.partialEvents) && b.partialEvents.length > 0 ? { partialEvents: b.partialEvents } : {})
        }
      }
    );

    res.json({ ok: true, tradeId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Partial close (scale-out at 1R)
app.post('/_internal/partial_close', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.instrumentId || !b.strategy || !b.entryTs || b.exitPrice == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const tradeId = `${b.instrumentId}-${b.strategy}-${b.entryTs}`;

    await trades.updateOne(
      { _id: tradeId },
      {
        $set: {
          // Reflect reduced lot size on the document
          ...(b.remainingLots != null ? { lots: Number(b.remainingLots) } : {}),
          slEvents:      Array.isArray(b.slEvents) ? b.slEvents : [],
          updatedAt:     Date.now()
        },
        $push: {
          partialEvents: {
            exitPrice:   Number(b.exitPrice),
            exitTs:      Number(b.exitTs),
            pips:        b.partialPips != null ? Number(b.partialPips) : null,
            lots:        b.partialLots != null ? Number(b.partialLots) : null
          }
        }
      }
    );

    res.json({ ok: true, tradeId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// SL move update (e.g. break-even)
app.post('/_internal/sl_update', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.instrumentId || !b.strategy || !b.entryTs || b.newSl == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const tradeId = `${b.instrumentId}-${b.strategy}-${b.entryTs}`;

    await trades.updateOne(
      { _id: tradeId },
      {
        $set: {
          slPrice: Number(b.newSl),
          slEvents: Array.isArray(b.slEvents) ? b.slEvents : [],
          updatedAt: Date.now()
        }
      }
    );

    res.json({ ok: true, tradeId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Prop Firm API endpoints
app.get('/api/prop-firm/account', async (_req, res) => {
  try {
    const acc = propFirmManager.getAccount();
    res.json(acc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/prop-firm/reset', async (req, res) => {
  try {
    const { firm, initialBalance, riskType, riskPercent, fixedLots, phase } = req.body || {};
    await propFirmManager.resetAccount(firm, initialBalance, riskType, riskPercent, fixedLots, phase);
    res.json({ ok: true, account: propFirmManager.getAccount() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/prop-firm/payout', async (_req, res) => {
  try {
    const payoutRecord = await propFirmManager.requestPayout();
    res.json({ ok: true, payout: payoutRecord, account: propFirmManager.getAccount() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Summary
app.get('/stats/summary', async (_req, res) => {
  try {
    const totalsAgg = await trades.aggregate([
      {
        $facet: {
          counts: [
            {
              $group: {
                _id: null,
                signals: { $sum: 1 },
                open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
                closed: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } },
                wins: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $gt: ['$resultPips', 0] }] }, 1, 0] } },
                losses: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $lte: ['$resultPips', 0] }] }, 1, 0] } },
                netPips: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, '$resultPips', 0] } },
                sumPips: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, '$resultPips', 0] } },
                cntClosed: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } }
              }
            },
            {
              $project: {
                _id: 0,
                signals: 1, open: 1, closed: 1, wins: 1, losses: 1, netPips: 1,
                winRate: { $cond: [{ $gt: [{ $add: ['$wins', '$losses'] }, 0] }, { $divide: ['$wins', { $add: ['$wins', '$losses'] }] }, 0] },
                avgPips: { $cond: [{ $gt: ['$cntClosed', 0] }, { $divide: ['$sumPips', '$cntClosed'] }, 0] }
              }
            }
          ],
          byStrategy: [
            {
              $group: {
                _id: '$strategy',
                signals: { $sum: 1 },
                wins: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $gt: ['$resultPips', 0] }] }, 1, 0] } },
                losses: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $lte: ['$resultPips', 0] }] }, 1, 0] } },
                netPips: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, '$resultPips', 0] } }
              }
            },
            {
              $project: {
                _id: 0, strategy: '$_id', signals: 1, wins: 1, losses: 1, netPips: 1,
                winRate: { $cond: [{ $gt: [{ $add: ['$wins', '$losses'] }, 0] }, { $divide: ['$wins', { $add: ['$wins', '$losses'] }] }, 0] }
              }
            },
            { $sort: { netPips: -1 } }
          ],
          byInstrument: [
            {
              $group: {
                _id: '$instrumentId',
                signals: { $sum: 1 },
                wins: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $gt: ['$resultPips', 0] }] }, 1, 0] } },
                losses: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $lte: ['$resultPips', 0] }] }, 1, 0] } },
                netPips: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, '$resultPips', 0] } }
              }
            },
            {
              $project: {
                _id: 0, instrumentId: '$_id', signals: 1, wins: 1, losses: 1, netPips: 1,
                winRate: { $cond: [{ $gt: [{ $add: ['$wins', '$losses'] }, 0] }, { $divide: ['$wins', { $add: ['$wins', '$losses'] }] }, 0] }
              }
            },
            { $sort: { instrumentId: 1 } }
          ]
        }
      },
      { $project: { totals: { $arrayElemAt: ['$counts', 0] }, byStrategy: 1, byInstrument: 1 } }
    ]).toArray();

    res.json(totalsAgg[0] || { totals: {}, byStrategy: [], byInstrument: [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Daily
app.get('/stats/daily', async (req, res) => {
  try {
    const { start, end } = req.query;
    const match = {};
    if (start) match.entryDateNY = { ...match.entryDateNY, $gte: start };
    if (end) match.entryDateNY = { ...match.entryDateNY, $lte: end };

    const rows = await trades.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$entryDateNY',
          signals: { $sum: 1 },
          wins: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $gt: ['$resultPips', 0] }] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $lte: ['$resultPips', 0] }] }, 1, 0] } },
          netPips: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, '$resultPips', 0] } }
        }
      },
      {
        $project: {
          _id: 0, dateNY: '$_id', signals: 1, wins: 1, losses: 1, netPips: 1,
          winRate: { $cond: [{ $gt: [{ $add: ['$wins', '$losses'] }, 0] }, { $divide: ['$wins', { $add: ['$wins', '$losses'] }] }, 0] }
        }
      },
      { $sort: { dateNY: 1 } }
    ]).toArray();

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trades list
app.get('/trades', async (req, res) => {
  try {
    const { instrumentId, strategy, status, date, limit = 50 } = req.query;
    const q = {};
    if (instrumentId) q.instrumentId = instrumentId;
    if (strategy) q.strategy = strategy;
    if (status) q.status = status;
    if (date) q.entryDateNY = date;

    const docs = await trades.find(q).sort({ entryTs: -1 }).limit(Number(limit)).toArray();
    res.json({ items: docs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/debug/send-email', async (_req, res) => {
  try {
    await mailer.sendSignal({
      type: 'strategy_entry',
      strategy: 'TEST',
      instrumentId: 'PING',
      decimals: 2,
      direction: 'buy',
      entry: 123.45,
      sl: 122.45,
      tp: 124.45,
      slPips: 100,
      tpPips: 100,
      sessions: {},
      tsMs: Date.now()
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/debug/send-daily-summary', async (_req, res) => {
  try {
    const todayNY = DateTime.now().setZone('America/New_York');
    const dateStr = todayNY.toFormat('yyyy-LL-dd');
    const todayTrades = await trades.find({ entryDateNY: dateStr }).toArray();
    const account = propFirmManager.getAccount();
    await mailer.sendDailySummary({ dateNY: dateStr, trades: todayTrades, account });
    res.json({ ok: true, dateNY: dateStr, tradeCount: todayTrades.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get('/debug/smtp-check', async (req, res) => {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 465);
  const start = Date.now();
  const sock = net.connect({ host, port });
  let done = false;

  const finish = (ok, err) => {
    if (done) return;
    done = true;
    try { sock.destroy(); } catch { }
    res.json({ ok, ms: Date.now() - start, host, port, err: err?.message });
  };

  sock.on('connect', () => finish(true, null));
  sock.on('error', (e) => finish(false, e));
  sock.setTimeout(8000, () => finish(false, new Error('timeout')));
});

// Trade detail
app.get('/trades/:id', async (req, res) => {
  try {
    const doc = await trades.findOne({ _id: req.params.id });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== MAILER ======
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

// mailer.verify().catch((e) => {
//   // keep running, but surface why SMTP fails
//   console.error('[mailer] verify error:', e?.message || e);
// });
// ====== BOT (WS, strategies) ======
const instrumentMap = new Map(INSTRUMENTS.map(i => [i.id, i]));
const monitor = new TradeMonitor({ notifier: mailer, instrumentMap });
const aggById = new Map();
const busById = new Map();

function seedAggregatorFromSnapshot(aggregator, snap) {
  if (typeof aggregator.seedSession === 'function') {
    aggregator.seedSession({
      dayKey: snap.dayKey,
      dailyOpen: snap.dailyOpen,
      asiaHi: snap.asiaHi,
      asiaLo: snap.asiaLo,
      asiaDone: true,
      prevDayHigh: snap.prevDayHigh,
      prevDayLow: snap.prevDayLow,
      prevDayOpen: snap.prevDayOpen ?? null,
      prevDayClose: snap.prevDayClose ?? null
    });
  }
}

async function startBot() {
  for (const inst of INSTRUMENTS) {
    const aggregator = new CandleAggregator({
      instrument: inst,
      onM1: (c) => busById.get(inst.id)?.onM1Close(c),
      onM5: () => { }
    });
    aggById.set(inst.id, aggregator);

    const bus = new ModelBus({
      instrument: inst,
      aggregator,
      notifier: mailer,
      monitor,
      propFirmManager,
      tradesCollection: trades,
      enabledStrategies: ENABLED_STRATEGIES,
      log: (line) => console.log(`[${nowNY().toFormat('yyyy-LL-dd HH:mm:ss')} NY] ${line}`)
    });
    // Await the DB query that re-populates enteredStrategiesToday before ticks arrive
    await bus.initEnteredStrategies();
    busById.set(inst.id, bus);

    const todayKey = nyDayKey(nowNY());
    const snap = await loadAsiaSnapshot(inst.id, todayKey);
    if (snap && snap.asiaDone && snap.asiaHi != null && snap.asiaLo != null) {
      seedAggregatorFromSnapshot(aggregator, snap);
      console.log(`[${nowNY().toFormat('yyyy-LL-dd HH:mm:ss')} NY] ${inst.id} | Loaded Asia snapshot: DO=${fmtPx(snap.dailyOpen, inst.decimals)} Asia=[${fmtPx(snap.asiaLo, inst.decimals)}-${fmtPx(snap.asiaHi, inst.decimals)}]`);
    }
  }

  if (!FINNHUB_API_KEY) {
    console.warn('FINNHUB_API_KEY missing; bot will not connect to FX feed.');
    return;
  }

  new FinnhubWS({
    apiKey: FINNHUB_API_KEY,
    symbols: INSTRUMENTS.filter(i => i.feed === 'finnhub').map(i => i.feedSymbol),
    onOpen: () => { live.ws.connected = true; live.ws.lastOpenAt = Date.now(); },
    onClose: () => { live.ws.connected = false; },
    onTick: (feedSymbol, price, tsMs) => {
      const inst = INSTRUMENTS.find(i => i.feedSymbol === feedSymbol);
      if (!inst) return;
      updateTick(inst.id, price, tsMs);
      aggById.get(inst.id)?.ingestTick(price, tsMs);
      busById.get(inst.id)?.onTick(price, tsMs);
      monitor.onTick(inst.id, price, tsMs);

      const priceMap = new Map();
      for (const [id, tick] of live.ticks.entries()) {
        priceMap.set(id, tick.price);
      }
      propFirmManager.onTick(priceMap, monitor.trades).catch(err => {
        console.error('[PropFirmManager] Tick update error:', err);
      });
    }
  });

  // ── Binance feed (crypto) ────────────────────────────────────────────────
  if (CRYPTO_INSTRUMENTS.length > 0) {
    new BinanceWS({
      symbols: CRYPTO_INSTRUMENTS.map(i => i.feedSymbol),
      onTick: (feedSymbol, price, tsMs) => {
        const inst = CRYPTO_INSTRUMENTS.find(i => i.feedSymbol === feedSymbol);
        if (!inst) return;
        updateTick(inst.id, price, tsMs);
        aggById.get(inst.id)?.ingestTick(price, tsMs);
        busById.get(inst.id)?.onTick(price, tsMs);
        monitor.onTick(inst.id, price, tsMs);

        const priceMap = new Map();
        for (const [id, tick] of live.ticks.entries()) {
          priceMap.set(id, tick.price);
        }
        propFirmManager.onTick(priceMap, monitor.trades).catch(err => {
          console.error('[PropFirmManager] Binance tick error:', err);
        });
      }
    });
    console.log(`[bot] Binance feed started for: ${CRYPTO_INSTRUMENTS.map(i => i.id).join(', ')}`);
  }

  setInterval(() => {
    const now = Date.now();
    for (const inst of INSTRUMENTS) {
      const agg = aggById.get(inst.id);
      const sessions = agg.getSessions();
      const lastM1 = agg.getM1().at(-1);
      const t = live.ticks.get(inst.id);
      const livePx = t ? t.price : null;
      const ageSec = t ? Math.round((now - t.tsMs) / 1000) : null;

      console.log(
        `[bot] ${inst.id}`
        + ` live=${livePx != null ? livePx.toFixed(inst.decimals) : 'n/a'}`
        + ` age=${ageSec != null ? ageSec + 's' : 'n/a'}`
        + ` m1Close=${lastM1 ? lastM1.close.toFixed(inst.decimals) : 'n/a'}`
        + ` DO=${fmtPx(sessions.dailyOpen, inst.decimals)}`
        + ` Asia=[${fmtPx(sessions.asiaLo, inst.decimals)}-${fmtPx(sessions.asiaHi, inst.decimals)}]`
      );
    }
  }, 60_000);
}

// ── Daily summary scheduler (fires at 17:00 NY = end of trading day) ────
function startDailySummaryScheduler() {
  const NY_ZONE = 'America/New_York';

  function msUntilNext5pmNY() {
    const now  = DateTime.now().setZone(NY_ZONE);
    let target = now.set({ hour: 17, minute: 0, second: 0, millisecond: 0 });
    // If it's already past 17:00 today, schedule for tomorrow
    if (now >= target) target = target.plus({ days: 1 });
    return target.toMillis() - now.toMillis();
  }

  async function sendSummary() {
    try {
      const todayNY = DateTime.now().setZone(NY_ZONE);
      // Use yesterday's date if we somehow fire just after midnight
      const dateStr = todayNY.toFormat('yyyy-LL-dd');

      const todayTrades = await trades.find({ entryDateNY: dateStr }).toArray();
      const account = propFirmManager.getAccount();

      await mailer.sendDailySummary({ dateNY: dateStr, trades: todayTrades, account });
      console.log(`[scheduler] Daily summary sent for ${dateStr}`);
    } catch (e) {
      console.error('[scheduler] Daily summary error:', e?.message || e);
    }

    // Schedule the next one (tomorrow at 17:00 NY)
    setTimeout(sendSummary, msUntilNext5pmNY());
  }

  const delay = msUntilNext5pmNY();
  const hrsUntil = (delay / 3_600_000).toFixed(1);
  console.log(`[scheduler] Daily summary scheduled in ${hrsUntil}h (at 17:00 NY)`);
  setTimeout(sendSummary, delay);
}

// Start server then bot
app.listen(HTTP_PORT, async () => {
  console.log(`Dashboard + Web running on http://0.0.0.0:${HTTP_PORT}`);
  await startBot();
  startDailySummaryScheduler();
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  try { await client.close(); } catch { }
  process.exit(0);
});
