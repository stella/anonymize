/**
 * Runtime-free constants for the anonymization pipeline.
 *
 * This module is the SSR-safe / browser-safe entrypoint:
 * importing it must not pull in `@stll/anonymize-wasm`
 * or any other runtime-bearing module.
 * Consumers that only need the static label list,
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
  gazetteer: 5,
  trigger: 4,
  "legal-form": 3,
  regex: 3,
  country: 3,
  "deny-list": 2,
  coreference: 2,
  ner: 1,
} as const;

// Declaration emit cannot carry `satisfies`; this typed alias performs that check.
const DETECTOR_PRIORITY_IS_TOTAL: Readonly<Record<DetectionSource, number>> =
  DETECTOR_PRIORITY;
void DETECTOR_PRIORITY_IS_TOTAL;

/**
 * Anonymization operator types. Each operator defines
 * how a confirmed entity is replaced in the output.
 */
export const OPERATOR_TYPES = ["replace", "redact", "keep", "mask"] as const;

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
    selection: "default",
    detectionSources: ["trigger", "regex", "deny-list", "coreference"],
  },
  {
    label: "organization",
    selection: "default",
    detectionSources: [
      "trigger",
      "deny-list",
      "legal-form",
      "gazetteer",
      "coreference",
    ],
  },
  {
    label: "phone number",
    selection: "default",
    detectionSources: ["regex", "trigger"],
  },
  {
    label: "address",
    selection: "default",
    detectionSources: ["regex", "trigger", "deny-list"],
  },
  {
    label: "country",
    selection: "default",
    detectionSources: ["country"],
  },
  {
    label: "email address",
    selection: "default",
    detectionSources: ["regex"],
  },
  {
    label: "date",
    selection: "default",
    detectionSources: ["regex", "trigger"],
  },
  {
    label: "date of birth",
    selection: "default",
    detectionSources: ["trigger"],
  },
  {
    label: "bank account number",
    selection: "default",
    detectionSources: ["regex", "trigger"],
  },
  {
    label: "iban",
    selection: "default",
    detectionSources: ["regex", "trigger"],
  },
  {
    label: "tax identification number",
    selection: "default",
    detectionSources: ["regex", "trigger"],
  },
  {
    label: "identity card number",
    selection: "default",
    detectionSources: ["regex", "trigger"],
  },
  {
    label: "birth number",
    selection: "default",
    detectionSources: ["regex", "trigger"],
  },
  {
    label: "national identification number",
    selection: "default",
    detectionSources: ["regex", "trigger"],
  },
  {
    label: "social security number",
    selection: "default",
    detectionSources: ["regex", "trigger"],
  },
  {
    label: "registration number",
    selection: "default",
    detectionSources: ["regex", "trigger"],
  },
  {
    label: "case number",
    selection: "default",
    detectionSources: ["regex", "trigger"],
  },
  {
    label: "credit card number",
    selection: "default",
    detectionSources: ["regex"],
  },
  {
    label: "passport number",
    selection: "default",
    detectionSources: ["regex", "trigger"],
  },
  {
    label: "crypto",
    selection: "default",
    detectionSources: ["regex"],
  },
  {
    label: "monetary amount",
    selection: "default",
    detectionSources: ["regex", "trigger"],
  },
  {
    label: "land parcel",
    selection: "default",
    detectionSources: ["trigger"],
  },
  {
    label: "misc",
    selection: "default",
    detectionSources: ["regex", "deny-list"],
  },
  {
    label: "ip address",
    selection: "opt-in",
    detectionSources: ["regex"],
  },
  {
    label: "mac address",
    selection: "opt-in",
    detectionSources: ["regex"],
  },
  {
    label: "url",
    selection: "opt-in",
    detectionSources: ["regex"],
  },
] as const;

// Declaration emit cannot carry `satisfies`; this typed alias performs that check.
const ENTITY_CAPABILITIES_ARE_VALID: readonly EntityCapability[] =
  ENTITY_CAPABILITIES;
void ENTITY_CAPABILITIES_ARE_VALID;

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
