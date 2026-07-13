import type {
  AnonymisationOperator,
  OperatorConfig,
  OperatorSelection,
  OperatorType,
} from "./types";

let graphemeSegmenter: Intl.Segmenter | undefined;
let textEncoder: TextEncoder | undefined;
const MAX_MASKING_CHARACTER_BYTES = 64;
const MAX_CHARACTERS_TO_MASK = 0xffff_ffff;

const getGraphemeSegmenter = (): Intl.Segmenter => {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  });
  return graphemeSegmenter;
};

const getTextEncoder = (): TextEncoder => {
  textEncoder ??= new TextEncoder();
  return textEncoder;
};

type MaskSelection = Extract<OperatorSelection, { type: "mask" }>;

export const requireMaskSelection = (
  selection: OperatorSelection,
): MaskSelection => {
  if (typeof selection === "string") {
    throw new TypeError("mask requires a tagged operator configuration");
  }
  return selection;
};

const maskSegments = (selection: MaskSelection, text: string) => {
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
    getTextEncoder().encode(selection.maskingCharacter).length >
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
  const segments = Array.from(getGraphemeSegmenter().segment(text));
  const count = Math.min(selection.charactersToMask, segments.length);
  return { count, maskFrom: segments.length - count, segments };
};

const shouldMaskSegment = (
  selection: MaskSelection,
  index: number,
  count: number,
  maskFrom: number,
): boolean =>
  selection.direction === "start" ? index < count : index >= maskFrom;

type MaskReplacementSpan = {
  start: number;
  end: number;
  replacement: string;
};

export const maskReplacementSpans = (
  text: string,
  selection: MaskSelection,
): MaskReplacementSpan[] => {
  const { count, maskFrom, segments } = maskSegments(selection, text);
  const replacements: MaskReplacementSpan[] = [];
  for (const [index, segment] of segments.entries()) {
    if (!shouldMaskSegment(selection, index, count, maskFrom)) continue;
    replacements.push({
      start: segment.index,
      end: segment.index + segment.segment.length,
      replacement: selection.maskingCharacter,
    });
  }
  return replacements;
};

const maskText = (text: string, selection: MaskSelection): string => {
  const { count, maskFrom, segments } = maskSegments(selection, text);
  return segments
    .map(({ segment }, index) => {
      const shouldMask = shouldMaskSegment(selection, index, count, maskFrom);
      return shouldMask ? selection.maskingCharacter : segment;
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
    return maskText(text, requireMaskSelection(selection));
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
