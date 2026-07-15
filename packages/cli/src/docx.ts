import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { NativeOpenSessionArchiveOptions } from "@stll/anonymize";
import {
  DOCX_COVERAGE_MODES,
  anonymizeDocx,
  restoreDocxText,
  type DocxAnonymizationSession,
  type DocxAnonymizationSummary,
  type DocxRestorationResult,
  type DocxRestorationSession,
} from "@stll/anonymize-docx";

import { parseCountries, UsageError } from "./args";

const DOCX_SESSION_KEY_BYTES = 32;
const DOCX_SESSION_LOCK_SUFFIX = ".lock";
const MAX_EPOCH_SECONDS = 4_294_967_295;

const DOCX_SESSION_MODES = {
  continue: "continue",
  create: "create",
} as const;

type DocxSessionMode =
  (typeof DOCX_SESSION_MODES)[keyof typeof DOCX_SESSION_MODES];

type DocxDetectionOptions = {
  labels?: string[] | undefined;
  languages?: string[] | undefined;
  countries?: string[] | undefined;
  threshold: number;
};

type DocxCommonOptions = {
  inputPath: string;
  outputPath: string;
  sessionArchivePath: string;
  sessionKeyPath: string;
  sessionId: string;
  coverage: (typeof DOCX_COVERAGE_MODES)[keyof typeof DOCX_COVERAGE_MODES];
  observedAtEpochSeconds?: number | undefined;
  json: boolean;
  quiet: boolean;
};

type DocxCommand =
  | { type: "help" }
  | ({
      type: "anonymize";
      sessionMode: DocxSessionMode;
      detection: DocxDetectionOptions;
    } & DocxCommonOptions)
  | ({ type: "restore" } & DocxCommonOptions);

export type DocxPipelineRequest =
  | { type: "anonymize"; detection: DocxDetectionOptions }
  | { type: "restore" };

type DocxCliSession = DocxAnonymizationSession &
  DocxRestorationSession & {
    toEncryptedArchive: (key: Uint8Array) => Uint8Array;
    toEncryptedArchiveAt: (
      key: Uint8Array,
      observedAtEpochSeconds: number,
    ) => Uint8Array;
  };

export type DocxCliPipeline = {
  createRedactionSession: (sessionId: string) => DocxCliSession;
  restoreEncryptedRedactionSession: (
    options: NativeOpenSessionArchiveOptions,
  ) => DocxCliSession;
};

type RunDocxCommandOptions = {
  argv: readonly string[];
  preparePipeline: (request: DocxPipelineRequest) => Promise<DocxCliPipeline>;
};

const DOCX_HELP = `Usage:
  anonymize docx anonymize [options] <input.docx>
  anonymize docx restore [options] <input.docx>

Anonymize or restore one DOCX file with an encrypted redaction session.
Document and session outputs are written atomically and never overwrite the
input, key file, or an existing document output.

Required options:
  -o, --output <path>          New DOCX output path
      --session-archive <path> Encrypted session archive path
      --session-key-file <path>
                               File containing exactly 32 raw key bytes
      --session-id <id>        Expected opaque session identity

Anonymize options:
      --session-mode <mode>    "create" or "continue" (required)
      --coverage <mode>        "require-full" (default) or "allow-partial"
      --labels <list>          Comma-separated entity labels
      --languages <list>       Name-corpus languages, e.g. "cs,de,en"
      --countries <list>       ISO 3166-1 alpha-2 country codes
      --threshold <n>          Minimum confidence score 0-1 (default: 0.3)

Restore options:
      --coverage <mode>        "require-full" (default) or "allow-partial"

Common options:
      --observed-at <seconds>  Deterministic Unix timestamp for lifecycle checks
      --json                   Print the aggregate audit-safe summary as JSON
      --quiet                  Suppress the human-readable stderr summary
  -h, --help                   Show this help

The session key is read from a file, never from a command argument. In create
mode the archive path must not exist. Continue mode atomically replaces the
existing archive only after the DOCX rewrite succeeds. It holds an exclusive
"<archive>.lock" sidecar throughout the continuation to prevent lost updates.
Caller-supplied detection plans and interactive review are available through the
package API, not this CLI.
`;

const splitList = (value: string): string[] => [
  ...new Set(
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  ),
];

