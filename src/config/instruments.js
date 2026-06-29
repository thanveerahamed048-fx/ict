// Instrument config: internal ID, feed symbol, and precision metadata

export const FX_INSTRUMENTS = [
  { id: 'EURUSD', feed: 'finnhub', feedSymbol: 'OANDA:EUR_USD', pipSize: 0.0001, decimals: 5 },
  { id: 'GBPUSD', feed: 'finnhub', feedSymbol: 'OANDA:GBP_USD', pipSize: 0.0001, decimals: 5 },
  { id: 'USDJPY', feed: 'finnhub', feedSymbol: 'OANDA:USD_JPY', pipSize: 0.01,   decimals: 3 },
  { id: 'AUDUSD', feed: 'finnhub', feedSymbol: 'OANDA:AUD_USD', pipSize: 0.0001, decimals: 5 },
  { id: 'USDCAD', feed: 'finnhub', feedSymbol: 'OANDA:USD_CAD', pipSize: 0.0001, decimals: 5 },
  { id: 'XAUUSD', feed: 'finnhub', feedSymbol: 'OANDA:XAU_USD', pipSize: 0.1,   decimals: 2 }
];

// pipSize for crypto = smallest meaningful price move (same as tick)
// 1 "pip" = 1 tick, so TP/SL pips in rr.js are in tick units
export const CRYPTO_INSTRUMENTS = [
  { id: 'BTCUSDT', feed: 'binance', feedSymbol: 'btcusdt', pipSize: 1,     decimals: 2, isCrypto: true },
  { id: 'ETHUSDT', feed: 'binance', feedSymbol: 'ethusdt', pipSize: 0.1,   decimals: 2, isCrypto: true },
  { id: 'SOLUSDT', feed: 'binance', feedSymbol: 'solusdt', pipSize: 0.01,  decimals: 3, isCrypto: true },
];

export const INSTRUMENTS = [...FX_INSTRUMENTS, ...CRYPTO_INSTRUMENTS];
