import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const SEALED_AGGREGATE_REPORT_SCHEMA_VERSION = 1 as const;

export type TabAggregateMetrics = {
  readonly type: "tab-independent-annotator-span-redaction";
  readonly documents: number;
  readonly directMentions: number;
  readonly quasiMentions: number;
  readonly directMentionRecall: number;
  readonly quasiMentionRecall: number;
  readonly allMentionRecall: number;
  readonly entityRecall: number;
  readonly characterPrecision: number;
  readonly characterRecall: number;
  readonly predictedSpans: number;
};

export type RedactionBenchAggregateMetrics = {
  readonly type: "redactionbench-transparent-interim";
  readonly documents: number;
  readonly mandatorySpans: number;
  readonly mandatorySpanRecall: number;
  readonly mandatoryCharacterRecall: number;
  readonly acceptedCharacterPrecision: number;
  readonly predictedSpans: number;
};

export type MeddocanAggregateMetrics = {
  readonly type: "label-agnostic-span-redaction";
  readonly spanRecall: number;
  readonly characterRecall: number;
  readonly characterPrecision: number;
  readonly goldSpans: number;
};

export type SealedAggregateMetrics =
  | TabAggregateMetrics
  | RedactionBenchAggregateMetrics
  | MeddocanAggregateMetrics;

export type SealedLibraryResult =
  | {
      readonly name: string;
      readonly version: string;
      readonly status: "ok";
      readonly elapsedSeconds: number;
      readonly metrics: SealedAggregateMetrics;
    }
  | {
      readonly name: string;
      readonly version: string;
      readonly status: "unavailable";
      readonly reasonCode: "adapter-unavailable";
    };

export type SealedAggregateReport = {
  readonly schemaVersion: typeof SEALED_AGGREGATE_REPORT_SCHEMA_VERSION;
  readonly createdAt: string;
  readonly gitSha: string;
  readonly runtime: string;
  readonly policy: "evaluation-only";
  readonly corpus: {
    readonly id: "tab-echr" | "redactionbench" | "meddocan";
    readonly source: string;
    readonly version: string;
    readonly file: string;
    readonly sha256: string;
    readonly license: string;
    readonly split: "test";
    readonly documentCount: number;
    readonly selection:
      | { readonly type: "full-test-split" }
      | { readonly type: "fixed-hash-sample"; readonly seed: string };
  };
  readonly libraries: readonly SealedLibraryResult[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void => {
  const expectedKeys = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) {
      throw new Error(`${context} contains forbidden field ${key}`);
    }
  }
  for (const key of expected) {
    if (!(key in value)) {
      throw new Error(`${context} is missing field ${key}`);
    }
  }
};

