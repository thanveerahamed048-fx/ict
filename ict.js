// PO3 Live Signal Engine (Node.js)
// - Streams FX ticks from Finnhub WebSocket
// - Aggregates to M1 candles
// - Implements ICT PO3 logic: Accumulation (Asia), Manipulation (London sweep), Distribution (NY move)
// Requirements: Node >= 18, npm i ws luxon
// Env: FINNHUB_API_KEY=your_key

//import WebSocket from 'ws';
//import { DateTime } from 'luxon';
const WebSocket = require('ws');
const { DateTime } = require('luxon');

// ========================= CONFIG =========================
const FINNHUB_API_KEY = "d3s8dshr01qs1aprkmigd3s8dshr01qs1aprkmj0";
if (!FINNHUB_API_KEY) {
  console.error('Missing FINNHUB_API_KEY. Please set API KEY variable.');
  process.exit(1);
}
const USE_REST_BOOTSTRAP = false; // set to true only if you have REST access
// Popular pairs via OANDA symbols on Finnhub
const SYMBOLS = [
  'OANDA:EUR_USD',
  'OANDA:GBP_USD',
  'OANDA:USD_JPY',
  'OANDA:AUD_USD',
  'OANDA:USD_CAD',
];

// Session times in New York (America/New_York)
const NY_ZONE = 'America/New_York';
const ASIA_START_HOUR = 0;   // 00:00 NY
const ASIA_END_HOUR = 5;     // 05:00 NY
const LONDON_KZ_START = 2;   // 02:00 NY
const LONDON_KZ_END = 5;     // 05:00 NY
const NY_KZ_START = 8 + 30/60; // 08:30 NY
const NY_KZ_END = 11;        // 11:00 NY

// Displacement and buffers
const ATR_PERIOD = 14;
const DISPLACEMENT_MULT = 1.2;  // body > 1.2 * ATR
const STOP_BUFFER_PIPS = 5;     // extra pips beyond sweep extreme
const MAX_CANDLES_STORE = 2000; // M1 candles stored

// ========================= UTILITIES =========================
const pipSizeFor = (symbol) => {
  // crude heuristic: JPY pairs use 0.01, others 0.0001
  return symbol.includes('JPY') ? 0.01 : 0.0001;
};

const nowNY = () => DateTime.now().setZone(NY_ZONE);

const msToNY = (ms) => DateTime.fromMillis(ms, { zone: NY_ZONE });
const nyDayKey = (dtNY) => dtNY.toFormat('yyyy-LL-dd');

const nyDayStart = (ms) =>
  msToNY(ms).startOf('day'); // Luxon DT at 00:00 NY

const toUnixSec = (dt) => Math.floor(dt.toSeconds());

const inHourRangeNY = (dtNY, startHour, endHour) => {
  const hour = dtNY.hour + dtNY.minute / 60;
  return hour >= startHour && hour <= endHour;
};

const formatPx = (px, symbol) => {
  const p = pipSizeFor(symbol);
  const dp = p === 0.01 ? 3 : 5; // JPY pairs commonly 3 dp, others 5
  return px.toFixed(dp);
};

// ========================= FINNHUB REST =========================
async function fetchCandles(symbol, fromSec, toSec, resolution = 1) {
  const url = new URL('https://finnhub.io/api/v1/forex/candle');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('resolution', String(resolution));
  url.searchParams.set('from', String(fromSec));
  url.searchParams.set('to', String(toSec));
  url.searchParams.set('token', FINNHUB_API_KEY);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Candle fetch failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.s !== 'ok') return null;
  const candles = data.t.map((t, i) => ({
    ts: t * 1000,
    open: data.o[i],
    high: data.h[i],
    low: data.l[i],
    close: data.c[i],
    volume: data.v ? data.v[i] : 0,
  }));
  return candles;
}

// ========================= AGGREGATOR =========================
class M1Aggregator {
  constructor(onCandle) {
    this.onCandle = onCandle;
    this.current = {}; // symbol -> { minuteKey, candle }
  }

