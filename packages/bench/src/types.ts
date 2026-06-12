/** A labeled character span; offsets are UTF-16 code units into the document text. */
export type BenchSpan = {
  start: number;
  end: number;
  label: string;
};

export type GoldDocument = {
  /** Path relative to the contracts fixture root, e.g. "cs/sanofi-bonus-agreement.txt". */
  id: string;
  language: string;
  text: string;
  gold: BenchSpan[];
};

export type PredictionsDocument = {
  id: string;
  entities: BenchSpan[];
};

/**
 * Interchange format for tool outputs. External tools (Presidio,
 * redact-pii, ...) produce this shape so every tool is scored by
 * the same scorer against the same reference annotations.
 */
export type PredictionsFile = {
  tool: string;
  docs: PredictionsDocument[];
};
