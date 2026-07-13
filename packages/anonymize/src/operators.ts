import type {
  AnonymisationOperator,
  OperatorConfig,
  OperatorSelection,
  OperatorType,
} from "./types";

let graphemeSegmenter: Intl.Segmenter | undefined;
const MAX_MASKING_CHARACTER_BYTES = 64;
const MAX_CHARACTERS_TO_MASK = 0xffff_ffff;

const getGraphemeSegmenter = (): Intl.Segmenter => {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  });
  return graphemeSegmenter;
};

const maskText = (
  text: string,
  selection: Extract<OperatorSelection, { type: "mask" }>,
): string => {
  if (
    !Number.isSafeInteger(selection.charactersToMask) ||
    selection.charactersToMask <= 0 ||
    selection.charactersToMask > MAX_CHARACTERS_TO_MASK
  ) {
    throw new RangeError("charactersToMask must be a positive 32-bit integer");
  }
  if (selection.direction !== "start" && selection.direction !== "end") {
    throw new RangeError("direction must be either start or end");
  }
  if (
    new TextEncoder().encode(selection.maskingCharacter).length >
    MAX_MASKING_CHARACTER_BYTES
  ) {
    throw new RangeError(
      `maskingCharacter must not exceed ${MAX_MASKING_CHARACTER_BYTES} UTF-8 bytes`,
    );
  }
  if (
    Array.from(getGraphemeSegmenter().segment(selection.maskingCharacter))
      .length !== 1
  ) {
    throw new RangeError(
      "maskingCharacter must contain exactly one grapheme cluster",
    );
  }
  const graphemes = Array.from(
    getGraphemeSegmenter().segment(text),
    ({ segment }) => segment,
  );
  const count = Math.min(selection.charactersToMask, graphemes.length);
  const maskFrom = graphemes.length - count;
  return graphemes
    .map((grapheme, index) => {
      const shouldMask =
        selection.direction === "start" ? index < count : index >= maskFrom;
      return shouldMask ? selection.maskingCharacter : grapheme;
    })
    .join("");
};

// ── Operator registry ──────────────────────────────────

const replaceOperator: AnonymisationOperator = {
  type: "replace",
  reversibility: "reversible",
  apply: (_text, _label, placeholder) => placeholder,
};

const redactOperator: AnonymisationOperator = {
  type: "redact",
  reversibility: "irreversible",
  apply: (_text, _label, _placeholder, redactString) => redactString,
};

const keepOperator: AnonymisationOperator = {
  type: "keep",
  reversibility: "preserving",
  apply: (text) => text,
};

const maskOperator: AnonymisationOperator = {
  type: "mask",
  reversibility: "irreversible",
  apply: (text, _label, _placeholder, _redactString, selection) => {
    if (typeof selection === "string") {
      throw new TypeError("mask requires a tagged operator configuration");
    }
    return maskText(text, selection);
  },
};

export const OPERATOR_REGISTRY = {
  replace: replaceOperator,
  redact: redactOperator,
  keep: keepOperator,
  mask: maskOperator,
} as const satisfies Record<OperatorType, AnonymisationOperator>;

const DEFAULT_REDACT_STRING = "[REDACTED]";

/**
 * Default operator config: replace for all labels.
 * Preserves existing pipeline behaviour.
 */
export const DEFAULT_OPERATOR_CONFIG: OperatorConfig = {
  operators: {},
  redactString: DEFAULT_REDACT_STRING,
};

/**
 * Resolve the operator for a label, falling back to "replace".
 */
export const resolveOperator = (
  config: OperatorConfig,
  label: string,
): OperatorSelection => config.operators[label] ?? "replace";

export const operatorType = (selection: OperatorSelection): OperatorType =>
  typeof selection === "string" ? selection : selection.type;