  ingestTick(symbol, price, tsMs) {
    const minuteKey = Math.floor(tsMs / 60000);

    if (!this.current[symbol]) {
      this.current[symbol] = {
        minuteKey,
        candle: this._newCandle(minuteKey, price),
      };
      return;
    }

    const entry = this.current[symbol];
    if (minuteKey !== entry.minuteKey) {
      // finalize previous candle
      this.onCandle(symbol, entry.candle);
      // start new candle
      this.current[symbol] = {
        minuteKey,
        candle: this._newCandle(minuteKey, price),
      };
      return;
    }

    // update candle
    const c = entry.candle;
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
  }

  _newCandle(minuteKey, price) {
    const tsStart = minuteKey * 60000;
    return {
      ts: tsStart,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
    };
  }
}

// ========================= PO3 ENGINE =========================
class Po3Engine {
  constructor(symbol) {
    this.symbol = symbol;
    this.candles = []; // M1 candles
    this.atr = null;

    // Day/session state
    this.dayKey = null; // 'yyyy-MM-dd' NY day
    this.dailyOpen = null;
    this.asiaHi = null;
    this.asiaLo = null;
    this.asiaDone = false;
    this.prevDayHigh = null;
    this.prevDayLow = null;

    // Sweep/entry state
    this.manipulation = null; // { type: 'sell'|'buy', sweepPx, sweepTs }
    this.displacement = null; // { direction, candle, eqMid }
    this.pendingEntry = null; // { direction, zoneLow, zoneHigh, stop, targets, activated }

    // Real-time last price for entry re-tests
    this.lastPrice = null;
    this.lastTs = null;
  }

  bootstrapFromHistory({ dayKey, dailyOpen, asiaHi, asiaLo, asiaDone, prevDayHigh, prevDayLow, candles }) {
    this.dayKey = dayKey;
    this.dailyOpen = dailyOpen;
    this.asiaHi = asiaHi;
    this.asiaLo = asiaLo;
    this.asiaDone = asiaDone;
    this.prevDayHigh = prevDayHigh;
    this.prevDayLow = prevDayLow;
    for (const c of candles) this._pushCandle(c);
    this._recalcATR();
    this._log(`Bootstrapped: DO=${formatPx(this.dailyOpen, this.symbol)} Asia [${formatPx(this.asiaLo, this.symbol)} - ${formatPx(this.asiaHi, this.symbol)}] prev H/L [${formatPx(this.prevDayHigh, this.symbol)} - ${formatPx(this.prevDayLow, this.symbol)}]`);
  }

  onTick(price, tsMs) {
    this.lastPrice = price;
    this.lastTs = tsMs;

    // Pending entry check on tick precision
    if (this.pendingEntry && !this.pendingEntry.activated) {
      const { direction, zoneLow, zoneHigh } = this.pendingEntry;
      if (direction === 'sell' && price >= zoneLow && price <= zoneHigh) {
        this._triggerEntry(price, tsMs);
      }
      if (direction === 'buy' && price <= zoneHigh && price >= zoneLow) {
        this._triggerEntry(price, tsMs);
      }
    }
  }

  onCandle(c) {
    const dtNY = msToNY(c.ts);
    const thisDayKey = nyDayKey(dtNY);

    // New NY day?
    if (this.dayKey !== thisDayKey) {
      // rotate day
      this._log(`New NY day ${thisDayKey}. Resetting state.`);
      this.dayKey = thisDayKey;
      this.dailyOpen = null;
      this.asiaHi = null;
      this.asiaLo = null;
      this.asiaDone = false;
      this.manipulation = null;
      this.displacement = null;
      this.pendingEntry = null;
    }

    // set daily open at 00:00 candle open
    if (dtNY.hour === 0 && dtNY.minute === 0) {
      this.dailyOpen = c.open;
      this._log(`Daily open set: ${formatPx(this.dailyOpen, this.symbol)}`);
    }

    // Build Asia range 00:00–05:00
    if (inHourRangeNY(dtNY, ASIA_START_HOUR, ASIA_END_HOUR)) {
      if (this.asiaHi == null || c.high > this.asiaHi) this.asiaHi = c.high;
      if (this.asiaLo == null || c.low < this.asiaLo) this.asiaLo = c.low;
      if (dtNY.hour === ASIA_END_HOUR && dtNY.minute === 0) {
        this.asiaDone = true;
        this._log(`Asia range locked: [${formatPx(this.asiaLo, this.symbol)} - ${formatPx(this.asiaHi, this.symbol)}]`);
      }
    }

    // push candle and recalc ATR
    this._pushCandle(c);
    this._recalcATR();

    // Try to detect sweep + displacement and set pending entries
    this._evaluatePO3(c, dtNY);
  }

