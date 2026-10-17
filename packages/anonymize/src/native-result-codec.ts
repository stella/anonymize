import type {
  NativeBindingRedactionEntry,
  NativeBindingOperatorEntry,
  CanonicalPipelineEntity,
  CanonicalStaticRedactionResult,
  CanonicalSessionMetadata,
  CanonicalSessionDeletionSummary,
  CanonicalSessionRedactionPlanResult,
  NativeSessionStatus,
} from "./native";
import { OPERATOR_TYPES, type OperatorType } from "./constants";
import {
  arrayOf,
  isNumber,
  isString,
  objectOf,
  oneOf,
  literalUnion,
  optional,
  type Fields,
} from "./native-json-codec";

const isNull = (value: unknown) => value === null;
const isOperatorType = (value: unknown): value is OperatorType =>
  OPERATOR_TYPES.some((operator) => value === operator);

const checkNativeBindingRedactionEntry = objectOf({
  placeholder: isString,
  original: isString,
} satisfies Fields<NativeBindingRedactionEntry>);
const isNativeBindingRedactionEntry = (
  value: unknown,
): value is NativeBindingRedactionEntry =>
  checkNativeBindingRedactionEntry(value);

const checkNativeBindingOperatorEntry = objectOf({
  placeholder: isString,
  operator: isOperatorType,
} satisfies Fields<NativeBindingOperatorEntry>);
const isNativeBindingOperatorEntry = (
  value: unknown,
): value is NativeBindingOperatorEntry =>
  checkNativeBindingOperatorEntry(value);

const checkCanonicalPipelineEntity = objectOf({
  start: isNumber,
  end: isNumber,
  label: isString,
  text: isString,
  score: isNumber,
  source: isString,
  source_detail: optional(oneOf(isString, isNull)),
  provider_id: optional(oneOf(isString, isNull)),
  detection_id: optional(oneOf(isString, isNull)),
} satisfies Fields<CanonicalPipelineEntity>);
const isCanonicalPipelineEntity = (
  value: unknown,
): value is CanonicalPipelineEntity => checkCanonicalPipelineEntity(value);

const checkCanonicalStaticRedactionResult = objectOf({
  resolved_entities: arrayOf((value: unknown) =>
    isCanonicalPipelineEntity(value),
  ),
  redaction: objectOf({
    redacted_text: isString,
    redaction_map: arrayOf((value: unknown) =>
      isNativeBindingRedactionEntry(value),
    ),
    operator_map: arrayOf((value: unknown) =>
      isNativeBindingOperatorEntry(value),
    ),
    entity_count: isNumber,
  } satisfies Fields<CanonicalStaticRedactionResult["redaction"]>),
} satisfies Fields<CanonicalStaticRedactionResult>);
const isCanonicalStaticRedactionResult = (
  value: unknown,
): value is CanonicalStaticRedactionResult =>
  checkCanonicalStaticRedactionResult(value);

const checkCanonicalSessionMetadata = objectOf({
  session_id: isString,
  created_at_epoch_seconds: oneOf(isNumber, isNull),
  expires_at_epoch_seconds: oneOf(isNumber, isNull),
  mapping_count: isNumber,
  status: (value: unknown) => isNativeSessionStatus(value),
} satisfies Fields<CanonicalSessionMetadata>);
const isCanonicalSessionMetadata = (
  value: unknown,
): value is CanonicalSessionMetadata => checkCanonicalSessionMetadata(value);

const checkCanonicalSessionDeletionSummary = objectOf({
  session_id: isString,
  deleted_mapping_count: isNumber,
} satisfies Fields<CanonicalSessionDeletionSummary>);
const isCanonicalSessionDeletionSummary = (
  value: unknown,
): value is CanonicalSessionDeletionSummary =>
  checkCanonicalSessionDeletionSummary(value);

const checkCanonicalSessionRedactionPlanResult = objectOf({
  replacements: arrayOf(
    objectOf({
      start: isNumber,
      end: isNumber,
      replacement: isString,
    } satisfies Fields<
      CanonicalSessionRedactionPlanResult["replacements"][number]
    >),
  ),
  entity_count: isNumber,
  caller_entity_count: isNumber,
} satisfies Fields<CanonicalSessionRedactionPlanResult>);
const isCanonicalSessionRedactionPlanResult = (
  value: unknown,
): value is CanonicalSessionRedactionPlanResult =>
  checkCanonicalSessionRedactionPlanResult(value);

const checkNativeSessionStatus = literalUnion({
  active: true,
  not_yet_active: true,
  expired: true,
  deleted: true,
} satisfies Record<NativeSessionStatus, true>);
const isNativeSessionStatus = (value: unknown): value is NativeSessionStatus =>
  checkNativeSessionStatus(value);

export const parseCanonicalStaticRedactionResult = (
  json: string,
): CanonicalStaticRedactionResult => {
  const value: unknown = JSON.parse(json);
  if (!isCanonicalStaticRedactionResult(value))
    throw new TypeError("Invalid native CanonicalStaticRedactionResult");
  return value;
};

export const parseCanonicalSessionMetadata = (
  json: string,
): CanonicalSessionMetadata => {
  const value: unknown = JSON.parse(json);
  if (!isCanonicalSessionMetadata(value))
    throw new TypeError("Invalid native CanonicalSessionMetadata");
  return value;
};

export const parseCanonicalSessionDeletionSummary = (
  json: string,
): CanonicalSessionDeletionSummary => {
  const value: unknown = JSON.parse(json);
  if (!isCanonicalSessionDeletionSummary(value))
    throw new TypeError("Invalid native CanonicalSessionDeletionSummary");
  return value;
};

export const parseCanonicalSessionRedactionPlanResult = (
  json: string,
): CanonicalSessionRedactionPlanResult[] => {
  const value: unknown = JSON.parse(json);
  if (!isCanonicalSessionRedactionPlanResults(value))
    throw new TypeError("Invalid native CanonicalSessionRedactionPlanResult");
  return value;
};

const isCanonicalSessionRedactionPlanResults = (
  value: unknown,
): value is CanonicalSessionRedactionPlanResult[] =>
  arrayOf(isCanonicalSessionRedactionPlanResult)(value);

type ExternalDetection = {
  start: number;
  end: number;
  label: string;
  score: number;
  provider_id: string;
  detection_id: string;
};
const checkExternalDetection = objectOf({
  start: isNumber,
  end: isNumber,
  label: isString,
  score: isNumber,
  provider_id: isString,
  detection_id: isString,
} satisfies Fields<ExternalDetection>);
const isExternalDetections = (value: unknown): value is ExternalDetection[] =>
  arrayOf(checkExternalDetection)(value);
export const parseExternalDetections = (json: string): ExternalDetection[] => {
  const value: unknown = JSON.parse(json);
  if (!isExternalDetections(value))
    throw new TypeError("Invalid native external detections");
  return value;
};
