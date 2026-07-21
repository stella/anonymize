import {
  DEFAULT_OPERATOR_CONFIG,
  maskReplacementSpans,
  OPERATOR_REGISTRY,
  operatorType,
  requireMaskSelection,
  resolveOperator,
} from "./operators";
import type {
  Entity,
  OperatorConfig,
  OperatorType,
  RedactionResult,
} from "./types";
import type { PipelineContext } from "./context";
import { defaultContext } from "./context";

const WHITESPACE_RE = /\s+/g;
const NON_PHONE_DIGIT_RE = /\D/g;
const ETHEREUM_ADDRESS_RE = /0x[0-9A-Fa-f]{40}/;
const BECH32_ADDRESS_RE = /\bbc1[ac-hj-np-z02-9]{11,71}\b/i;
const BASE58_ADDRESS_RE = /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/;
const NHS_NUMBER_CUE_RE = /\b(?:NHS|National\s+Health\s+Service)\b/i;
const PLACEHOLDER_TOKEN_RE = /\[[^\s[\]]+_[1-9]\d*\]/g;
const PASSPORT_IDENTIFIER_RE =
  /\b(?:[A-Za-z]{1,2}\d{6,8}|\d{2}[A-Za-z]{2}\d{5}|\d{7,9})\b/;
// Strip all separators the ID detectors accept so the
// same real-world value canonicalises to one placeholder:
//   - whitespace and `-` for IBAN, NIP, REGON, etc.
//   - `/` for birth numbers ("900101/1234") and Czech
//     bank accounts ("123-4567/0100").
//   - `.` for credit cards ("4111.1111.1111.1111") and
//     other dotted IDs.
const ID_SEPARATOR_RE = /[\s\-/.]/g;

const nextPlaceholder = (
  labelKey: string,
  counters: Map<string, number>,
  reservedPlaceholders: ReadonlySet<string>,
): string => {
  let count = counters.get(labelKey) ?? 0;

  while (true) {
    count += 1;
    const placeholder = `[${labelKey}_${count}]`;
    if (reservedPlaceholders.has(placeholder)) continue;

    counters.set(labelKey, count);
    return placeholder;
  }
};

const collectReservedPlaceholders = (
  reservedText: string,
): ReadonlySet<string> => new Set(reservedText.match(PLACEHOLDER_TOKEN_RE));

const normalizeCryptoText = (text: string): string => {
  const trimmed = text.trim();

  const ethereumAddress = ETHEREUM_ADDRESS_RE.exec(trimmed)?.[0];
  if (ethereumAddress) {
    return ethereumAddress.toLowerCase();
  }

  const bech32Address = BECH32_ADDRESS_RE.exec(trimmed)?.[0];
  if (bech32Address) {
    return bech32Address.toLowerCase();
  }

  const base58Address = BASE58_ADDRESS_RE.exec(trimmed)?.[0];
  return base58Address ?? trimmed;
};

const normalizePassportText = (text: string): string => {
  const passportIdentifier = PASSPORT_IDENTIFIER_RE.exec(text)?.[0] ?? text;
  return passportIdentifier.replace(ID_SEPARATOR_RE, "").toUpperCase();
};

/**
 * Normalize entity text so that surface-form variations
 * of the same real-world value map to a single canonical
 * key. Lowercased emails, stripped phone formatting, etc.
 */
