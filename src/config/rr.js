// src/config/rr.js
// Per-instrument TP/SL in pips (pips x pipSize = price distance)

export const RR_BY_SYMBOL = {
  // Metals
  XAUUSD: { tpPips: 70, slPips: 70 }, // Gold (pipSize=0.10)
  XAGUSD: { tpPips: 200, slPips: 200 },

  // Majors (5-digit, pipSize=0.0001)
  EURUSD: { tpPips: 20, slPips: 25 },
  GBPUSD: { tpPips: 25, slPips: 30 },
  AUDUSD: { tpPips: 20, slPips: 25 },
  NZDUSD: { tpPips: 20, slPips: 25 },
  USDCAD: { tpPips: 20, slPips: 25 },

  // Yen pairs (pipSize=0.01)
  USDJPY: { tpPips: 20, slPips: 25 },
  EURJPY: { tpPips: 22, slPips: 28 },
  GBPJPY: { tpPips: 25, slPips: 30 },

  // Crypto — 1 pip = 1 tick (pipSize defined in instruments.js)
  // BTC: pipSize=1   -> 200 pips = $200 price move
  // ETH: pipSize=0.1 -> 150 pips = $15 price move
  // SOL: pipSize=0.01 -> 200 pips = $2 price move
  BTCUSDT: { tpPips: 200, slPips: 150 },
  ETHUSDT: { tpPips: 150, slPips: 120 },
  SOLUSDT: { tpPips: 200, slPips: 150 },
};

// Fallback if an instrument id is not listed above
export const DEFAULT_RR = { tpPips: 100, slPips: 100 };
