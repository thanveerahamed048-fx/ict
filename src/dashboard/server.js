// src/dashboard/server.js
import express from 'express';
import { MongoClient } from 'mongodb';
import { DateTime } from 'luxon';
import cors from 'cors';
import dotenv from "dotenv";
dotenv.config();
// ================== DIRECT CONFIG (edit me) ==================
const HTTP_PORT = process.env.HTTP_PORT;
const MONGO_URI = process.env.MONGO_URI; 
const DB_NAME = 'trade_dashboard';
const TRADES_COLL = 'trades';
// ============================================================
console.log("mongo",MONGO_URI);
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

// Mongo connect + indexes
const client = new MongoClient(MONGO_URI);
await client.connect();
const db = client.db(DB_NAME);
const trades = db.collection(TRADES_COLL);

await trades.createIndex({ entryTs: -1 });
await trades.createIndex({ entryDateNY: 1 });
await trades.createIndex({ status: 1, instrumentId: 1 });
await trades.createIndex({ instrumentId: 1, strategy: 1, entryTs: -1 });

const app = express();
app.use(cors());
app.use(express.json({ limit: '200kb' }));

app.get('/health', async (_req, res) => {
  try {
    const open = await trades.countDocuments({ status: 'open' });
    res.json({ ok: true, open });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

    // Base doc (no updatedAt here to avoid conflict)
    const baseDoc = {
      _id: tradeId,
      instrumentId: b.instrumentId,
      strategy: b.strategy,
      direction: b.direction,
      entryTs: entryTsMs,
      entryTsNY: fmtNY(entryTsMs),
      entryDateNY: dateNY(entryTsMs),
      entryPrice: Number(b.entry),
      slPrice: b.sl != null ? Number(b.sl) : null,
      tpPrice: b.tp != null ? Number(b.tp) : null,
      slPips: b.slPips != null ? Number(b.slPips) : null,
      tpPips: b.tpPips != null ? Number(b.tpPips) : null,
      pipSize: b.pipSize != null ? Number(b.pipSize) : null,
      decimals: b.decimals != null ? Number(b.decimals) : 5,
      variantLabel: b.variantLabel || null,
      status: 'open',
      exitTs: null,
      exitTsNY: null,
      exitPrice: null,
      exitReason: null,
      resultPips: null,
      timeToCloseMin: null,
      session: sessionLabel(entryTsMs),
      context: {
        dailyOpen: b.sessions?.dailyOpen ?? null,
        asiaLo: b.sessions?.asiaLo ?? null,
        asiaHi: b.sessions?.asiaHi ?? null,
        prevDayHigh: b.sessions?.prevDayHigh ?? null,
        prevDayLow: b.sessions?.prevDayLow ?? null
      },
      models: Array.isArray(b.models) ? b.models : (b.models ? [b.models] : []),
      score: b.score ?? null,
      createdAt: nowMs
    };

    await trades.updateOne(
      { _id: tradeId },
      {
        $setOnInsert: baseDoc,
        $set: { updatedAt: nowMs } // only set updatedAt here (no conflict)
      },
      { upsert: true }
    );

    res.status(201).json({ ok: true, tradeId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Close trade on result (TP/SL)
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
    const exitReason = b.outcome === 'profit' ? 'tp' : b.outcome === 'loss' ? 'sl' : 'manual';
    const timeToCloseMin = Math.max(0, Math.round((exitTsMs - (doc.entryTs || exitTsMs)) / 60000));

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
          timeToCloseMin,
          updatedAt: Date.now(),
          variantLabel: b.variant || doc.variantLabel || null
        }
      }
    );

    res.json({ ok: true, tradeId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Summary stats
app.get('/stats/summary', async (_req, res) => {
  try {
    const totalsAgg = await trades.aggregate([
      {
        $facet: {
          counts: [
            { $group: {
              _id: null,
              signals: { $sum: 1 },
              open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
              closed: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } },
              wins: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $gt: ['$resultPips', 0] }] }, 1, 0] } },
              losses:{ $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $lte: ['$resultPips', 0] }] }, 1, 0] } },
              netPips: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, '$resultPips', 0] } },
              sumPips: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, '$resultPips', 0] } },
              cntClosed: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } }
            }},
            { $project: {
              _id: 0,
              signals: 1, open: 1, closed: 1, wins: 1, losses: 1, netPips: 1,
              winRate: { $cond: [{ $gt: [{ $add: ['$wins', '$losses'] }, 0] }, { $divide: ['$wins', { $add: ['$wins', '$losses'] }] }, 0] },
              avgPips: { $cond: [{ $gt: ['$cntClosed', 0] }, { $divide: ['$sumPips', '$cntClosed'] }, 0] }
            }}
          ],
          byStrategy: [
            { $group: {
              _id: '$strategy',
              signals: { $sum: 1 },
              wins: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $gt: ['$resultPips', 0] }] }, 1, 0] } },
              losses:{ $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $lte: ['$resultPips', 0] }] }, 1, 0] } },
              netPips: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, '$resultPips', 0] } }
            }},
            { $project: {
              _id: 0, strategy: '$_id', signals: 1, wins: 1, losses: 1, netPips: 1,
              winRate: { $cond: [{ $gt: [{ $add: ['$wins', '$losses'] }, 0] }, { $divide: ['$wins', { $add: ['$wins', '$losses'] }] }, 0] }
            }},
            { $sort: { netPips: -1 } }
          ],
          byInstrument: [
            { $group: {
              _id: '$instrumentId',
              signals: { $sum: 1 },
              wins: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $gt: ['$resultPips', 0] }] }, 1, 0] } },
              losses:{ $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $lte: ['$resultPips', 0] }] }, 1, 0] } },
              netPips: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, '$resultPips', 0] } }
            }},
            { $project: {
              _id: 0, instrumentId: '$_id', signals: 1, wins: 1, losses: 1, netPips: 1,
              winRate: { $cond: [{ $gt: [{ $add: ['$wins', '$losses'] }, 0] }, { $divide: ['$wins', { $add: ['$wins', '$losses'] }] }, 0] }
            }},
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

app.get('/stats/daily', async (req, res) => {
  try {
    const { start, end } = req.query;
    const match = {};
    if (start) match.entryDateNY = { ...match.entryDateNY, $gte: start };
    if (end) match.entryDateNY = { ...match.entryDateNY, $lte: end };

    const rows = await trades.aggregate([
      { $match: match },
      { $group: {
        _id: '$entryDateNY',
        signals: { $sum: 1 },
        wins: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $gt: ['$resultPips', 0] }] }, 1, 0] } },
        losses:{ $sum: { $cond: [{ $and: [{ $eq: ['$status', 'closed'] }, { $lte: ['$resultPips', 0] }] }, 1, 0] } },
        netPips: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, '$resultPips', 0] } }
      }},
      { $project: {
        _id: 0, dateNY: '$_id', signals: 1, wins: 1, losses: 1, netPips: 1,
        winRate: { $cond: [{ $gt: [{ $add: ['$wins', '$losses'] }, 0] }, { $divide: ['$wins', { $add: ['$wins', '$losses'] }] }, 0] }
      }},
      { $sort: { dateNY: 1 } }
    ]).toArray();

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

app.get('/trades/:id', async (req, res) => {
  try {
    const doc = await trades.findOne({ _id: req.params.id });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.listen(HTTP_PORT, () => {
  console.log(`Dashboard API running on http://localhost:${HTTP_PORT}`);
});
export default app;