// src/feeds/finnhub.js
import WebSocket from 'ws';

export class FinnhubWS {
  constructor({
    apiKey,
    symbols,
    onTick,
    log = (...a) => console.log('[Finnhub]', ...a),
    pingIntervalMs = 30_000,   // send WS ping + JSON ping
    watchdogMs = 60_000,       // if no message for this long, reconnect
    reconnectBackoff = { base: 1000, max: 30_000 } // exponential backoff
  }) {
    this.apiKey = apiKey;
    this.symbols = Array.from(new Set(symbols || []));
    this.onTick = onTick;
    this.log = log;

    this.pingIntervalMs = pingIntervalMs;
    this.watchdogMs = watchdogMs;
    this.reconnectBackoff = reconnectBackoff;

    this.ws = null;
    this._pingTimer = null;
    this._watchdogTimer = null;
    this._lastMsgAt = 0;
    this._lastPingAt = 0;
    this._reconnectAttempts = 0;
    this._closedByClient = false;

    this._connect();
  }

  _url() {
    return `wss://ws.finnhub.io?token=${this.apiKey}`;
  }

  _connect() {
    if (!this.apiKey) {
      this.log('Missing API key. Finnhub WS not started.');
      return;
    }

    this._closedByClient = false;
    const url = this._url();
    this.log(`Connecting ${url} ...`);
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.log('Connected.');
      this._reconnectAttempts = 0;
      this._lastMsgAt = Date.now();
      // subscribe symbols
      for (const s of this.symbols) this._send({ type: 'subscribe', symbol: s });
      // start keepalive
      this._startPing();
      this._startWatchdog();
    });

    this.ws.on('message', (raw) => {
      this._lastMsgAt = Date.now();

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        // Some servers may send non-JSON frames; ignore.
        return;
      }

      // Finnhub sometimes sends text {"type":"ping"}; respond politely
      if (msg.type === 'ping') {
        this._send({ type: 'pong' }); // not strictly required, but safe
        return;
      }

      if (msg.type === 'trade' && Array.isArray(msg.data)) {
        for (const t of msg.data) {
          // t: { s: symbol, p: price, t: timestamp_ms }
          try {
            this.onTick?.(t.s, t.p, t.t);
          } catch (e) {
            this.log('onTick error:', e?.message || e);
          }
        }
        return;
      }

      // other types can be ignored or logged
      // this.log('msg', msg);
    });

    this.ws.on('pong', () => {
      // ws (control) pong arrived; mark activity
      this._lastMsgAt = Date.now();
    });

    this.ws.on('error', (err) => {
      this.log('WS error:', err?.message || err);
    });

    this.ws.on('close', (code, reason) => {
      this.log(`Closed (code=${code}) reason=${reason?.toString() || ''}`);
      this._stopPing();
      this._stopWatchdog();
      if (!this._closedByClient) this._scheduleReconnect();
    });
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      // ignore
    }
  }

  _startPing() {
    this._stopPing();
    if (this.pingIntervalMs <= 0) return;

    this._pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      // WS ping control frame (handled by ws automatically for pong)
      try {
        this.ws.ping();
      } catch {}
      // Also send Finnhub JSON ping to keep app-level session alive
      this._send({ type: 'ping' });
      this._lastPingAt = Date.now();
    }, this.pingIntervalMs);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _startWatchdog() {
    this._stopWatchdog();
    if (this.watchdogMs <= 0) return;

    this._watchdogTimer = setInterval(() => {
      const idle = Date.now() - this._lastMsgAt;
      if (idle > this.watchdogMs) {
        this.log(`No messages for ${Math.round(idle / 1000)}s. Reconnecting...`);
        this._forceReconnect();
      }
    }, Math.max(2000, Math.min(10_000, this.watchdogMs / 2)));
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  _forceReconnect() {
    try { this.ws?.terminate?.(); } catch {}
    this._stopPing();
    this._stopWatchdog();
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    this._reconnectAttempts += 1;
    const delay = Math.min(
      this.reconnectBackoff.max,
      this.reconnectBackoff.base * Math.pow(2, this._reconnectAttempts - 1)
    );
    this.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this._reconnectAttempts}) ...`);
    setTimeout(() => this._connect(), delay);
  }

  close() {
    this._closedByClient = true;
    this._stopPing();
    this._stopWatchdog();
    try { this.ws?.close?.(); } catch {}
  }

  // Optional API to manage symbols dynamically
  subscribe(symbol) {
    if (!this.symbols.includes(symbol)) this.symbols.push(symbol);
    this._send({ type: 'subscribe', symbol });
  }

  unsubscribe(symbol) {
    this.symbols = this.symbols.filter(s => s !== symbol);
    this._send({ type: 'unsubscribe', symbol });
  }
}