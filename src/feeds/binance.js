// src/feeds/binance.js
import WebSocket from 'ws';
import { ProxyAgent } from 'proxy-agent';

// Try multiple base URLs (9443 and 443, global and US)
const DEFAULT_BASES = [
  'wss://stream.binance.com:9443',
  'wss://stream.binance.com',        // 443
  'wss://stream.binance.us:9443',
  'wss://stream.binance.us'          // 443
];

export class BinanceWS {
  constructor({ symbols, onTick, baseUrls, proxyUrl, connectTimeoutMs = 8000 }) {
    this.symbols = symbols.map(s => s.toLowerCase()); // e.g., 'btcusdt'
    this.onTick = onTick;
    this.baseUrls = (baseUrls && baseUrls.length ? baseUrls : DEFAULT_BASES).map(s => s.replace(/\/$/, ''));
    this.baseIndex = 0;
    this.backoffMs = 2000;
    this.maxBackoffMs = 30000;
    this.connectTimeoutMs = connectTimeoutMs;
    this.agent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

    this.ws = null;
    this.connectTimer = null;

    this._connect();
  }

  _streamPath() {
    const stream = this.symbols.map(s => `${s}@aggTrade`).join('/');
    return `/stream?streams=${stream}`;
  }

  _connect() {
    const base = this.baseUrls[this.baseIndex];
    const url = `${base}${this._streamPath()}`;
    console.log(`Binance WS connecting: ${url}`);

    try {
      this.ws = new WebSocket(url, {
        perMessageDeflate: false,
        handshakeTimeout: this.connectTimeoutMs,
        agent: this.agent
      });

      // Manual connect timeout as extra guard
      this.connectTimer = setTimeout(() => {
        console.warn('Binance WS connect timeout; rotating endpoint...');
        try { this.ws?.terminate(); } catch {}
      }, this.connectTimeoutMs + 1000);

      this.ws.on('open', () => {
        clearTimeout(this.connectTimer);
        this.backoffMs = 2000; // reset backoff
        console.log(`Binance WS connected on: ${base}`);
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.stream && msg.data && msg.data.e === 'aggTrade') {
            const d = msg.data; // { s, p, T }
            const symbol = d.s.toLowerCase(); // e.g., 'btcusdt'
            const price = parseFloat(d.p);
            const tsMs = d.T;
            this.onTick(symbol, price, tsMs);
          }
        } catch (e) {
          console.error('Binance WS parse error:', e.message);
        }
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(this.connectTimer);
        console.warn(`Binance WS closed (${code}) ${reason || ''}`);
        this._rotateAndReconnect();
      });

      this.ws.on('error', (err) => {
        clearTimeout(this.connectTimer);
        console.error('Binance WS error:', err.message);
        // Let close handler rotate; if not closed, force it
        try { this.ws?.terminate(); } catch {}
      });
    } catch (e) {
      console.error('Binance WS ctor error:', e.message);
      this._rotateAndReconnect();
    }
  }

  _rotateAndReconnect() {
    this.baseIndex = (this.baseIndex + 1) % this.baseUrls.length;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    console.log(`Reconnecting to next Binance endpoint in ${Math.round(delay/1000)}s...`);
    setTimeout(() => this._connect(), delay);
  }
}