export function calculateBackoff(attempt: number, base: number, maxBackoff: number): number {
  const exponential = base * Math.pow(2, attempt);
  const capped = Math.min(maxBackoff, exponential);
  const jitter = Math.random() * base;
  return Math.floor(capped + jitter);
}
