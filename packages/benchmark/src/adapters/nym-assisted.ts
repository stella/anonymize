import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import {
  convert_external_detection_batch,
  createNativePipelineFromConfig,
  EXTERNAL_DETECTION_BATCH_VERSION,
  loadNativeAnonymizeBinding,
  type ExternalDetectionBatch,
  type NativeCallerDetection,
  type PreparedNativePipeline,
} from "@stll/anonymize";

import type { GroundTruthDocument } from "../ground-truth";
import { loadStllBenchmarkConfig } from "./stella";
import {
  type Adapter,
  type AdapterOutcome,
  type NativePrediction,
  totalUtf16CodeUnits,
} from "./types";

const require = createRequire(import.meta.url);
const stellaVersion = (
  require("@stll/anonymize/package.json") as { version: string }
).version;

const PACKAGE_ROOT = join(import.meta.dir, "..", "..");
const PYTHON_BIN = join(PACKAGE_ROOT, ".venv-nym", "bin", "python");
const ADAPTER_SCRIPT = join(PACKAGE_ROOT, "python", "nym_adapter.py");
const TIMEOUT_MS = 30 * 60 * 1000;

export const NYM_MODEL_REPO = "Wismut/nym-pii-multilingual-small";
export const NYM_MODEL_REVISION = "4348999cd3c2e20c49615e9af7c6bbb45b64cd85";
export const NYM_PROVIDER_ID = "wismut-nym-pii-multilingual-small-int8";
export const NYM_PROVIDER_VERSION = `${NYM_MODEL_REPO}@${NYM_MODEL_REVISION}/int8`;

/**
 * Deliberately narrow PII mapping. Nym's age, gender, time, URL, credentials,
 * network identifiers and other unsupported concepts are not relabelled as a
 * vaguely similar legal entity merely to improve a label-agnostic score.
 */
export const NYM_LABEL_MAP = {
  ACCOUNT_NUMBER: "bank account number",
  BUILDING_NUMBER: "address",
  CITY: "address",
  COMPANY_NAME: "organization",
  COUNTRY: "country",
  CREDIT_DEBIT_CARD: "credit card number",
  DATE: "date",
  DATE_OF_BIRTH: "date of birth",
  DRIVERS_LICENSE: "identity card number",
  EMAIL: "email address",
  FAX_NUMBER: "phone number",
  GIVEN_NAME: "person",
  GOVERNMENT_ID: "national identification number",
  IBAN: "iban",
  PASSPORT: "passport number",
  PHONE: "phone number",
  SECONDARY_ADDRESS: "address",
  SSN: "social security number",
  STATE: "address",
  STREET_ADDRESS: "address",
  STREET_NAME: "address",
  SURNAME: "person",
  TAX_ID: "tax identification number",
  ZIP_CODE: "address",
} as const satisfies Record<string, string>;

type NymDetection = {
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly score: number;
};

type NymResult = {
  readonly version: string;
  readonly initSeconds: number;
  readonly coldSeconds: number;
  readonly warmSeconds: number;
  readonly results: readonly {
    readonly id: string;
    readonly detections: readonly NymDetection[];
  }[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const protocolError = (message: string): never => {
  throw new Error(`Nym adapter protocol error: ${message}`);
};

const finiteNonnegative = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return protocolError(`${field} must be a finite nonnegative number`);
  }
  return value;
};