const parseThreshold = (raw: string): number => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new UsageError(
      `--threshold must be a number between 0 and 1, got "${raw}"`,
    );
  }
  return value;
};

const parseEpochSeconds = (raw: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_EPOCH_SECONDS) {
    throw new UsageError(
      `--observed-at must be an integer from 0 to ${MAX_EPOCH_SECONDS}, got "${raw}"`,
    );
  }
  return value;
};

const parseCoverage = (
  raw: string | undefined,
): DocxCommonOptions["coverage"] => {
  const value = raw ?? DOCX_COVERAGE_MODES.requireFull;
  if (
    value === DOCX_COVERAGE_MODES.requireFull ||
    value === DOCX_COVERAGE_MODES.allowPartial
  ) {
    return value;
  }
  throw new UsageError(
    `--coverage must be one of: ${Object.values(DOCX_COVERAGE_MODES).join(", ")}; got "${value}"`,
  );
};

const parseSessionMode = (raw: string | undefined): DocxSessionMode => {
  if (raw === undefined) {
    throw new UsageError("--session-mode is required for DOCX anonymization");
  }
  if (
    raw === DOCX_SESSION_MODES.create ||
    raw === DOCX_SESSION_MODES.continue
  ) {
    return raw;
  }
  throw new UsageError(
    `--session-mode must be one of: ${Object.values(DOCX_SESSION_MODES).join(", ")}; got "${raw}"`,
  );
};

const required = (value: string | undefined, flag: string): string => {
  if (value === undefined || value.length === 0) {
    throw new UsageError(`${flag} is required for DOCX workflows`);
  }
  return value;
};

type ParsedCommonValues = {
  output?: string | undefined;
  "session-archive"?: string | undefined;
  "session-key-file"?: string | undefined;
  "session-id"?: string | undefined;
  coverage?: string | undefined;
  "observed-at"?: string | undefined;
  json?: boolean | undefined;
  quiet?: boolean | undefined;
};

const commonOptions = (
  values: ParsedCommonValues,
  positionals: readonly string[],
): DocxCommonOptions => {
  if (positionals.length !== 1) {
    throw new UsageError("DOCX workflows require exactly one input file");
  }
  const inputPath = positionals.at(0);
  if (inputPath === undefined) {
    throw new UsageError("DOCX workflows require exactly one input file");
  }
  return {
    inputPath,
    outputPath: required(values.output, "--output"),
    sessionArchivePath: required(
      values["session-archive"],
      "--session-archive",
    ),
    sessionKeyPath: required(values["session-key-file"], "--session-key-file"),
    sessionId: required(values["session-id"], "--session-id"),
    coverage: parseCoverage(values.coverage),
    observedAtEpochSeconds:
      values["observed-at"] === undefined
        ? undefined
        : parseEpochSeconds(values["observed-at"]),
    json: values.json === true,
    quiet: values.quiet === true,
  };
};

