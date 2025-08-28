export function ema(prev, price, period) {
  const k = 2 / (period + 1);
  return prev == null ? price : prev + k * (price - prev);
}
