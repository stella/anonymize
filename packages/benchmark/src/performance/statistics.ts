export type Distribution = {
  readonly samples: readonly number[];
  readonly median: number;
  readonly medianAbsoluteDeviation: number;
  readonly p95: number;
};

const medianSorted = (values: readonly number[]): number => {
  const middle = Math.floor(values.length / 2);
  const upper = values.at(middle);
  if (upper === undefined) throw new Error("distribution must not be empty");
  if (values.length % 2 === 1) return upper;
  const lower = values.at(middle - 1);
  if (lower === undefined) throw new Error("distribution must not be empty");
  return (lower + upper) / 2;
};

export const summarize = (samples: readonly number[]): Distribution => {
  if (samples.length === 0) throw new Error("samples must not be empty");
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error("samples must be finite and non-negative");
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const median = medianSorted(sorted);
  const deviations = sorted
    .map((sample) => Math.abs(sample - median))
    .sort((left, right) => left - right);
  const p95Index = Math.ceil(sorted.length * 0.95) - 1;
  const p95 = sorted.at(p95Index);
  if (p95 === undefined) throw new Error("distribution must not be empty");

  return {
    samples: [...samples],
    median,
    medianAbsoluteDeviation: medianSorted(deviations),
    p95,
  };
};