const parseDocxCommand = (argv: readonly string[]): DocxCommand => {
  const action = argv.at(0);
  if (action === undefined || action === "--help" || action === "-h") {
    return { type: "help" };
  }
  const args = argv.slice(1);
  if (action === "anonymize") {
    let parsed: ReturnType<typeof parseArgs<typeof DOCX_ANONYMIZE_CONFIG>>;
    try {
      parsed = parseArgs({ ...DOCX_ANONYMIZE_CONFIG, args: [...args] });
    } catch (error) {
      throw new UsageError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (parsed.values.help === true) {
      return { type: "help" };
    }
    return {
      type: "anonymize",
      ...commonOptions(parsed.values, parsed.positionals),
      sessionMode: parseSessionMode(parsed.values["session-mode"]),
      detection: {
        labels:
          parsed.values.labels === undefined
            ? undefined
            : splitList(parsed.values.labels),
        languages:
          parsed.values.languages === undefined
            ? undefined
            : splitList(parsed.values.languages),
        countries:
          parsed.values.countries === undefined
            ? undefined
            : parseCountries(parsed.values.countries),
        threshold:
          parsed.values.threshold === undefined
            ? 0.3
            : parseThreshold(parsed.values.threshold),
      },
    };
  }
  if (action === "restore") {
    let parsed: ReturnType<typeof parseArgs<typeof DOCX_RESTORE_CONFIG>>;
    try {
      parsed = parseArgs({ ...DOCX_RESTORE_CONFIG, args: [...args] });
    } catch (error) {
      throw new UsageError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (parsed.values.help === true) {
      return { type: "help" };
    }
    return {
      type: "restore",
      ...commonOptions(parsed.values, parsed.positionals),
    };
  }
  throw new UsageError(
    `unknown DOCX action "${action}"; expected "anonymize" or "restore"`,
  );
};

const DOCX_COMMON_PARSE_OPTIONS = {
  output: { type: "string", short: "o" },
  "session-archive": { type: "string" },
  "session-key-file": { type: "string" },
  "session-id": { type: "string" },
  coverage: { type: "string" },
  "observed-at": { type: "string" },
  json: { type: "boolean" },
  quiet: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const DOCX_ANONYMIZE_CONFIG = {
  allowPositionals: true,
  strict: true,
  options: {
    ...DOCX_COMMON_PARSE_OPTIONS,
    "session-mode": { type: "string" },
    labels: { type: "string" },
    languages: { type: "string" },
    countries: { type: "string" },
    threshold: { type: "string" },
  },
} as const;

const DOCX_RESTORE_CONFIG = {
  allowPositionals: true,
  strict: true,
  options: DOCX_COMMON_PARSE_OPTIONS,
} as const;

const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const sessionArchiveLockPath = (archivePath: string): string =>
  `${canonicalPath(archivePath)}${DOCX_SESSION_LOCK_SUFFIX}`;

const assertDistinctPaths = (
  paths: readonly { path: string; flag: string }[],
): void => {
  const seen = new Map<string, string>();
  for (const entry of paths) {
    const canonical = canonicalPath(entry.path);
    const existing = seen.get(canonical);
    if (existing !== undefined) {
      throw new UsageError(`${entry.flag} collides with ${existing}`);
    }
    seen.set(canonical, `${entry.flag} "${entry.path}"`);
  }
};

const isNodeError = (
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === code;

const assertPathDoesNotExist = async (
  path: string,
  flag: string,
): Promise<void> => {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw new UsageError(`${flag} refuses to overwrite existing path "${path}"`);
};

const preflightDocxCommand = async (
  command: Exclude<DocxCommand, { type: "help" }>,
): Promise<void> => {
  const paths = [
    { path: command.inputPath, flag: "input" },
    { path: command.outputPath, flag: "--output" },
    { path: command.sessionArchivePath, flag: "--session-archive" },
    { path: command.sessionKeyPath, flag: "--session-key-file" },
  ];
  if (
    command.type === "anonymize" &&
    command.sessionMode === DOCX_SESSION_MODES.continue
  ) {
    paths.push({
      path: sessionArchiveLockPath(command.sessionArchivePath),
      flag: "session archive lock",
    });
  }
  assertDistinctPaths(paths);
  await assertPathDoesNotExist(command.outputPath, "--output");
  if (
    command.type === "anonymize" &&
    command.sessionMode === DOCX_SESSION_MODES.create
  ) {
    await assertPathDoesNotExist(
      command.sessionArchivePath,
      "--session-archive",
    );
  }
};

type SessionArchiveLock = {
  release: () => Promise<void>;
};

type OperationResult =
  | { type: "succeeded" }
  | { type: "failed"; error: unknown };

const captureOperationResult = async (
  operation: Promise<void>,
): Promise<OperationResult> => {
  try {
    await operation;
    return { type: "succeeded" };
  } catch (error) {
    return { type: "failed", error };
  }
};

const acquireSessionArchiveLock = async (
  archivePath: string,
): Promise<SessionArchiveLock> => {
  const lockPath = sessionArchiveLockPath(archivePath);
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new Error(
        `encrypted session archive is locked by another continuation; if no process is running, remove the stale lock "${lockPath}"`,
      );
    }
    throw error;
  }
  return {
    release: async () => {
      const closeResult = await captureOperationResult(handle.close());
      const unlinkResult = await captureOperationResult(unlink(lockPath));
      if (closeResult.type === "failed") {
        throw closeResult.error;
      }
      if (
        unlinkResult.type === "failed" &&
        !isNodeError(unlinkResult.error, "ENOENT")
      ) {
        throw unlinkResult.error;
      }
    },
  };
};

const readSessionKey = async (path: string): Promise<Uint8Array> => {
  const handle = await open(path, "r");
  let key: Uint8Array | undefined;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new UsageError("--session-key-file must be a regular file");
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new UsageError(
        "--session-key-file must not grant permissions to group or other users (use chmod 600)",
      );
    }
    key = await handle.readFile();
    if (key.byteLength !== DOCX_SESSION_KEY_BYTES) {
      throw new UsageError(
        `--session-key-file must contain exactly ${DOCX_SESSION_KEY_BYTES} raw bytes`,
      );
    }
    await handle.close();
    return key;
  } catch (error) {
    key?.fill(0);
    try {
      await handle.close();
    } catch {
      // Preserve the validation or read error.
    }
    throw error;
  }
};

