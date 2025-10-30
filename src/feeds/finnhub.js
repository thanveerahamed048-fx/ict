import WebSocket from 'ws';

export class FinnhubWS {
  constructor({ apiKey, symbols, onTick }) {
    this.apiKey = apiKey;
    this.symbols = symbols;
    this.onTick = onTick;
    this.ws = null;
    this._connect();
  }

  _connect() {
    const url = `wss://ws.finnhub.io?token=${this.apiKey}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('Finnhub WS connected.');
      for (const s of this.symbols) {
        this.ws.send(JSON.stringify({ type: 'subscribe', symbol: s }));
      }
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'trade' && Array.isArray(msg.data)) {
          for (const t of msg.data) {
            // t: { s, p, t }
            this.onTick(t.s, t.p, t.t);
          }
        }
      } catch (e) {
        console.error('Finnhub WS parse error:', e.message);
      }
    });

    this.ws.on('close', () => {
      console.log('Finnhub WS closed. Reconnecting in 3s...');
      setTimeout(() => this._connect(), 3000);
    });

    this.ws.on('error', (err) => console.error('Finnhub WS error:', err.message));
  }
}