const normalizeEntityText = (label: string, text: string): string => {
  const upper = label.toUpperCase().replace(WHITESPACE_RE, "_");

  if (upper === "EMAIL_ADDRESS" || upper === "EMAIL") {
    return text.toLowerCase().trim();
  }
  if (upper === "PHONE_NUMBER" || upper === "PHONE") {
    const digits = text.replace(NON_PHONE_DIGIT_RE, "");
    return digits.startsWith("00") ? digits.slice(2) : digits;
  }
  if (upper === "CRYPTO") {
    return normalizeCryptoText(text);
  }
  if (
    upper === "NATIONAL_IDENTIFICATION_NUMBER" &&
    NHS_NUMBER_CUE_RE.test(text)
  ) {
    return text.replace(/\D/g, "");
  }
  if (
    upper === "IBAN" ||
    upper === "BANK_ACCOUNT_NUMBER" ||
    upper === "TAX_IDENTIFICATION_NUMBER" ||
    upper === "REGISTRATION_NUMBER" ||
    upper === "NATIONAL_IDENTIFICATION_NUMBER" ||
    upper === "SOCIAL_SECURITY_NUMBER" ||
    upper === "BIRTH_NUMBER" ||
    upper === "IDENTITY_CARD_NUMBER" ||
    upper === "CREDIT_CARD_NUMBER"
  ) {
    return text.replace(ID_SEPARATOR_RE, "").toUpperCase();
  }
  if (upper === "PASSPORT_NUMBER") {
    return normalizePassportText(text);
  }
  if (
    upper === "PERSON" ||
    upper === "ORGANIZATION" ||
    upper === "ADDRESS" ||
    upper === "LAND_PARCEL" ||
    upper === "MISC"
  ) {
    return text.replace(WHITESPACE_RE, " ").toLowerCase().trim();
  }
  return text.trim();
};

const nonOverlappingEntities = (entities: Entity[]): Entity[] => {
  const result: Entity[] = [];
  let lastEnd = 0;
  for (const entity of entities) {
    if (entity.start < lastEnd) continue;
    result.push(entity);
    lastEnd = entity.end;
  }
  return result;
};

type MaskReplacementSpan = {
  start: number;
  end: number;
  replacement: string;
};

const removeRedactedMaskOverlaps = (
  replacements: MaskReplacementSpan[],
  redacted: Entity[],
): MaskReplacementSpan[] => {
  const result: MaskReplacementSpan[] = [];
  let redactedIndex = 0;
  for (const replacement of replacements) {
    while (true) {
      const candidate = redacted.at(redactedIndex);
      if (candidate === undefined || candidate.end > replacement.start) break;
      redactedIndex += 1;
    }
    const redactedEntity = redacted.at(redactedIndex);
    const overlaps =
      redactedEntity !== undefined &&
      redactedEntity.start < replacement.end &&
      replacement.start < redactedEntity.end;
    if (!overlaps) result.push(replacement);
  }
  return result;
};

/**
 * Build a stable mapping from entity text to numbered
 * placeholders. Same real-world value always maps to the
 * same placeholder (e.g., "Dr. Muller" and "Dr.  Muller"
 * share one person placeholder).
 *
 * Placeholder format: [LABEL_N] where LABEL is uppercase.
 * N is allocated per label and skips tokens already present
 * in reserved text.
 *
 * @param _ctx Unused. Kept for signature compatibility;
 *   coref alias links now travel on the entities
 *   themselves (`corefSourceText`).
 */
type PlaceholderMapOptions = {
  reservedText?: string;
};