const removeStagedFile = async (path: string | undefined): Promise<void> => {
  if (path === undefined) {
    return;
  }
  try {
    await unlink(path);
  } catch {
    // Best-effort cleanup must not hide the original operation error.
  }
};

const stageFile = async (
  target: string,
  content: Uint8Array,
): Promise<string> => {
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
  } catch (error) {
    try {
      await handle.close();
    } catch {
      // Preserve the write error while cleanup remains best effort.
    }
    await removeStagedFile(temporary);
    throw error;
  }
  return temporary;
};

const publishNewFile = async (
  temporary: string,
  target: string,
  flag: string,
): Promise<void> => {
  try {
    await link(temporary, target);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new UsageError(
        `${flag} refuses to overwrite existing path "${target}"`,
      );
    }
    throw error;
  }
  await removeStagedFile(temporary);
};

const publishReplacement = async (
  temporary: string,
  target: string,
): Promise<void> => {
  await rename(temporary, target);
};

const sessionArchive = (
  session: DocxCliSession,
  key: Uint8Array,
  observedAtEpochSeconds: number | undefined,
): Uint8Array =>
  observedAtEpochSeconds === undefined
    ? session.toEncryptedArchive(key)
    : session.toEncryptedArchiveAt(key, observedAtEpochSeconds);

