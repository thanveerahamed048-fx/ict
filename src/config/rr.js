// src/config/rr.js
// Per‑instrument TP/SL in pips (pips × pipSize = price distance)

// Metals
export const RR_BY_SYMBOL = {
  XAUUSD: { tpPips: 70, slPips: 70 }, // Gold (pipSize=0.10 → $10 for 100 pips)
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
  GBPJPY: { tpPips: 25, slPips: 30 }
};

// Fallback if an instrument id is not listed above
export const DEFAULT_RR = { tpPips: 100, slPips: 100 };