export const buildPlaceholderMap = (
  entities: Entity[],
  _ctx: PipelineContext = defaultContext,
  { reservedText = "" }: PlaceholderMapOptions = {},
): Map<string, string> => {
  const counters = new Map<string, number>();
  const textLabelToPlaceholder = new Map<string, string>();
  const normalizedToPlaceholder = new Map<string, string>();
  const reservedPlaceholders = collectReservedPlaceholders(reservedText);

  const sorted = entities.toSorted((a, b) => a.start - b.start);

  for (const entity of sorted) {
    const compositeKey = `${entity.label}\0${entity.text}`;
    if (textLabelToPlaceholder.has(compositeKey)) {
      continue;
    }

    const labelKey = entity.label.toUpperCase().replace(WHITESPACE_RE, "_");

    // If this entity is a coref alias, unify its key
    // with the source entity's key so both get the same
    // number — in either direction: a backward alias
    // joins the source's existing placeholder, and a
    // forward alias (bare mention before the full form)
    // reserves its placeholder under the source key so
    // the source joins it when numbered later. The link
    // is carried on the entity itself, so it cannot be
    // lost between detection and redaction.
    const sourceText =
      entity.source === "coreference" ? entity.corefSourceText : undefined;
    const sourceNormalizedKey =
      sourceText === undefined
        ? undefined
        : `${labelKey}\0${normalizeEntityText(entity.label, sourceText)}`;
    if (sourceNormalizedKey !== undefined) {
      const sourceExisting = normalizedToPlaceholder.get(sourceNormalizedKey);
      if (sourceExisting) {
        textLabelToPlaceholder.set(compositeKey, sourceExisting);
        continue;
      }
    }

    const normalized = normalizeEntityText(entity.label, entity.text);
    const normalizedKey = `${labelKey}\0${normalized}`;
    const existing = normalizedToPlaceholder.get(normalizedKey);
    if (existing) {
      textLabelToPlaceholder.set(compositeKey, existing);
      if (sourceNormalizedKey !== undefined) {
        normalizedToPlaceholder.set(sourceNormalizedKey, existing);
      }
      continue;
    }

    const placeholder = nextPlaceholder(
      labelKey,
      counters,
      reservedPlaceholders,
    );
    textLabelToPlaceholder.set(compositeKey, placeholder);
    normalizedToPlaceholder.set(normalizedKey, placeholder);
    if (sourceNormalizedKey !== undefined) {
      normalizedToPlaceholder.set(sourceNormalizedKey, placeholder);
    }
  }

  return textLabelToPlaceholder;
};

/**
 * Apply redactions to the source text, replacing each
 * confirmed entity span using the configured operator.
 *
 * Co-references are consistent: if the same text appears
 * multiple times, all occurrences get the same placeholder.
 *
 * @param ctx Pipeline context. Must be the same instance
 *   passed to `runPipeline` (or `findCoreferenceSpans`)
 *   so coreference placeholder links are preserved.
 *   Defaults to `defaultContext` for single-tenant usage.
 */