const requireString = (value: unknown, context: string): void => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} must be a non-empty string`);
  }
};

const requireCount = (value: unknown, context: string): void => {
  if (
    !Number.isSafeInteger(value) ||
    (typeof value === "number" && value < 0)
  ) {
    throw new Error(`${context} must be a non-negative safe integer`);
  }
};

const requireRatio = (value: unknown, context: string): void => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(`${context} must be a finite ratio`);
  }
};

const validateMetrics = (value: unknown): void => {
  if (!isRecord(value)) {
    throw new Error("sealed metrics must be an object");
  }
  const type = value["type"];
  if (type === "tab-independent-annotator-span-redaction") {
    const counts = [
      "documents",
      "directMentions",
      "quasiMentions",
      "predictedSpans",
    ];
    const ratios = [
      "directMentionRecall",
      "quasiMentionRecall",
      "allMentionRecall",
      "entityRecall",
      "characterPrecision",
      "characterRecall",
    ];
    exactKeys(value, ["type", ...counts, ...ratios], "TAB aggregate metrics");
    for (const key of counts) requireCount(value[key], `TAB ${key}`);
    for (const key of ratios) requireRatio(value[key], `TAB ${key}`);
    return;
  }
  if (type === "redactionbench-transparent-interim") {
    const counts = ["documents", "mandatorySpans", "predictedSpans"];
    const ratios = [
      "mandatorySpanRecall",
      "mandatoryCharacterRecall",
      "acceptedCharacterPrecision",
    ];
    exactKeys(
      value,
      ["type", ...counts, ...ratios],
      "RedactionBench aggregate metrics",
    );
    for (const key of counts) requireCount(value[key], `RedactionBench ${key}`);
    for (const key of ratios) requireRatio(value[key], `RedactionBench ${key}`);
    return;
  }
  if (type === "label-agnostic-span-redaction") {
    const counts = ["goldSpans"];
    const ratios = ["spanRecall", "characterRecall", "characterPrecision"];
    exactKeys(
      value,
      ["type", ...counts, ...ratios],
      "MEDDOCAN aggregate metrics",
    );
    for (const key of counts) requireCount(value[key], `MEDDOCAN ${key}`);
    for (const key of ratios) requireRatio(value[key], `MEDDOCAN ${key}`);
    return;
  }
  throw new Error("sealed metrics use an unknown task type");
};

const metricTypeForCorpus = (
  corpusId: SealedAggregateReport["corpus"]["id"],
): SealedAggregateMetrics["type"] => {
  if (corpusId === "tab-echr") {
    return "tab-independent-annotator-span-redaction";
  }
  if (corpusId === "redactionbench") {
    return "redactionbench-transparent-interim";
  }
  return "label-agnostic-span-redaction";
};

export const assertSealedAggregateReport: (
  value: unknown,
) => asserts value is SealedAggregateReport = (value) => {
  if (!isRecord(value)) throw new Error("sealed report must be an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "createdAt",
      "gitSha",
      "runtime",
      "policy",
      "corpus",
      "libraries",
    ],
    "sealed report",
  );
  if (
    value["schemaVersion"] !== SEALED_AGGREGATE_REPORT_SCHEMA_VERSION ||
    value["policy"] !== "evaluation-only"
  ) {
    throw new Error("sealed report contract or policy is invalid");
  }
  requireString(value["createdAt"], "sealed report createdAt");
  requireString(value["gitSha"], "sealed report gitSha");
  requireString(value["runtime"], "sealed report runtime");

  const corpus = value["corpus"];
  if (!isRecord(corpus))
    throw new Error("sealed report corpus must be an object");
  exactKeys(
    corpus,
    [
      "id",
      "source",
      "version",
      "file",
      "sha256",
      "license",
      "split",
      "documentCount",
      "selection",
    ],
    "sealed report corpus",
  );
  const corpusId = corpus["id"];
  if (
    (corpusId !== "tab-echr" &&
      corpusId !== "redactionbench" &&
      corpusId !== "meddocan") ||
    corpus["split"] !== "test"
  ) {
    throw new Error("sealed report corpus id or split is invalid");
  }
  for (const key of ["source", "version", "file", "sha256", "license"] as const)
    requireString(corpus[key], `sealed report corpus ${key}`);
  if (!/^[a-f0-9]{64}$/u.test(String(corpus["sha256"]))) {
    throw new Error("sealed report corpus SHA-256 is invalid");
  }
  requireCount(corpus["documentCount"], "sealed report documentCount");
  if (corpus["documentCount"] === 0) {
    throw new Error("sealed report documentCount must be positive");
  }
  const selection = corpus["selection"];
  if (!isRecord(selection))
    throw new Error("sealed report selection must be an object");
  if (selection["type"] === "full-test-split") {
    exactKeys(selection, ["type"], "sealed report full selection");
  } else if (selection["type"] === "fixed-hash-sample") {
    exactKeys(selection, ["type", "seed"], "sealed report sample selection");
    requireString(selection["seed"], "sealed report sample seed");
  } else {
    throw new Error("sealed report selection is invalid");
  }
  if (corpusId !== "tab-echr" && selection["type"] !== "full-test-split") {
    throw new Error("only TAB supports a fixed sealed sample");
  }

  const libraries = value["libraries"];
  if (!Array.isArray(libraries) || libraries.length === 0)
    throw new Error("sealed report must contain aggregate library results");
  const libraryNames = new Set<string>();
  for (const [index, library] of libraries.entries()) {
    if (!isRecord(library))
      throw new Error(`sealed library ${index} must be an object`);
    requireString(library["name"], `sealed library ${index} name`);
    requireString(library["version"], `sealed library ${index} version`);
    if (typeof library["name"] === "string") {
      if (libraryNames.has(library["name"])) {
        throw new Error(`sealed library ${index} duplicates a library name`);
      }
      libraryNames.add(library["name"]);
    }
    if (library["status"] === "unavailable") {
      exactKeys(
        library,
        ["name", "version", "status", "reasonCode"],
        `sealed library ${index}`,
      );
      if (library["reasonCode"] !== "adapter-unavailable")
        throw new Error(`sealed library ${index} reason code is invalid`);
      continue;
    }
    if (library["status"] !== "ok")
      throw new Error(`sealed library ${index} status is invalid`);
    exactKeys(
      library,
      ["name", "version", "status", "elapsedSeconds", "metrics"],
      `sealed library ${index}`,
    );
    const elapsed = library["elapsedSeconds"];
    if (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < 0)
      throw new Error(`sealed library ${index} elapsedSeconds is invalid`);
    validateMetrics(library["metrics"]);
    const metrics = library["metrics"];
    if (!isRecord(metrics)) {
      throw new Error(`sealed library ${index} metrics are invalid`);
    }
    const expectedType = metricTypeForCorpus(corpusId);
    if (metrics["type"] !== expectedType) {
      throw new Error(
        `sealed library ${index} metrics do not match the corpus`,
      );
    }
    if (
      "documents" in metrics &&
      metrics["documents"] !== corpus["documentCount"]
    ) {
      throw new Error(
        `sealed library ${index} document count does not match the corpus`,
      );
    }
  }
};

export const serializeSealedAggregateReport = (
  report: SealedAggregateReport,
): string => {
  assertSealedAggregateReport(report);
  return `${JSON.stringify(report, null, 2)}\n`;
};

const percent = (value: number): string => (value * 100).toFixed(1);
const cell = (value: string): string =>
  value.replaceAll("|", "\\|").replaceAll(/\r?\n/gu, " ");

const tableDefinition = (
  metrics: SealedAggregateMetrics,
): {
  readonly headers: readonly string[];
  readonly values: readonly string[];
} => {
  if (metrics.type === "tab-independent-annotator-span-redaction") {
    return {
      headers: [
        "Direct recall",
        "Quasi recall",
        "All mention recall",
        "Entity recall",
        "Character precision",
        "Character recall",
      ],
      values: [
        percent(metrics.directMentionRecall),
        percent(metrics.quasiMentionRecall),
        percent(metrics.allMentionRecall),
        percent(metrics.entityRecall),
        percent(metrics.characterPrecision),
        percent(metrics.characterRecall),
      ],
    };
  }
  if (metrics.type === "redactionbench-transparent-interim") {
    return {
      headers: [
        "Mandatory span recall",
        "Mandatory character recall",
        "Accepted character precision",
      ],
      values: [
        percent(metrics.mandatorySpanRecall),
        percent(metrics.mandatoryCharacterRecall),
        percent(metrics.acceptedCharacterPrecision),
      ],
    };
  }
  return {
    headers: ["Span recall", "Character recall", "Character precision"],
    values: [
      percent(metrics.spanRecall),
      percent(metrics.characterRecall),
      percent(metrics.characterPrecision),
    ],
  };
};

export const renderSealedAggregateMarkdown = (
  report: SealedAggregateReport,
): string => {
  assertSealedAggregateReport(report);
  const available = report.libraries.find((library) => library.status === "ok");
  const definition =
    available === undefined
      ? { headers: ["Aggregate metrics"], values: ["unavailable"] }
      : tableDefinition(available.metrics);
  const lines = [
    "# Sealed aggregate anonymization evaluation",
    "",
    "Evaluation-only results on a checksum-pinned public test split.",
    "This report is generated exclusively from the aggregate report contract.",
    "It contains no source text, examples, categories, predictions, or per-document results.",
    "",
    `- Corpus: ${cell(report.corpus.id)}`,
    `- Source: ${cell(report.corpus.source)}`,
    `- Version: ${cell(report.corpus.version)}`,
    `- File: ${cell(report.corpus.file)}`,
    `- SHA-256: \`${report.corpus.sha256}\``,
    `- License: ${cell(report.corpus.license)}`,
    `- Split: ${report.corpus.split}`,
    `- Selection: ${report.corpus.selection.type} (${report.corpus.documentCount} documents)`,
    `- Generated: ${cell(report.createdAt)}`,
    `- Commit: ${cell(report.gitSha)}`,
    "",
    `| Library | Version | ${definition.headers.join(" | ")} | Seconds |`,
    `| ------- | ------- | ${definition.headers.map(() => "---").join(" | ")} | ------- |`,
  ];
  for (const library of report.libraries) {
    if (library.status === "unavailable") {
      const unavailableValues = [
        "unavailable",
        ...definition.headers.slice(1).map(() => "—"),
      ].join(" | ");
      lines.push(
        `| ${cell(library.name)} | ${cell(library.version)} | ${unavailableValues} | — |`,
      );
      continue;
    }
    const values = tableDefinition(library.metrics).values;
    lines.push(
      `| ${cell(library.name)} | ${cell(library.version)} | ${values.join(" | ")} | ${library.elapsedSeconds.toFixed(2)} |`,
    );
  }
  lines.push(
    "",
    "Metrics retain each corpus's native task semantics; no cross-corpus score is computed.",
    "",
  );
  return `${lines.join("\n")}\n`;
};

type WriteSealedReportOptions = {
  readonly directory: string;
  readonly report: SealedAggregateReport;
};

export const writeSealedAggregateReport = async ({
  directory,
  report,
}: WriteSealedReportOptions): Promise<{
  readonly jsonPath: string;
  readonly markdownPath: string;
}> => {
  const json = serializeSealedAggregateReport(report);
  const markdown = renderSealedAggregateMarkdown(report);
  await mkdir(directory, { recursive: true });
  const stamp = report.createdAt.replace(/[:.]/gu, "-");
  const jsonPath = join(directory, `${stamp}.json`);
  const markdownPath = join(directory, `${stamp}.md`);
  await Bun.write(jsonPath, json);
  await Bun.write(markdownPath, markdown);
  return { jsonPath, markdownPath };
};