export const parseNymResult = (value: unknown): NymResult => {
  if (!isRecord(value)) {
    return protocolError("root must be an object");
  }
  const allowedRootKeys = new Set([
    "version",
    "initSeconds",
    "coldSeconds",
    "warmSeconds",
    "results",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedRootKeys.has(key)) {
      return protocolError(`root contains unexpected field ${key}`);
    }
  }
  if (value["version"] !== NYM_PROVIDER_VERSION) {
    return protocolError("provider version does not match the pinned model");
  }
  if (!Array.isArray(value["results"])) {
    return protocolError("results must be an array");
  }
  const results = value["results"].map((result) => {
    if (
      !isRecord(result) ||
      typeof result["id"] !== "string" ||
      result["id"].length === 0
    ) {
      return protocolError("result must contain a string id");
    }
    if (
      Object.keys(result).some((key) => key !== "id" && key !== "detections")
    ) {
      return protocolError("result contains an unexpected field");
    }
    if (!Array.isArray(result["detections"])) {
      return protocolError("result detections must be an array");
    }
    const detections = result["detections"].map((detection) => {
      if (!isRecord(detection)) {
        return protocolError("detection must be an object");
      }
      if (
        Object.keys(detection).some(
          (key) => !["start", "end", "label", "score"].includes(key),
        )
      ) {
        return protocolError("detection contains an unexpected field");
      }
      const { start, end, label, score } = detection;
      if (
        typeof start !== "number" ||
        !Number.isInteger(start) ||
        start < 0 ||
        typeof end !== "number" ||
        !Number.isInteger(end) ||
        end <= start
      ) {
        return protocolError("detection offsets must be increasing integers");
      }
      if (typeof label !== "string" || label.length === 0) {
        return protocolError("detection label must be nonempty");
      }
      if (
        typeof score !== "number" ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 1
      ) {
        return protocolError("detection score must be between zero and one");
      }
      return { start, end, label, score };
    });
    return { id: result["id"], detections };
  });
  return {
    version: value["version"],
    initSeconds: finiteNonnegative(value["initSeconds"], "initSeconds"),
    coldSeconds: finiteNonnegative(value["coldSeconds"], "coldSeconds"),
    warmSeconds: finiteNonnegative(value["warmSeconds"], "warmSeconds"),
    results,
  };
};

type MappedDetection = NymDetection & { readonly entityLabel: string };

/** Merge adjacent provider fragments only after they map to the same entity. */
export const mapNymDetections = (
  text: string,
  detections: readonly NymDetection[],
): MappedDetection[] => {
  const codePoints: string[] = [];
  for (const codePoint of text) codePoints.push(codePoint);
  const mapped = detections
    .map((detection): MappedDetection | undefined => {
      if (detection.end > codePoints.length) {
        return protocolError("detection falls outside its document");
      }
      const entityLabel =
        NYM_LABEL_MAP[detection.label as keyof typeof NYM_LABEL_MAP];
      return entityLabel === undefined
        ? undefined
        : { ...detection, entityLabel };
    })
    .filter(
      (detection): detection is MappedDetection => detection !== undefined,
    )
    .sort((left, right) => left.start - right.start || right.end - left.end);

  const merged: MappedDetection[] = [];
  for (const detection of mapped) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      previous.entityLabel === detection.entityLabel &&
      detection.start >= previous.end &&
      codePoints.slice(previous.end, detection.start).join("").trim() === ""
    ) {
      merged[merged.length - 1] = {
        ...previous,
        end: detection.end,
        score: Math.min(previous.score, detection.score),
      };
    } else {
      merged.push(detection);
    }
  }
  return merged;
};

export const buildNymExternalDetectionBatch = (
  text: string,
  detections: readonly NymDetection[],
): ExternalDetectionBatch => {
  const document = new TextEncoder().encode(text);
  const mapped = mapNymDetections(text, detections);
  const providerLabels = [...new Set(mapped.map(({ label }) => label))].sort();
  return {
    version: EXTERNAL_DETECTION_BATCH_VERSION,
    document: {
      sha256: createHash("sha256").update(document).digest("hex"),
    },
    offsetUnit: "unicode-code-point",
    provider: {
      id: NYM_PROVIDER_ID,
      name: "Nym PII multilingual small (int8)",
      version: NYM_PROVIDER_VERSION,
    },
    labelMap: providerLabels.map((providerLabel) => ({
      providerLabel,
      entityLabel:
        NYM_LABEL_MAP[providerLabel as keyof typeof NYM_LABEL_MAP] ??
        protocolError(`missing mapped label ${providerLabel}`),
    })),
    detections: mapped.map(({ start, end, label, score }, index) => ({
      id: `nym-${index + 1}`,
      start,
      end,
      label,
      score,
    })),
  };
};