  // Core PO3 logic per new M1 candle
  _evaluatePO3(c, dtNY) {
    // Need Asia range to exist
    if (this.asiaHi == null || this.asiaLo == null || this.dailyOpen == null || !this.atr) return;

    const inLondonKZ = inHourRangeNY(dtNY, LONDON_KZ_START, LONDON_KZ_END);
    const body = Math.abs(c.close - c.open);
    const isDisplacement = body >= DISPLACEMENT_MULT * this.atr;

    // 1) Detect manipulation sweep during London KZ
    if (inLondonKZ && !this.manipulation) {
      // Sell day candidate: sweep above Asia high, close back inside
      if (c.high > this.asiaHi && c.close <= this.asiaHi) {
        this.manipulation = { type: 'sell', sweepPx: c.high, sweepTs: c.ts };
        this._log(`Sweep HIGH detected (sell candidate). Sweep @ ${formatPx(c.high, this.symbol)}`);
      }
      // Buy day candidate: sweep below Asia low, close back inside
      else if (c.low < this.asiaLo && c.close >= this.asiaLo) {
        this.manipulation = { type: 'buy', sweepPx: c.low, sweepTs: c.ts };
        this._log(`Sweep LOW detected (buy candidate). Sweep @ ${formatPx(c.low, this.symbol)}`);
      }
    }

    // 2) After sweep, require displacement in direction of bias
    if (this.manipulation && !this.displacement) {
      if (this.manipulation.type === 'sell') {
        // look for bearish displacement back under Asia high
        if (isDisplacement && c.close < this.asiaHi) {
          const eqMid = (c.open + c.close) / 2; // midpoint for pullback entry
          this.displacement = { direction: 'sell', candle: c, eqMid };
          // Entry zone between 50% and 62% of displacement body
          const zoneHigh = Math.max(c.open, c.close);
          const zoneLow = eqMid;
          const stop = this.manipulation.sweepPx + STOP_BUFFER_PIPS * pipSizeFor(this.symbol);
          const targets = this._calcTargets('sell');
          this.pendingEntry = { direction: 'sell', zoneLow, zoneHigh, stop, targets, activated: false };
          this._log(`Displacement DOWN. Entry zone [${formatPx(zoneLow, this.symbol)} - ${formatPx(zoneHigh, this.symbol)}], SL ${formatPx(stop, this.symbol)} Targets: ${targets.map(t => formatPx(t, this.symbol)).join(', ')}`);
        }
      } else if (this.manipulation.type === 'buy') {
        if (isDisplacement && c.close > this.asiaLo) {
          const eqMid = (c.open + c.close) / 2;
          this.displacement = { direction: 'buy', candle: c, eqMid };
          const zoneLow = Math.min(c.open, c.close);
          const zoneHigh = eqMid;
          const stop = this.manipulation.sweepPx - STOP_BUFFER_PIPS * pipSizeFor(this.symbol);
          const targets = this._calcTargets('buy');
          this.pendingEntry = { direction: 'buy', zoneLow, zoneHigh, stop, targets, activated: false };
          this._log(`Displacement UP. Entry zone [${formatPx(zoneLow, this.symbol)} - ${formatPx(zoneHigh, this.symbol)}], SL ${formatPx(stop, this.symbol)} Targets: ${targets.map(t => formatPx(t, this.symbol)).join(', ')}`);
        }
      }
    }

    // 3) If pending entry exists but not activated, also check per-candle ranges (in addition to tick checks)
    if (this.pendingEntry && !this.pendingEntry.activated) {
      const { direction, zoneLow, zoneHigh } = this.pendingEntry;
      if (direction === 'sell') {
        if (c.high >= zoneLow && Math.max(c.open, c.close) <= zoneHigh) {
          this._triggerEntry(Math.min(Math.max(zoneLow, c.open), c.high), c.ts);
        }
      } else if (direction === 'buy') {
        if (c.low <= zoneHigh && Math.min(c.open, c.close) >= zoneLow) {
          this._triggerEntry(Math.max(Math.min(zoneHigh, c.open), c.low), c.ts);
        }
      }
    }

    // Optional: validate distribution in NY KZ — left as an exercise/log metric
  }