export const redactText = (
  fullText: string,
  entities: Entity[],
  config: OperatorConfig = DEFAULT_OPERATOR_CONFIG,
  ctx: PipelineContext = defaultContext,
): RedactionResult => {
  if (entities.length === 0) {
    return {
      redactedText: fullText,
      redactionMap: new Map(),
      operatorMap: new Map(),
      entityCount: 0,
    };
  }

  const placeholderMap = buildPlaceholderMap(entities, ctx, {
    reservedText: fullText,
  });

  const sorted = entities.toSorted((a, b) => a.start - b.start);

  const kept: Entity[] = [];
  const masked: Entity[] = [];
  const redacted: Entity[] = [];
  for (const entity of sorted) {
    const opType = operatorType(resolveOperator(config, entity.label));
    if (opType === "keep") {
      kept.push(entity);
    } else if (opType === "mask") {
      masked.push(entity);
    } else {
      redacted.push(entity);
    }
  }
  const selectedKept = nonOverlappingEntities(kept);
  const selectedMasked = nonOverlappingEntities(masked);
  const selectedRedacted = nonOverlappingEntities(redacted);

  const maskReplacements: MaskReplacementSpan[] = [];
  for (const entity of selectedMasked) {
    const selection = resolveOperator(config, entity.label);
    const sourceText = fullText.slice(entity.start, entity.end);
    for (const replacement of maskReplacementSpans(
      sourceText,
      requireMaskSelection(selection),
    )) {
      maskReplacements.push({
        start: entity.start + replacement.start,
        end: entity.start + replacement.end,
        replacement: replacement.replacement,
      });
    }
  }
  const visibleMaskReplacements = removeRedactedMaskOverlaps(
    maskReplacements,
    selectedRedacted,
  );

  const parts: string[] = [];
  const redactionMap = new Map<string, string>();
  const operatorMap = new Map<string, OperatorType>();
  let cursor = 0;

  const placeholderFor = (entity: Entity): string =>
    placeholderMap.get(`${entity.label}\0${entity.text}`) ??
    `[${entity.label.toUpperCase().replace(/\s+/g, "_")}]`;
  const processed = [
    ...selectedKept,
    ...selectedMasked,
    ...selectedRedacted,
  ].toSorted((a, b) => a.start - b.start);
  for (const entity of processed) {
    operatorMap.set(
      placeholderFor(entity),
      operatorType(resolveOperator(config, entity.label)),
    );
  }

  let redactedIndex = 0;
  let maskIndex = 0;
  while (
    redactedIndex < selectedRedacted.length ||
    maskIndex < visibleMaskReplacements.length
  ) {
    const redactedEntity = selectedRedacted.at(redactedIndex);
    const maskReplacement = visibleMaskReplacements.at(maskIndex);
    const useRedacted =
      redactedEntity !== undefined &&
      (maskReplacement === undefined ||
        redactedEntity.start <= maskReplacement.start);
    const start = useRedacted
      ? (redactedEntity?.start ?? cursor)
      : (maskReplacement?.start ?? cursor);
    const end = useRedacted
      ? (redactedEntity?.end ?? start)
      : (maskReplacement?.end ?? start);
    if (start > cursor) parts.push(fullText.slice(cursor, start));

    if (!useRedacted && maskReplacement !== undefined) {
      parts.push(maskReplacement.replacement);
      cursor = end;
      maskIndex += 1;
      continue;
    }
    if (redactedEntity === undefined) break;

    const entity = redactedEntity;
    const placeholder = placeholderFor(entity);

    const selection = resolveOperator(config, entity.label);
    const opType = operatorType(selection);
    const operator = OPERATOR_REGISTRY[opType];

    const replacement = operator.apply(
      entity.text,
      entity.label,
      placeholder,
      config.redactString,
      selection,
    );

    parts.push(replacement);
    // Only populate redactionMap for reversible operators.
    // A coref alias contributes its source's full text, so
    // a forward alias ("Acme" before "Acme Corporation")
    // cannot pin the shortened surface form as the key's
    // canonical value for the shared placeholder.
    if (
      operator.reversibility === "reversible" &&
      !redactionMap.has(placeholder)
    ) {
      redactionMap.set(
        placeholder,
        entity.source === "coreference" ? entity.corefSourceText : entity.text,
      );
    }

    cursor = end;
    redactedIndex += 1;
  }

  if (cursor < fullText.length) {
    parts.push(fullText.slice(cursor));
  }

  return {
    redactedText: parts.join(""),
    redactionMap,
    operatorMap,
    entityCount:
      selectedKept.length + selectedMasked.length + selectedRedacted.length,
  };
};

/**
 * Serialize the redaction key to JSON for export.
 * Includes operator metadata so the export is self-describing.
 */
export const exportRedactionKey = (
  redactionMap: Map<string, string>,
  operatorMap: Map<string, OperatorType>,
): string => {
  const entries: Record<string, { original: string; operator: OperatorType }> =
    {};

  for (const [placeholder, value] of redactionMap) {
    entries[placeholder] = {
      original: value,
      operator: operatorMap.get(placeholder) ?? "replace",
    };
  }

  return JSON.stringify({ entries }, null, 2);
};

/**
 * De-anonymise text using a redaction key.
 * Replaces placeholders back with original values.
 * Only works for reversible operators (replace).
 */
export const deanonymise = (
  redactedText: string,
  redactionMap: Map<string, string>,
): string => {
  let result = redactedText;

  for (const [placeholder, original] of redactionMap) {
    result = result.replaceAll(placeholder, original);
  }

  return result;
};