const predictionsFromPipeline = (
  binding: ReturnType<typeof loadNativeAnonymizeBinding>,
  pipeline: PreparedNativePipeline,
  doc: GroundTruthDocument,
  detections: readonly NymDetection[],
): NativePrediction[] => {
  const document = new TextEncoder().encode(doc.text);
  const batch = buildNymExternalDetectionBatch(doc.text, detections);
  const callerDetections: NativeCallerDetection[] =
    convert_external_detection_batch(document, batch, { binding });
  return pipeline
    .redactTextWithCallerDetections(doc.text, { detections: callerDetections })
    .resolvedEntities.map(({ start, end, label, text }) => ({
      start,
      end,
      label,
      text,
    }));
};

const runNymProcess = async (
  docs: readonly GroundTruthDocument[],
): Promise<NymResult> => {
  const proc = Bun.spawn([PYTHON_BIN, ADAPTER_SCRIPT], {
    stdin: new TextEncoder().encode(
      JSON.stringify({
        docs: docs.map(({ id, language, text }) => ({ id, language, text })),
      }),
    ),
    stdout: "pipe",
    stderr: "pipe",
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const tail = stderr.trim().split("\n").slice(-5).join(" | ");
    throw new Error(`Nym adapter crashed (exit ${exitCode}): ${tail}`);
  }
  try {
    return parseNymResult(JSON.parse(stdout));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Nym adapter emitted an invalid result: ${detail}`);
  }
};

export const createNymAssistedStellaAdapter = (): Adapter => ({
  name: "stella+nym-pii",
  version: `${stellaVersion} + ${NYM_PROVIDER_VERSION}`,
  run: async (
    docs: readonly GroundTruthDocument[],
  ): Promise<AdapterOutcome> => {
    if (!existsSync(PYTHON_BIN)) {
      return {
        status: "unavailable",
        reason:
          "optional .venv-nym is missing; create it using the pinned commands in REPRODUCING.md",
      };
    }
    if (docs.some(({ language }) => language.trim().toLowerCase() !== "de")) {
      throw new Error(
        "stella+nym-pii assisted lane accepts German documents only",
      );
    }

    const stellaInitStart = performance.now();
    const binding = loadNativeAnonymizeBinding();
    const pipeline = await createNativePipelineFromConfig({
      binding,
      config: await loadStllBenchmarkConfig("de"),
      gazetteerEntries: [],
    });
    const stellaInitSeconds = (performance.now() - stellaInitStart) / 1000;
    const nym = await runNymProcess(docs);

    const detectionsById = new Map<string, readonly NymDetection[]>();
    for (const { id, detections } of nym.results) {
      if (detectionsById.has(id)) {
        throw new Error(`Nym adapter duplicated document ${id}`);
      }
      detectionsById.set(id, detections);
    }
    if (
      nym.results.length !== docs.length ||
      detectionsById.size !== docs.length
    ) {
      throw new Error(
        "Nym adapter omitted or duplicated one or more documents",
      );
    }
    const predictions = new Map<string, readonly NativePrediction[]>();
    const fusionColdStart = performance.now();
    for (const doc of docs) {
      const detections = detectionsById.get(doc.id);
      if (detections === undefined) {
        throw new Error(`Nym adapter omitted document ${doc.id}`);
      }
      predictions.set(
        doc.id,
        predictionsFromPipeline(binding, pipeline, doc, detections),
      );
    }
    const fusionColdSeconds = (performance.now() - fusionColdStart) / 1000;

    const fusionWarmStart = performance.now();
    for (const doc of docs) {
      predictionsFromPipeline(
        binding,
        pipeline,
        doc,
        detectionsById.get(doc.id) ?? [],
      );
    }
    const fusionWarmSeconds = (performance.now() - fusionWarmStart) / 1000;

    return {
      status: "ok",
      predictions,
      timing: {
        initSeconds: stellaInitSeconds + nym.initSeconds,
        coldSeconds: nym.coldSeconds + fusionColdSeconds,
        warmSeconds: nym.warmSeconds + fusionWarmSeconds,
        totalChars: totalUtf16CodeUnits(docs),
      },
      reportedVersion: `${stellaVersion} + ${nym.version}`,
      notes:
        "opt-in local ONNX PII assistance; non-PII legal entity classes intentionally remain Stella-only",
    };
  },
});
