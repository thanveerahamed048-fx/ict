export function fmtPx(px, decimals = 5) {
  return px == null ? 'n/a' : px.toFixed(decimals);
}