const outputSummary = (
  command: Pick<DocxCommonOptions, "json" | "quiet">,
  action: "anonymized" | "restored",
  summary: DocxAnonymizationSummary | Omit<DocxRestorationResult, "document">,
): void => {
  if (command.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
  if (command.quiet) {
    return;
  }
  const coverage = summary.coverage.status;
  if ("entityCount" in summary) {
    process.stderr.write(
      `anonymize: DOCX ${action}: ${summary.entityCount} entities, ${summary.appliedReplacementCount} replacements, ${coverage} coverage\n`,
    );
    return;
  }
  process.stderr.write(
    `anonymize: DOCX ${action}: ${summary.restoredPlaceholderCount} placeholders, ${coverage} coverage\n`,
  );
};

const openSession = (
  pipeline: DocxCliPipeline,
  command: Pick<DocxCommonOptions, "sessionId" | "observedAtEpochSeconds">,
  archive: Uint8Array,
  key: Uint8Array,
): DocxCliSession =>
  pipeline.restoreEncryptedRedactionSession({
    archive,
    key,
    expectedSessionId: command.sessionId,
    ...(command.observedAtEpochSeconds === undefined
      ? {}
      : { observedAtEpochSeconds: command.observedAtEpochSeconds }),
  });

const runDocxAnonymize = async (
  command: Extract<DocxCommand, { type: "anonymize" }>,
  pipeline: DocxCliPipeline,
): Promise<void> => {
  const archivePath =
    command.sessionMode === DOCX_SESSION_MODES.continue
      ? canonicalPath(command.sessionArchivePath)
      : command.sessionArchivePath;
  const archiveLock =
    command.sessionMode === DOCX_SESSION_MODES.continue
      ? await acquireSessionArchiveLock(archivePath)
      : undefined;
  let workflowResult: OperationResult = { type: "succeeded" };
  let lockReleaseResult: OperationResult = { type: "succeeded" };
  let key: Uint8Array | undefined;
  let documentTemporary: string | undefined;
  let archiveTemporary: string | undefined;
  try {
    key = await readSessionKey(command.sessionKeyPath);
    const [document, existingArchive] = await Promise.all([
      readFile(command.inputPath),
      command.sessionMode === DOCX_SESSION_MODES.continue
        ? readFile(archivePath)
        : Promise.resolve(undefined),
    ]);
    const session =
      existingArchive === undefined
        ? pipeline.createRedactionSession(command.sessionId)
        : openSession(pipeline, command, existingArchive, key);
    const result = anonymizeDocx({
      document,
      session,
      expectedSessionId: command.sessionId,
      policy: { coverage: { mode: command.coverage } },
      ...(command.observedAtEpochSeconds === undefined
        ? {}
        : { observedAtEpochSeconds: command.observedAtEpochSeconds }),
    });
    const encryptedArchive = sessionArchive(
      session,
      key,
      command.observedAtEpochSeconds,
    );
    documentTemporary = await stageFile(command.outputPath, result.document);
    archiveTemporary = await stageFile(archivePath, encryptedArchive);
    if (command.sessionMode === DOCX_SESSION_MODES.create) {
      await publishNewFile(
        archiveTemporary,
        command.sessionArchivePath,
        "--session-archive",
      );
    } else {
      await publishReplacement(archiveTemporary, archivePath);
    }
    archiveTemporary = undefined;
    try {
      await publishNewFile(documentTemporary, command.outputPath, "--output");
      documentTemporary = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `encrypted session archive was updated, but DOCX output could not be published: ${message}`,
      );
    }
    outputSummary(command, "anonymized", result.summary);
  } catch (error) {
    workflowResult = { type: "failed", error };
  } finally {
    key?.fill(0);
    await Promise.all([
      removeStagedFile(documentTemporary),
      removeStagedFile(archiveTemporary),
    ]);
    if (archiveLock !== undefined) {
      lockReleaseResult = await captureOperationResult(archiveLock.release());
    }
  }
  if (workflowResult.type === "failed") {
    throw workflowResult.error;
  }
  if (lockReleaseResult.type === "failed") {
    const message =
      lockReleaseResult.error instanceof Error
        ? lockReleaseResult.error.message
        : String(lockReleaseResult.error);
    throw new Error(
      `DOCX and session outputs were published, but the session archive lock could not be released: ${message}`,
    );
  }
};

const runDocxRestore = async (
  command: Extract<DocxCommand, { type: "restore" }>,
  pipeline: DocxCliPipeline,
): Promise<void> => {
  const key = await readSessionKey(command.sessionKeyPath);
  try {
    const [document, archive] = await Promise.all([
      readFile(command.inputPath),
      readFile(command.sessionArchivePath),
    ]);
    const session = openSession(pipeline, command, archive, key);
    const result = restoreDocxText({
      document,
      session,
      expectedSessionId: command.sessionId,
      ...(command.observedAtEpochSeconds === undefined
        ? {}
        : { observedAtEpochSeconds: command.observedAtEpochSeconds }),
    });
    if (
      command.coverage === DOCX_COVERAGE_MODES.requireFull &&
      result.coverage.status === "partial"
    ) {
      throw new Error(
        "DOCX contains content outside the fully supported restoration coverage",
      );
    }
    const temporary = await stageFile(command.outputPath, result.document);
    try {
      await publishNewFile(temporary, command.outputPath, "--output");
    } catch (error) {
      await removeStagedFile(temporary);
      throw error;
    }
    const summary: Omit<DocxRestorationResult, "document"> = {
      sessionId: result.sessionId,
      restoredBlockCount: result.restoredBlockCount,
      restoredPlaceholderCount: result.restoredPlaceholderCount,
      coverage: result.coverage,
    };
    outputSummary(command, "restored", summary);
  } finally {
    key.fill(0);
  }
};

export const runDocxCommand = async ({
  argv,
  preparePipeline,
}: RunDocxCommandOptions): Promise<void> => {
  const command = parseDocxCommand(argv);
  if (command.type === "help") {
    process.stdout.write(DOCX_HELP);
    return;
  }
  await preflightDocxCommand(command);
  const pipeline = await preparePipeline(
    command.type === "anonymize"
      ? { type: "anonymize", detection: command.detection }
      : { type: "restore" },
  );
  if (command.type === "anonymize") {
    await runDocxAnonymize(command, pipeline);
    return;
  }
  await runDocxRestore(command, pipeline);
};
