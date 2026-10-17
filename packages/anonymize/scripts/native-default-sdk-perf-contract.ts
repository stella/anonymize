import {
  arrayOf,
  isBoolean,
  isNumber,
  isRecord,
  isString,
  literalUnion,
  objectOf,
  oneOf,
} from "../src/native-json-codec";

const isNull = (value: unknown): value is null => value === null;
const isCount = (value: unknown): value is number =>
  isNumber(value) && Number.isSafeInteger(value) && value >= 0;
const isMilliseconds = (value: unknown): value is number =>
  isNumber(value) && value >= 0;
const summary = objectOf({
  minMs: isMilliseconds,
  p50Ms: isMilliseconds,
  p95Ms: isMilliseconds,
  maxMs: isMilliseconds,
});
const timing = objectOf({
  fixture: isString,
  coldMs: isMilliseconds,
  warmAvgMs: isMilliseconds,
  entityCount: isCount,
  redactedTextLength: isCount,
});
const signature = objectOf({
  fixture: isString,
  signature: (value: unknown): value is string =>
    isString(value) && /^[a-f0-9]{16}$/u.test(value),
});
const workerResult = objectOf({
  event: literalUnion({ "native-default-sdk-perf-worker": true }),
  language: oneOf(isString, isNull),
  preload: isBoolean,
  packageBytes: isCount,
  fixtureCount: isCount,
  loadMs: isMilliseconds,
  warmupMs: isMilliseconds,
  prepareMs: isMilliseconds,
  runMs: isMilliseconds,
  warmAvgMs: isMilliseconds,
  prepareTopStages: arrayOf(isRecord),
  prepareTopSlots: arrayOf(isRecord),
  warmupTopStages: arrayOf(isRecord),
  warmupTopSlots: arrayOf(isRecord),
  runProfile: oneOf(isRecord, isNull),
  fixtureTimings: objectOf({
    cold: summary,
    warm: summary,
    byFixture: arrayOf(timing),
  }),
  runTopFixtures: arrayOf(
    objectOf({
      fixture: isString,
      ms: isMilliseconds,
      entityCount: isCount,
      redactedTextLength: isCount,
    }),
  ),
  fixtureSignatures: arrayOf(signature),
});

/** Validate either worker implementation before aggregating measurements. */
export const parseNativeDefaultSdkWorkerResult = (value: unknown) => {
  if (!workerResult(value))
    throw new TypeError("Invalid native default SDK benchmark worker result");
  return value;
};
export type NativeDefaultSdkWorkerResult = ReturnType<
  typeof parseNativeDefaultSdkWorkerResult
>;

/** Diagnostics from both supported native envelopes remain opaque report data. */
export const parseNativeDefaultSdkDiagnosticEvents = (text: string | null) => {
  if (text === null) return [];
  const value: unknown = JSON.parse(text);
  if (!isRecord(value))
    throw new TypeError("Invalid native benchmark diagnostics envelope");
  const nested = isRecord(value["diagnostics"])
    ? value["diagnostics"]
    : undefined;
  const events = value["events"] ?? nested?.["events"];
  if (events === undefined) return [];
  if (!arrayOf(isRecord)(events))
    throw new TypeError("Invalid native benchmark diagnostic events");
  return events;
};

type ProcessFailure = { error?: unknown; stdout: unknown; stderr: unknown };
/** Node can leave output null when process creation itself fails. */
export const nativeDefaultSdkProcessFailure = ({
  error,
  stdout,
  stderr,
}: ProcessFailure) =>
  [
    error instanceof Error ? error.message : undefined,
    typeof stdout === "string" ? stdout.trim() : undefined,
    typeof stderr === "string" ? stderr.trim() : undefined,
  ].filter(
    (message): message is string => message !== undefined && message.length > 0,
  );
