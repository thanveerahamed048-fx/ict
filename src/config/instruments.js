// Instrument config: internal ID, feed symbol, and precision metadata

export const FX_INSTRUMENTS = [
{ id: 'EURUSD', feed: 'finnhub', feedSymbol: 'OANDA:EUR_USD', pipSize: 0.0001, decimals: 5 },
  { id: 'GBPUSD', feed: 'finnhub', feedSymbol: 'OANDA:GBP_USD', pipSize: 0.0001, decimals: 5 },
   { id: 'USDJPY', feed: 'finnhub', feedSymbol: 'OANDA:USD_JPY', pipSize: 0.01,   decimals: 3 },
  { id: 'AUDUSD', feed: 'finnhub', feedSymbol: 'OANDA:AUD_USD', pipSize: 0.0001, decimals: 5 },
 { id: 'USDCAD', feed: 'finnhub', feedSymbol: 'OANDA:USD_CAD', pipSize: 0.0001, decimals: 5 },

];
//   { id: 'EURUSD', feed: 'finnhub', feedSymbol: 'OANDA:EUR_USD', pipSize: 0.0001, decimals: 5 },
//   { id: 'GBPUSD', feed: 'finnhub', feedSymbol: 'OANDA:GBP_USD', pipSize: 0.0001, decimals: 5 },
//   { id: 'USDJPY', feed: 'finnhub', feedSymbol: 'OANDA:USD_JPY', pipSize: 0.01,   decimals: 3 },
//   { id: 'AUDUSD', feed: 'finnhub', feedSymbol: 'OANDA:AUD_USD', pipSize: 0.0001, decimals: 5 },
//   { id: 'USDCAD', feed: 'finnhub', feedSymbol: 'OANDA:USD_CAD', pipSize: 0.0001, decimals: 5 },
export const CRYPTO_INSTRUMENTS = [
  { id: 'BTCUSDT', feed: 'binance', feedSymbol: 'btcusdt', tick: 0.1,  decimals: 2 },
  { id: 'ETHUSDT', feed: 'binance', feedSymbol: 'ethusdt', tick: 0.01, decimals: 2 },
  { id: 'SOLUSDT', feed: 'binance', feedSymbol: 'solusdt', tick: 0.001, decimals: 3 },
];

export const INSTRUMENTS = [...FX_INSTRUMENTS, ...CRYPTO_INSTRUMENTS];