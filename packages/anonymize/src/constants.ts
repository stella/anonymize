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
  COUNTRY: "country",
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
  [DETECTION_SOURCES.COUNTRY]: 3,
  [DETECTION_SOURCES.DENY_LIST]: 2,
  [DETECTION_SOURCES.COREFERENCE]: 2,
  [DETECTION_SOURCES.NER]: 1,
} as const satisfies Record<DetectionSource, number>;

/**
 * Anonymization operator types. Each operator defines
 * how a confirmed entity is replaced in the output.
 */
export const OPERATOR_TYPES = ["replace", "redact", "keep"] as const;

export type OperatorType = (typeof OPERATOR_TYPES)[number];

export const ENTITY_SELECTIONS = {
  DEFAULT: "default",
  OPT_IN: "opt-in",
} as const;

export type EntitySelection =
  (typeof ENTITY_SELECTIONS)[keyof typeof ENTITY_SELECTIONS];

export type EntityCapability = {
  label: string;
  selection: EntitySelection;
  detectionSources: readonly DetectionSource[];
};

/**
 * Canonical entity capabilities exposed by the deterministic native pipeline.
 * `selection` describes whether the default package requests the label; opt-in
 * labels have built-in detection rules but must be requested explicitly.
 *
 * These labels are ephemeral: entities are regenerated on
 * every pipeline run and never persisted to the database.
 * Renaming a label here requires no migration.
 */
export const ENTITY_CAPABILITIES = [
  {
    label: "person",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [
      DETECTION_SOURCES.TRIGGER,
      DETECTION_SOURCES.REGEX,
      DETECTION_SOURCES.DENY_LIST,
      DETECTION_SOURCES.COREFERENCE,
    ],
  },
  {
    label: "organization",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [
      DETECTION_SOURCES.TRIGGER,
      DETECTION_SOURCES.DENY_LIST,
      DETECTION_SOURCES.LEGAL_FORM,
      DETECTION_SOURCES.GAZETTEER,
      DETECTION_SOURCES.COREFERENCE,
    ],
  },
  {
    label: "phone number",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX, DETECTION_SOURCES.TRIGGER],
  },
  {
    label: "address",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [
      DETECTION_SOURCES.REGEX,
      DETECTION_SOURCES.TRIGGER,
      DETECTION_SOURCES.DENY_LIST,
    ],
  },
  {
    label: "country",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.COUNTRY],
  },
  {
    label: "email address",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX],
  },
  {
    label: "date",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX, DETECTION_SOURCES.TRIGGER],
  },
  {
    label: "date of birth",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.TRIGGER],
  },
  {
    label: "bank account number",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX, DETECTION_SOURCES.TRIGGER],
  },
  {
    label: "iban",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX, DETECTION_SOURCES.TRIGGER],
  },
  {
    label: "tax identification number",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX, DETECTION_SOURCES.TRIGGER],
  },
  {
    label: "identity card number",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX, DETECTION_SOURCES.TRIGGER],
  },
  {
    label: "birth number",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX, DETECTION_SOURCES.TRIGGER],
  },
  {
    label: "national identification number",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX, DETECTION_SOURCES.TRIGGER],
  },
  {
    label: "social security number",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX, DETECTION_SOURCES.TRIGGER],
  },
  {
    label: "registration number",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX, DETECTION_SOURCES.TRIGGER],
  },
  {
    label: "credit card number",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX],
  },
  {
    label: "passport number",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX],
  },
  {
    label: "crypto",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX],
  },
  {
    label: "monetary amount",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX, DETECTION_SOURCES.TRIGGER],
  },
  {
    label: "land parcel",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.TRIGGER],
  },
  {
    label: "misc",
    selection: ENTITY_SELECTIONS.DEFAULT,
    detectionSources: [DETECTION_SOURCES.REGEX, DETECTION_SOURCES.DENY_LIST],
  },
  {
    label: "ip address",
    selection: ENTITY_SELECTIONS.OPT_IN,
    detectionSources: [DETECTION_SOURCES.REGEX],
  },
  {
    label: "mac address",
    selection: ENTITY_SELECTIONS.OPT_IN,
    detectionSources: [DETECTION_SOURCES.REGEX],
  },
  {
    label: "url",
    selection: ENTITY_SELECTIONS.OPT_IN,
    detectionSources: [DETECTION_SOURCES.REGEX],
  },
] as const satisfies readonly EntityCapability[];

type KnownEntityCapability = (typeof ENTITY_CAPABILITIES)[number];

export type EntityLabel = KnownEntityCapability["label"];

export const ENTITY_LABELS: readonly EntityLabel[] = ENTITY_CAPABILITIES.map(
  ({ label }) => label,
);

const isDefaultEntityCapability = (
  capability: KnownEntityCapability,
): capability is Extract<
  KnownEntityCapability,
  { selection: typeof ENTITY_SELECTIONS.DEFAULT }
> => capability.selection === ENTITY_SELECTIONS.DEFAULT;

export type DefaultEntityLabel = Extract<
  KnownEntityCapability,
  { selection: typeof ENTITY_SELECTIONS.DEFAULT }
>["label"];

export const DEFAULT_ENTITY_LABELS: readonly DefaultEntityLabel[] =
  ENTITY_CAPABILITIES.filter(isDefaultEntityCapability).map(
    ({ label }) => label,
  );