  _calcTargets(direction) {
    // T1: daily open, T2: Asia opposite, T3: previous day external liquidity
    if (direction === 'sell') {
      const t1 = this.dailyOpen;
      const t2 = this.asiaLo;
      const t3 = this.prevDayLow ?? this.asiaLo;
      return [t1, t2, t3].sort((a, b) => a - b); // ascending for sells
    } else {
      const t1 = this.dailyOpen;
      const t2 = this.asiaHi;
      const t3 = this.prevDayHigh ?? this.asiaHi;
      return [t1, t2, t3].sort((a, b) => b - a); // descending for buys
    }
  }

  _triggerEntry(entryPx, tsMs) {
    this.pendingEntry.activated = true;
    const { direction, stop, targets } = this.pendingEntry;
    const rrToTargets = targets.map(t => {
      const risk = Math.abs(entryPx - stop);
      const reward = Math.abs(t - entryPx);
      return reward / risk;
    });

    this._log(`ENTRY ${direction.toUpperCase()} @ ${formatPx(entryPx, this.symbol)} | SL ${formatPx(stop, this.symbol)} | Targets ${targets.map(formatPx.bind(null, undefined, this.symbol)).join(', ')} | RRs ${rrToTargets.map(r => r.toFixed(2)).join(', ')}`, tsMs);

    // After entry, you could track partials, trailing, etc. Here we just log the signal.
  }

  _pushCandle(c) {
    this.candles.push(c);
    if (this.candles.length > MAX_CANDLES_STORE) this.candles.shift();
  }

  _recalcATR() {
    if (this.candles.length < ATR_PERIOD + 1) return;
    let trSum = 0;
    for (let i = this.candles.length - ATR_PERIOD; i < this.candles.length; i++) {
      const cur = this.candles[i];
      const prev = this.candles[i - 1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      );
      trSum += tr;
    }
    this.atr = trSum / ATR_PERIOD;
  }

  _log(msg, tsMs = null) {
    const dt = tsMs ? msToNY(tsMs) : nowNY();
    console.log(`[${dt.toFormat('yyyy-LL-dd HH:mm:ss')} NY] ${this.symbol} | ${msg}`);
  }
}

