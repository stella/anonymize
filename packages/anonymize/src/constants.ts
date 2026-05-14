/**
 * Runtime-free constants for the anonymization pipeline.
 *
 * This module is the SSR-safe / browser-safe entrypoint:
 * importing it must not pull in `@stll/text-search`,
 * `@stll/anonymize-wasm`, or any other runtime-bearing
 * module. Consumers that only need the static label list,
 * detection-source identifiers, or operator names import
 * from `@stll/anonymize/constants` (or
 * `@stll/anonymize-wasm/constants`) without paying the
 * wasm / regex-set startup cost.
 *
 * `types.ts` re-exports these for back-compat, so existing
 * `import { DEFAULT_ENTITY_LABELS } from "@stll/anonymize"`
 * call sites keep working.
 */

/**
 * Source of a detected entity span.
 * Ordered by detection layer in the pipeline.
 */
export const DETECTION_SOURCES = {
  TRIGGER: "trigger",
  REGEX: "regex",
  DENY_LIST: "deny-list",
  LEGAL_FORM: "legal-form",
  GAZETTEER: "gazetteer",
  NER: "ner",
  COREFERENCE: "coreference",
} as const;

export type DetectionSource =
  (typeof DETECTION_SOURCES)[keyof typeof DETECTION_SOURCES];

/**
 * Priority levels for detection sources.
 * Higher = more structurally reliable. Used during
 * overlap resolution so deterministic detectors beat
 * probabilistic ones regardless of raw score.
 */
export const DETECTOR_PRIORITY = {
  [DETECTION_SOURCES.GAZETTEER]: 5,
  [DETECTION_SOURCES.TRIGGER]: 4,
  [DETECTION_SOURCES.LEGAL_FORM]: 3,
  [DETECTION_SOURCES.REGEX]: 3,
  [DETECTION_SOURCES.DENY_LIST]: 2,
  [DETECTION_SOURCES.COREFERENCE]: 2,
  [DETECTION_SOURCES.NER]: 1,
} as const satisfies Record<DetectionSource, number>;

/**
 * Anonymization operator types. Each operator defines
 * how a confirmed entity is replaced in the output.
 */
export const OPERATOR_TYPES = ["replace", "redact"] as const;

export type OperatorType = (typeof OPERATOR_TYPES)[number];

/**
 * Canonical entity labels used across the pipeline.
 * NER models may use different native labels; the bench
 * NER wrapper maps model output to these canonical names.
 *
 * These labels are ephemeral: entities are regenerated on
 * every pipeline run and never persisted to the database.
 * Renaming a label here requires no migration.
 */
export const DEFAULT_ENTITY_LABELS = [
  "person",
  "organization",
  "phone number",
  "address",
  "email address",
  "date",
  "date of birth",
  "bank account number",
  "iban",
  "tax identification number",
  "identity card number",
  "birth number",
  "national identification number",
  "social security number",
  "registration number",
  "credit card number",
  "passport number",
  "monetary amount",
  "land parcel",
  "misc",
] as const;
