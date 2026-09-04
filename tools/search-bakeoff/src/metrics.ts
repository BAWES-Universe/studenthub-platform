export function percentile(samples: readonly number[], quantile: number): number {
  if (samples.length === 0) throw new Error("cannot calculate a percentile without samples");
  if (quantile < 0 || quantile > 1) throw new Error("quantile must be between 0 and 1");
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.ceil(quantile * sorted.length) - 1;
  return sorted[Math.max(0, index)] as number;
}

export function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}