// ========================= BOOTSTRAP (history) =========================
async function bootstrapSymbol(symbol) {
  const now = nowNY();
  const today0 = now.startOf('day');
  const prev0 = today0.minus({ days: 1 });
  const asiaStart = today0.plus({ hours: ASIA_START_HOUR });
  const asiaEnd = today0.plus({ hours: ASIA_END_HOUR });

  // Fetch previous day's candles to get H/L
  const prevCandles = await fetchCandles(symbol, toUnixSec(prev0), toUnixSec(today0));
  let prevDayHigh = null, prevDayLow = null;
  if (prevCandles && prevCandles.length) {
    prevDayHigh = Math.max(...prevCandles.map(c => c.high));
    prevDayLow = Math.min(...prevCandles.map(c => c.low));
  }

  // Fetch today's candles so far to get daily open and Asia range if past 05:00
  const todayCandles = await fetchCandles(symbol, toUnixSec(today0), Math.floor(Date.now()/1000));
  let dailyOpen = null, asiaHi = null, asiaLo = null, asiaDone = false;

  if (todayCandles && todayCandles.length) {
    // daily open is the open of first 00:00 candle (if present)
    const candle0000 = todayCandles.find(c => msToNY(c.ts).hour === 0 && msToNY(c.ts).minute === 0);
    if (candle0000) dailyOpen = candle0000.open;

    // Asia range 00:00–05:00
    const asiaCandles = todayCandles.filter(c => {
      const d = msToNY(c.ts);
      const h = d.hour + d.minute/60;
      return h >= ASIA_START_HOUR && h <= ASIA_END_HOUR;
    });
    if (asiaCandles.length) {
      asiaHi = Math.max(...asiaCandles.map(c => c.high));
      asiaLo = Math.min(...asiaCandles.map(c => c.low));
      // Mark done if time passed the end
      if (now > asiaEnd) asiaDone = true;
    }
  }

  // For engine, we’ll feed recent M1 candles (up to ~500) to seed ATR etc.
  const seedCandles = todayCandles?.slice(-500) ?? [];

  return {
    dayKey: nyDayKey(today0),
    dailyOpen,
    asiaHi,
    asiaLo,
    asiaDone,
    prevDayHigh,
    prevDayLow,
    candles: seedCandles,
  };
}

// ========================= FINNHUB WS =========================
class FinnhubWS {
  constructor(onTick) {
    this.onTick = onTick;
    this.ws = null;
    this.connected = false;
    this._connect();
  }

  _connect() {
    const url = `wss://ws.finnhub.io?token=${FINNHUB_API_KEY}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.connected = true;
      console.log('Finnhub WS connected.');
      for (const sym of SYMBOLS) {
        this.ws.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
      }
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'trade' && Array.isArray(msg.data)) {
          for (const t of msg.data) {
            const symbol = t.s;     // symbol
            const price = t.p;      // price
            const tsMs = t.t;       // ms epoch
            this.onTick(symbol, price, tsMs);
          }
        }
      } catch (e) {
        console.error('WS parse error:', e);
      }
    });

    this.ws.on('close', () => {
      console.log('Finnhub WS closed. Reconnecting in 3s...');
      this.connected = false;
      setTimeout(() => this._connect(), 3000);
    });

    this.ws.on('error', (err) => {
      console.error('Finnhub WS error:', err.message);
    });
  }
}

// ========================= MAIN =========================
(async function main() {
  console.log('Starting PO3 live engine (WebSocket-first)…');

  const engines = new Map();
  const aggregators = new Map();

  for (const symbol of SYMBOLS) {
    // Always create engine + aggregator so WS-only works
    const eng = new Po3Engine(symbol);
    engines.set(symbol, eng);

    const aggr = new M1Aggregator((sym, candle) => {
      const engine = engines.get(sym);
      if (engine) engine.onCandle(candle);
    });
    aggregators.set(symbol, aggr);

    // Optional REST bootstrap (off by default to avoid 403)
    if (USE_REST_BOOTSTRAP) {
      try {
        const boot = await bootstrapSymbol(symbol);
        if (boot && boot.dailyOpen != null) eng.bootstrapFromHistory(boot);
      } catch (e) {
        console.warn(`Bootstrap skipped for ${symbol}: ${e.message}`);
      }
    }
  }

  // Start WebSocket and route ticks
  const ws = new FinnhubWS((symbol, price, tsMs) => {
    const eng = engines.get(symbol);
    const aggr = aggregators.get(symbol);
    if (!eng || !aggr) return;
    eng.onTick(price, tsMs);
    aggr.ingestTick(symbol, price, tsMs);
  });

  // Periodic status
  setInterval(() => {
    for (const [symbol, eng] of engines) {
      if (!eng.lastPrice) continue;
      console.log(
        `${symbol} px=${formatPx(eng.lastPrice, symbol)} DO=${eng.dailyOpen ?? 'n/a'} `
        + `Asia=[${eng.asiaLo ?? 'n/a'}-${eng.asiaHi ?? 'n/a'}] ATR=${eng.atr ? eng.atr.toPrecision(3) : 'n/a'}`
      );
    }
  }, 60_000);
})();