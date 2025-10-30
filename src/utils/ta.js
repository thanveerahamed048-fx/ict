// Minimal TA helpers: ATR, swings, displacement
export function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );
    sum += tr;
  }
  return sum / period;
}

export function findSwings(candles, left = 2, right = 2) {
  const highs = [];
  const lows = [];
  for (let i = left; i < candles.length - right; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    let isHigh = true, isLow = true;
    for (let j = 1; j <= left; j++) {
      if (candles[i - j].high >= h) isHigh = false;
      if (candles[i - j].low <= l) isLow = false;
    }
    for (let j = 1; j <= right; j++) {
      if (candles[i + j].high > h) isHigh = false;
      if (candles[i + j].low < l) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}

export function isDisplacement(c, a, mult = 1.2) {
  if (!a) return false;
  const body = Math.abs(c.close - c.open);
  return body >= mult * a;
}