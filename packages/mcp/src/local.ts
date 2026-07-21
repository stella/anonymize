import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CAPABILITY_MANIFEST,
  type NativeCallerDetection,
  type NativeTextReplacement,
} from "@stll/anonymize";
import {
  DOCX_ARCHIVE_MAX_BYTES,
  DOCX_COVERAGE_MODES,
  anonymizeDocx,
  extractDocxText,
  restoreDocxText,
  type DocxAnonymizationSession,
  type DocxRestorationSession,
} from "@stll/anonymize-docx";
import * as nativeNode from "@stll/anonymize/native-node";
import {
  constants as fsConstants,
  link,
  lstat,
  open,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import * as z from "zod/v4";

import { DurableSessionStore } from "./durable-sessions";

const TEXT_MAX_BYTES = 64 * 1024 * 1024;
const EXTERNAL_DETECTION_BATCH_MAX_BYTES = 16 * 1024 * 1024;
const EXTERNAL_DETECTION_BATCH_VERSION = 1 as const;
const PATH_MAX_CHARACTERS = 32_768;
const SESSION_MAX_COUNT = 256;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const READ_CHUNK_BYTES = 64 * 1024;

export const MCP_DURABLE_SESSION_TTL_DEFAULT_SECONDS = 7 * 24 * 60 * 60;
export const MCP_DURABLE_SESSION_TTL_MIN_SECONDS = 60;
export const MCP_DURABLE_SESSION_TTL_MAX_SECONDS = 365 * 24 * 60 * 60;

const observedAtEpochSeconds = (): number => {
  const seconds = Math.floor(Date.now() / 1000);
  if (seconds < 0 || seconds > 0xff_ff_ff_ff) {
    throw new Error("The current time is outside the supported session range");
  }
  return seconds;
};

export const MCP_SESSION_MODES = {
  durableEncrypted: "durable-encrypted",
  memory: "memory",
} as const;

export type McpSessionMode =
  (typeof MCP_SESSION_MODES)[keyof typeof MCP_SESSION_MODES];

export type AuditSafeResult = {
  operation: "anonymize" | "inspect" | "restore";
  format: "docx" | "text";
  outputCreated: boolean;
  sessionId?: string;
  entityCount?: number;
  blockCount?: number;
  rewrittenBlockCount?: number;
  restoredPlaceholderCount?: number;
  coverageStatus?: "full" | "partial";
  externalDetectionBatchStatus?: "accepted";
  externalDetectionCount?: number;
  retainedExternalDetectionCount?: number;
};

const EXTERNAL_DETECTION_FAILURES = {
  batchRejected: {
    code: "EXTERNAL_DETECTION_BATCH_REJECTED",
    message: "The external detection batch was rejected.",
  },
  documentRejected: {
    code: "EXTERNAL_DETECTION_DOCUMENT_REJECTED",
    message: "The external detection document was rejected.",
  },
  inputRejected: {
    code: "EXTERNAL_DETECTION_INPUT_REJECTED",
    message: "The external detection request paths were rejected.",
  },
  operationFailed: {
    code: "EXTERNAL_DETECTION_OPERATION_FAILED",
    message: "The external detection operation failed safely.",
  },
  sessionRejected: {
    code: "EXTERNAL_DETECTION_SESSION_REJECTED",
    message: "The external detection session was rejected.",
  },
} as const;

type ExternalDetectionFailure =
  (typeof EXTERNAL_DETECTION_FAILURES)[keyof typeof EXTERNAL_DETECTION_FAILURES];

class ExternalDetectionAuditError extends Error {
  readonly code: ExternalDetectionFailure["code"];

  constructor(failure: ExternalDetectionFailure) {
    super(failure.message);
    this.name = "ExternalDetectionAuditError";
    this.code = failure.code;
  }
}

const externalDetectionFailure = (
  error: unknown,
  failure: ExternalDetectionFailure,
): ExternalDetectionAuditError =>
  error instanceof ExternalDetectionAuditError
    ? error
    : new ExternalDetectionAuditError(failure);

const externalDetectionStep = async <Result>(
  failure: ExternalDetectionFailure,
  operation: () => Result | Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    throw externalDetectionFailure(error, failure);
  }
};

export type LocalAnonymizeServiceFaults = {
  beforeOutputPublish?: () => void;
};

export type LocalAnonymizeServiceOptions = {
  durableSessions?: DurableSessionStore;
  durableSessionTtlSeconds?: number;
  faults?: LocalAnonymizeServiceFaults;
  nowEpochSeconds?: () => number;
};

const inside = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
};

type ReadInputOptions = {
  path: string;
  extension: ".docx" | ".json" | ".txt";
  maximumBytes: number;
  label: "DOCX" | "External detection batch" | "Text";
};

type ScopedInput = {
  bytes: Uint8Array;
  path: string;
};

type ReadableFileHandle = Pick<Awaited<ReturnType<typeof open>>, "read">;

const readHandleBounded = async (
  handle: ReadableFileHandle,
  maximumBytes: number,
  label: "DOCX" | "External detection batch" | "Text",
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(
      Math.min(READ_CHUNK_BYTES, maximumBytes - total + 1),
    );
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total);
    }
    total += bytesRead;
    if (total > maximumBytes) {
      throw new Error(`${label} inputs must not exceed ${maximumBytes} bytes`);
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
};

type DirectoryIdentity = {
  dev: number;
  ino: number;
  path: string;
};

type FileIdentity = Pick<DirectoryIdentity, "dev" | "ino">;

class ScopedOutput {
  readonly parent: DirectoryIdentity;
  readonly path: string;

  constructor(path: string, parent: DirectoryIdentity) {
    this.path = path;
    this.parent = parent;
  }

  async write(bytes: Uint8Array | string): Promise<void> {
    await safeWrite(this, bytes);
  }
}

export class PathScope {
  readonly #roots: readonly string[];

  private constructor(roots: readonly string[]) {
    this.#roots = roots;
  }

  static async create(roots: readonly string[]): Promise<PathScope> {
    if (roots.length === 0) {
      throw new Error("At least one --root directory is required");
    }
    const canonical = await Promise.all(
      roots.map(async (root) => {
        if (!isAbsolute(root)) {
          throw new Error("MCP roots must be absolute paths");
        }
        const path = await realpath(root);
        const metadata = await stat(path);
        if (!metadata.isDirectory()) {
          throw new Error("Every MCP root must be a directory");
        }
        return path;
      }),
    );
    return new PathScope([...new Set(canonical)]);
  }

  async readInput({
    path,
    extension,
    maximumBytes,
    label,
  }: ReadInputOptions): Promise<ScopedInput> {
    if (!isAbsolute(path) || extname(path).toLowerCase() !== extension) {
      throw new Error(`Input must be an absolute ${extension} path`);
    }
    const initiallyCanonical = await realpath(path);
    if (!this.#roots.some((root) => inside(root, initiallyCanonical))) {
      throw new Error("Input is outside the configured roots");
    }
    const initiallyRequestedMetadata = await lstat(path);
    if (!initiallyRequestedMetadata.isFile()) {
      throw new Error("Input must be a regular file");
    }
    const handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    try {
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isFile()) {
        throw new Error("Input must be a regular file");
      }
      const canonical = await realpath(path);
      if (!this.#roots.some((root) => inside(root, canonical))) {
        throw new Error("Input is outside the configured roots");
      }
      const currentMetadata = await stat(canonical);
      if (
        currentMetadata.dev !== openedMetadata.dev ||
        currentMetadata.ino !== openedMetadata.ino
      ) {
        throw new Error("Input changed while it was being validated");
      }
      if (openedMetadata.size > maximumBytes) {
        throw new Error(
          `${label} inputs must not exceed ${maximumBytes} bytes`,
        );
      }
      const bytes = await readHandleBounded(handle, maximumBytes, label);
      return { bytes, path: canonical };
    } finally {
      await handle.close();
    }
  }

  async output(
    path: string,
    extension: ".docx" | ".txt",
  ): Promise<ScopedOutput> {
    if (!isAbsolute(path) || extname(path).toLowerCase() !== extension) {
      throw new Error(`Output must be an absolute ${extension} path`);
    }
    const normalized = resolve(path);
    const parent = await realpath(dirname(normalized));
    if (!this.#roots.some((root) => inside(root, parent))) {
      throw new Error("Output is outside the configured roots");
    }
    const parentMetadata = await stat(parent);
    try {
      await lstat(normalized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new ScopedOutput(normalized, {
          dev: parentMetadata.dev,
          ino: parentMetadata.ino,
          path: parent,
        });
      }
      throw new Error("Output availability could not be verified", {
        cause: error,
      });
    }
    throw new Error("Output already exists; overwriting is not supported");
  }
}

type SessionEntry = {
  expiresAtEpochSeconds: number | undefined;
  language: string | undefined;
  session: RedactionSession;
  restoreSession: (plaintextJson: string) => RedactionSession;
  status: "busy" | "initializing" | "ready";
};

type SessionLease = {
  entry: SessionEntry;
  observedAtEpochSeconds: number | undefined;
  sessionId: string;
  rollback:
    | { type: "delete" }
    | { type: "release" }
    | { type: "restore"; checkpoint: string };
};

type RedactionSession = DocxAnonymizationSession &
  DocxRestorationSession & {
    redact_text(text: string): {
      redaction: { redactedText: string; entityCount: number };
    };
    restoreText(text: string): string;
    redactTextAt(options: {
      fullText: string;
      observedAtEpochSeconds: number;
    }): {
      redaction: { redactedText: string; entityCount: number };
    };
    inspect(observedAtEpochSeconds?: number): {
      expiresAtEpochSeconds: number | null;
    };
    toPlaintextJson(): string;
    toPlaintextJsonAt(observedAtEpochSeconds: number): string;
    toEncryptedArchiveAt(
      key: Uint8Array,
      observedAtEpochSeconds: number,
    ): Uint8Array;
  };

type NativeNodeSurface = {
  convert_external_detection_batch: (
    document: Uint8Array,
    batch: string,
  ) => NativeCallerDetection[];
  getDefaultNativePipeline: (options: { language?: string }) => {
    createRedactionSession: (sessionId: string) => RedactionSession;
    createRedactionSessionWithLifecycle: (options: {
      sessionId: string;
      createdAtEpochSeconds: number;
      expiresAtEpochSeconds: number;
    }) => RedactionSession;
    restoreRedactionSession: (plaintextJson: string) => RedactionSession;
    restoreEncryptedRedactionSession: (options: {
      archive: Uint8Array;
      expectedSessionId: string;
      key: Uint8Array;
      observedAtEpochSeconds: number;
    }) => RedactionSession;
  };
  native_package_version: () => string;
};

const nativeNodeSurface = nativeNode as unknown as NativeNodeSurface; // SAFETY: These native-node runtime exports are public, but their generated declarations are minified during workspace builds.

const assertOutputParent = async ({
  parent,
  path,
}: ScopedOutput): Promise<void> => {
  const canonical = await realpath(dirname(path));
  const metadata = await stat(canonical);
  if (
    canonical !== parent.path ||
    metadata.dev !== parent.dev ||
    metadata.ino !== parent.ino
  ) {
    throw new Error("Output directory changed while it was being used");
  }
};

const sameFile = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const safeWrite = async (
  output: ScopedOutput,
  bytes: Uint8Array | string,
): Promise<void> => {
  await assertOutputParent(output);
  const temporary = `${output.path}.stella-${randomUUID()}.tmp`;
  let published = false;
  let committed = false;
  let temporaryMetadata: FileIdentity | undefined;
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o400,
  );
  try {
    temporaryMetadata = await handle.stat();
    const canonicalTemporary = await realpath(temporary);
    const currentTemporaryMetadata = await lstat(temporary);
    if (
      dirname(canonicalTemporary) !== output.parent.path ||
      !currentTemporaryMetadata.isFile() ||
      !sameFile(temporaryMetadata, currentTemporaryMetadata)
    ) {
      throw new Error("Output staging file changed while it was being used");
    }
    await handle.writeFile(bytes);
    await handle.sync();
    await assertOutputParent(output);
    const stagedMetadata = await lstat(temporary);
    if (
      !stagedMetadata.isFile() ||
      !sameFile(temporaryMetadata, stagedMetadata)
    ) {
      throw new Error("Output staging file changed before publication");
    }
    await link(temporary, output.path);
    published = true;
    const publishedMetadata = await lstat(output.path);
    if (
      !publishedMetadata.isFile() ||
      !sameFile(temporaryMetadata, publishedMetadata)
    ) {
      throw new Error("Published output does not match the staged file");
    }
    await assertOutputParent(output);
    await handle.chmod(0o600);
    await handle.sync();
    committed = true;
  } finally {
    if (!committed) {
      await handle.truncate(0).catch(() => undefined);
      await handle.sync().catch(() => undefined);
      await handle.chmod(0o000).catch(() => undefined);
    }
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (published && !committed && temporaryMetadata !== undefined) {
      const publishedMetadata = await lstat(output.path).catch(() => undefined);
      if (
        publishedMetadata !== undefined &&
        sameFile(temporaryMetadata, publishedMetadata)
      ) {
        await unlink(output.path).catch(() => undefined);
      }
    }
  }
};

const decodeText = (bytes: Uint8Array): string => {
  return decodeUtf8(bytes, "Text inputs");
};

const decodeUtf8 = (bytes: Uint8Array, label: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} must contain valid UTF-8`, { cause: error });
  }
};

const applyTextReplacements = (
  text: string,
  replacements: readonly NativeTextReplacement[],
): string => {
  const parts: string[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    if (
      !Number.isSafeInteger(replacement.start) ||
      !Number.isSafeInteger(replacement.end) ||
      replacement.start < cursor ||
      replacement.end <= replacement.start ||
      replacement.end > text.length ||
      !isUtf16Boundary(text, replacement.start) ||
      !isUtf16Boundary(text, replacement.end)
    ) {
      throw new Error(
        "Native caller-detection plan returned invalid replacements",
      );
    }
    parts.push(text.slice(cursor, replacement.start), replacement.replacement);
    cursor = replacement.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
};

const isUtf16Boundary = (text: string, offset: number): boolean => {
  if (offset <= 0 || offset >= text.length) {
    return true;
  }
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  );
};

const assertDifferentPaths = (input: string, output: string): void => {
  if (input === output) {
    throw new Error("Input and output paths must differ");
  }
};

const textInput = z.object({
  inputPath: z.string().min(1).max(PATH_MAX_CHARACTERS),
  outputPath: z.string().min(1).max(PATH_MAX_CHARACTERS),
  sessionId: z.string().regex(SESSION_ID),
  language: z.string().min(2).max(35).optional(),
});

const externalDetectionTextInput = textInput.extend({
  detectionBatchPath: z.string().min(1).max(PATH_MAX_CHARACTERS),
});

const restoreInput = z.object({
  inputPath: z.string().min(1).max(PATH_MAX_CHARACTERS),
  outputPath: z.string().min(1).max(PATH_MAX_CHARACTERS),
  sessionId: z.string().regex(SESSION_ID),
});

const docxRestoreInput = restoreInput.extend({
  allowPartialCoverage: z.boolean().optional().default(false),
});

const docxInput = textInput.extend({
  allowPartialCoverage: z.boolean().optional().default(false),
});

export class LocalAnonymizeService {
  #activeOperations = 0;
  #closePromise: Promise<void> | undefined;
  #operationsDrained: (() => void) | undefined;
  readonly #scope: PathScope;
  readonly #sessionInitializations = new Set<string>();
  readonly #sessions = new Map<string, SessionEntry>();
  #state: "closed" | "closing" | "open" = "open";
  readonly #durableSessions: DurableSessionStore | undefined;
  readonly #durableSessionTtlSeconds: number | undefined;
  readonly #faults: LocalAnonymizeServiceFaults;
  readonly #nowEpochSeconds: () => number;

  constructor(scope: PathScope, options: LocalAnonymizeServiceOptions = {}) {
    this.#scope = scope;
    this.#durableSessions = options.durableSessions;
    this.#faults = options.faults ?? {};
    this.#nowEpochSeconds = options.nowEpochSeconds ?? observedAtEpochSeconds;
    this.#durableSessionTtlSeconds =
      options.durableSessions === undefined
        ? undefined
        : (options.durableSessionTtlSeconds ??
          MCP_DURABLE_SESSION_TTL_DEFAULT_SECONDS);
    if (
      this.#durableSessionTtlSeconds !== undefined &&
      (!Number.isSafeInteger(this.#durableSessionTtlSeconds) ||
        this.#durableSessionTtlSeconds < MCP_DURABLE_SESSION_TTL_MIN_SECONDS ||
        this.#durableSessionTtlSeconds > MCP_DURABLE_SESSION_TTL_MAX_SECONDS)
    ) {
      throw new Error("MCP durable session TTL is outside the supported range");
    }
  }

  get sessionMode(): McpSessionMode {
    return this.#durableSessions === undefined
      ? MCP_SESSION_MODES.memory
      : MCP_SESSION_MODES.durableEncrypted;
  }

  get sessionTtlSeconds(): number | null {
    return this.#durableSessionTtlSeconds ?? null;
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#state = "closing";
    this.#closePromise = (async () => {
      if (this.#activeOperations > 0) {
        await new Promise<void>((resolvePromise) => {
          this.#operationsDrained = resolvePromise;
        });
      }
      this.#sessions.clear();
      await this.#durableSessions?.close();
      this.#state = "closed";
    })();
    return this.#closePromise;
  }

  async #runOperation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (this.#state !== "open") {
      throw new Error("MCP anonymize service is closing or closed");
    }
    this.#activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.#activeOperations -= 1;
      if (this.#activeOperations === 0) {
        this.#operationsDrained?.();
        this.#operationsDrained = undefined;
      }
    }
  }

  #observedAt(): number {
    const seconds = this.#nowEpochSeconds();
    if (
      !Number.isSafeInteger(seconds) ||
      seconds < 0 ||
      seconds > 0xff_ff_ff_ff
    ) {
      throw new Error(
        "The current time is outside the supported session range",
      );
    }
    return seconds;
  }

  async #session(sessionId: string, language?: string): Promise<SessionLease> {
    if (this.#durableSessions !== undefined && language !== undefined) {
      throw new Error(
        "Durable sessions use the full all-language pipeline; omit language",
      );
    }
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      if (language !== undefined && existing.language !== language) {
        throw new Error("A session cannot change language");
      }
      if (existing.status === "initializing") {
        throw new Error("The requested session is still initializing");
      }
      if (existing.status === "busy") {
        throw new Error("The requested session is handling another operation");
      }
      const observedAt =
        this.#durableSessions === undefined ? undefined : this.#observedAt();
      if (
        observedAt !== undefined &&
        existing.expiresAtEpochSeconds !== undefined &&
        observedAt >= existing.expiresAtEpochSeconds
      ) {
        this.#sessions.delete(sessionId);
        await this.#durableSessions?.delete(sessionId);
        throw new Error("The requested session is unavailable");
      }
      const checkpoint =
        observedAt === undefined
          ? existing.session.toPlaintextJson()
          : existing.session.toPlaintextJsonAt(observedAt);
      existing.status = "busy";
      return {
        entry: existing,
        observedAtEpochSeconds: observedAt,
        sessionId,
        rollback: { type: "restore", checkpoint },
      };
    }
    if (this.#sessionInitializations.has(sessionId)) {
      throw new Error("The requested session is still initializing");
    }
    this.#sessionInitializations.add(sessionId);
    try {
      if (this.#sessions.size >= SESSION_MAX_COUNT) {
        throw new Error(`MCP sessions must not exceed ${SESSION_MAX_COUNT}`);
      }
      const pipeline = nativeNodeSurface.getDefaultNativePipeline(
        language === undefined ? {} : { language },
      );
      const durableSessions = this.#durableSessions;
      const observedAt = this.#observedAt();
      const stored =
        durableSessions === undefined
          ? undefined
          : await durableSessions.load(sessionId, observedAt);
      let session: RedactionSession;
      let expiresAtEpochSeconds: number | undefined;
      if (stored === undefined) {
        if (durableSessions === undefined) {
          session = pipeline.createRedactionSession(sessionId);
        } else {
          const ttl = this.#durableSessionTtlSeconds;
          if (ttl === undefined || observedAt > 0xff_ff_ff_ff - ttl) {
            throw new Error(
              "MCP durable session expiry is outside the supported range",
            );
          }
          expiresAtEpochSeconds = observedAt + ttl;
          session = pipeline.createRedactionSessionWithLifecycle({
            sessionId,
            createdAtEpochSeconds: observedAt,
            expiresAtEpochSeconds,
          });
        }
      } else {
        if (durableSessions === undefined) {
          throw new Error("Durable session storage is unavailable");
        }
        try {
          session = durableSessions.restore({
            archive: stored.bytes,
            expectedSessionId: sessionId,
            observedAtEpochSeconds: observedAt,
            restorer: pipeline,
          });
          if (
            session.inspect(observedAt).expiresAtEpochSeconds !==
            stored.expiresAtEpochSeconds
          ) {
            throw new Error(
              "Durable session archive expiry does not match storage",
            );
          }
          expiresAtEpochSeconds = stored.expiresAtEpochSeconds;
        } catch (error) {
          throw new Error("The requested durable session is unavailable", {
            cause: error,
          });
        }
      }
      const entry: SessionEntry = {
        expiresAtEpochSeconds,
        language,
        session,
        restoreSession: (plaintextJson) =>
          pipeline.restoreRedactionSession(plaintextJson),
        status: "initializing",
      };
      this.#sessions.set(sessionId, entry);
      return {
        entry,
        observedAtEpochSeconds:
          durableSessions === undefined ? undefined : observedAt,
        sessionId,
        rollback:
          stored === undefined
            ? { type: "delete" }
            : { type: "restore", checkpoint: session.toPlaintextJson() },
      };
    } finally {
      this.#sessionInitializations.delete(sessionId);
    }
  }

  #commitSession({ entry }: SessionLease): void {
    entry.status = "ready";
  }

  async #rollbackSession({
    entry,
    rollback,
    sessionId,
  }: SessionLease): Promise<void> {
    if (this.#sessions.get(sessionId) !== entry) {
      return;
    }
    if (rollback.type === "delete") {
      this.#sessions.delete(sessionId);
      await this.#durableSessions?.delete(sessionId).catch(() => undefined);
      return;
    }
    if (rollback.type === "release") {
      entry.status = "ready";
      return;
    }
    try {
      entry.session = entry.restoreSession(rollback.checkpoint);
      entry.status = "ready";
      await this.#persistSession(sessionId, entry.session);
    } catch {
      this.#sessions.delete(sessionId);
    }
  }

  async #readSession(sessionId: string): Promise<SessionLease> {
    let entry = this.#sessions.get(sessionId);
    const observedAt =
      this.#durableSessions === undefined ? undefined : this.#observedAt();
    if (entry === undefined && this.#durableSessions !== undefined) {
      if (this.#sessionInitializations.has(sessionId)) {
        throw new Error("The requested session is still initializing");
      }
      this.#sessionInitializations.add(sessionId);
      try {
        const pipeline = nativeNodeSurface.getDefaultNativePipeline({});
        if (observedAt === undefined) {
          throw new Error("Durable session observation time is unavailable");
        }
        const stored = await this.#durableSessions.load(sessionId, observedAt);
        if (stored !== undefined) {
          try {
            const session = this.#durableSessions.restore({
              archive: stored.bytes,
              expectedSessionId: sessionId,
              observedAtEpochSeconds: observedAt,
              restorer: pipeline,
            });
            if (
              session.inspect(observedAt).expiresAtEpochSeconds !==
              stored.expiresAtEpochSeconds
            ) {
              throw new Error(
                "Durable session archive expiry does not match storage",
              );
            }
            entry = {
              expiresAtEpochSeconds: stored.expiresAtEpochSeconds,
              language: undefined,
              session,
              restoreSession: (plaintextJson) =>
                pipeline.restoreRedactionSession(plaintextJson),
              status: "ready",
            };
            this.#sessions.set(sessionId, entry);
          } catch (error) {
            throw new Error("The requested durable session is unavailable", {
              cause: error,
            });
          }
        }
      } finally {
        this.#sessionInitializations.delete(sessionId);
      }
    }
    if (entry === undefined) {
      throw new Error("The requested session is unavailable");
    }
    if (
      observedAt !== undefined &&
      entry.expiresAtEpochSeconds !== undefined &&
      observedAt >= entry.expiresAtEpochSeconds
    ) {
      this.#sessions.delete(sessionId);
      await this.#durableSessions?.delete(sessionId);
      throw new Error("The requested session is unavailable");
    }
    if (entry.status !== "ready") {
      throw new Error("The requested in-memory session is unavailable");
    }
    entry.status = "busy";
    return {
      entry,
      observedAtEpochSeconds: observedAt,
      sessionId,
      rollback: { type: "release" },
    };
  }

  async #persistSession(
    sessionId: string,
    session: RedactionSession,
    operationObservedAtEpochSeconds?: number,
  ): Promise<void> {
    if (this.#durableSessions === undefined) {
      return;
    }
    const observedAt = operationObservedAtEpochSeconds ?? this.#observedAt();
    const archive = this.#durableSessions.seal(session, observedAt);
    const expiresAtEpochSeconds =
      session.inspect(observedAt).expiresAtEpochSeconds;
    if (expiresAtEpochSeconds === null) {
      throw new Error("MCP durable session is missing its expiry policy");
    }
    await this.#durableSessions.save({
      sessionId,
      archive,
      expiresAtEpochSeconds,
      observedAtEpochSeconds: observedAt,
    });
  }

  async anonymizeText(
    input: z.infer<typeof textInput>,
  ): Promise<AuditSafeResult> {
    return this.#runOperation(() => this.#anonymizeText(input));
  }

  async #anonymizeText(
    input: z.infer<typeof textInput>,
  ): Promise<AuditSafeResult> {
    const source = await this.#scope.readInput({
      path: input.inputPath,
      extension: ".txt",
      maximumBytes: TEXT_MAX_BYTES,
      label: "Text",
    });
    const destination = await this.#scope.output(input.outputPath, ".txt");
    assertDifferentPaths(source.path, destination.path);
    const text = decodeText(source.bytes);
    const lease = await this.#session(input.sessionId, input.language);
    try {
      const result =
        lease.observedAtEpochSeconds === undefined
          ? lease.entry.session.redact_text(text)
          : lease.entry.session.redactTextAt({
              fullText: text,
              observedAtEpochSeconds: lease.observedAtEpochSeconds,
            });
      await this.#persistSession(
        input.sessionId,
        lease.entry.session,
        lease.observedAtEpochSeconds,
      );
      this.#faults.beforeOutputPublish?.();
      await destination.write(result.redaction.redactedText);
      this.#commitSession(lease);
      return {
        operation: "anonymize",
        format: "text",
        outputCreated: true,
        sessionId: input.sessionId,
        entityCount: result.redaction.entityCount,
      };
    } catch (error) {
      await this.#rollbackSession(lease);
      throw error;
    }
  }

  async restoreText(
    input: z.infer<typeof restoreInput>,
  ): Promise<AuditSafeResult> {
    return this.#runOperation(() => this.#restoreText(input));
  }

  async anonymizeTextWithExternalDetections(
    input: z.infer<typeof externalDetectionTextInput>,
  ): Promise<AuditSafeResult> {
    try {
      return await this.#runOperation(() =>
        this.#anonymizeTextWithExternalDetections(input),
      );
    } catch (error) {
      throw externalDetectionFailure(
        error,
        EXTERNAL_DETECTION_FAILURES.operationFailed,
      );
    }
  }

  async #anonymizeTextWithExternalDetections(
    input: z.infer<typeof externalDetectionTextInput>,
  ): Promise<AuditSafeResult> {
    const { batch, destination, source } = await externalDetectionStep(
      EXTERNAL_DETECTION_FAILURES.inputRejected,
      async () => {
        const scopedSource = await this.#scope.readInput({
          path: input.inputPath,
          extension: ".txt",
          maximumBytes: TEXT_MAX_BYTES,
          label: "Text",
        });
        const scopedBatch = await this.#scope.readInput({
          path: input.detectionBatchPath,
          extension: ".json",
          maximumBytes: EXTERNAL_DETECTION_BATCH_MAX_BYTES,
          label: "External detection batch",
        });
        const scopedDestination = await this.#scope.output(
          input.outputPath,
          ".txt",
        );
        assertDifferentPaths(scopedSource.path, scopedDestination.path);
        assertDifferentPaths(scopedBatch.path, scopedDestination.path);
        assertDifferentPaths(scopedSource.path, scopedBatch.path);
        return {
          batch: scopedBatch,
          destination: scopedDestination,
          source: scopedSource,
        };
      },
    );
    const text = await externalDetectionStep(
      EXTERNAL_DETECTION_FAILURES.documentRejected,
      () => decodeText(source.bytes),
    );
    const detections = await externalDetectionStep(
      EXTERNAL_DETECTION_FAILURES.batchRejected,
      () =>
        nativeNodeSurface.convert_external_detection_batch(
          source.bytes,
          decodeUtf8(batch.bytes, "External detection batches"),
        ),
    );
    const lease = await externalDetectionStep(
      EXTERNAL_DETECTION_FAILURES.sessionRejected,
      () => this.#session(input.sessionId, input.language),
    );
    try {
      const plan = lease.entry.session.planTextBatchWithCallerDetections({
        inputs: [{ fullText: text, detections }],
        ...(lease.observedAtEpochSeconds === undefined
          ? {}
          : { observedAtEpochSeconds: lease.observedAtEpochSeconds }),
      });
      const block = plan.blocks.at(0);
      if (plan.blocks.length !== 1 || block === undefined) {
        throw new Error(
          "Native caller-detection plan did not match the text input",
        );
      }
      const redactedText = applyTextReplacements(text, block.replacements);
      plan.commit();
      await this.#persistSession(
        input.sessionId,
        lease.entry.session,
        lease.observedAtEpochSeconds,
      );
      this.#faults.beforeOutputPublish?.();
      await destination.write(redactedText);
      this.#commitSession(lease);
      return {
        operation: "anonymize",
        format: "text",
        outputCreated: true,
        sessionId: input.sessionId,
        entityCount: block.entityCount,
        externalDetectionBatchStatus: "accepted",
        externalDetectionCount: detections.length,
        retainedExternalDetectionCount: block.callerEntityCount,
      };
    } catch (error) {
      await this.#rollbackSession(lease);
      throw externalDetectionFailure(
        error,
        EXTERNAL_DETECTION_FAILURES.operationFailed,
      );
    }
  }

  async #restoreText(
    input: z.infer<typeof restoreInput>,
  ): Promise<AuditSafeResult> {
    const source = await this.#scope.readInput({
      path: input.inputPath,
      extension: ".txt",
      maximumBytes: TEXT_MAX_BYTES,
      label: "Text",
    });
    const destination = await this.#scope.output(input.outputPath, ".txt");
    assertDifferentPaths(source.path, destination.path);
    const text = decodeText(source.bytes);
    const lease = await this.#readSession(input.sessionId);
    try {
      const restored = lease.entry.session.restoreText(
        text,
        lease.observedAtEpochSeconds,
      );
      await destination.write(restored);
      this.#commitSession(lease);
      return {
        operation: "restore",
        format: "text",
        outputCreated: true,
        sessionId: input.sessionId,
      };
    } catch (error) {
      await this.#rollbackSession(lease);
      throw error;
    }
  }

  async anonymizeDocx(
    input: z.infer<typeof docxInput>,
  ): Promise<AuditSafeResult> {
    return this.#runOperation(() => this.#anonymizeDocx(input));
  }

  async #anonymizeDocx(
    input: z.infer<typeof docxInput>,
  ): Promise<AuditSafeResult> {
    const source = await this.#scope.readInput({
      path: input.inputPath,
      extension: ".docx",
      maximumBytes: DOCX_ARCHIVE_MAX_BYTES,
      label: "DOCX",
    });
    const destination = await this.#scope.output(input.outputPath, ".docx");
    assertDifferentPaths(source.path, destination.path);
    const lease = await this.#session(input.sessionId, input.language);
    try {
      const result = anonymizeDocx({
        document: source.bytes,
        session: lease.entry.session,
        expectedSessionId: input.sessionId,
        policy: {
          coverage: {
            mode: input.allowPartialCoverage
              ? DOCX_COVERAGE_MODES.allowPartial
              : DOCX_COVERAGE_MODES.requireFull,
          },
        },
        ...(lease.observedAtEpochSeconds === undefined
          ? {}
          : { observedAtEpochSeconds: lease.observedAtEpochSeconds }),
      });
      await this.#persistSession(
        input.sessionId,
        lease.entry.session,
        lease.observedAtEpochSeconds,
      );
      this.#faults.beforeOutputPublish?.();
      await destination.write(result.document);
      this.#commitSession(lease);
      return {
        operation: "anonymize",
        format: "docx",
        outputCreated: true,
        sessionId: input.sessionId,
        entityCount: result.summary.entityCount,
        blockCount: result.summary.blockCount,
        rewrittenBlockCount: result.summary.rewrittenBlockCount,
        coverageStatus: result.summary.coverage.status,
      };
    } catch (error) {
      await this.#rollbackSession(lease);
      throw error;
    }
  }

  async restoreDocx(
    input: z.infer<typeof docxRestoreInput>,
  ): Promise<AuditSafeResult> {
    return this.#runOperation(() => this.#restoreDocx(input));
  }

  async #restoreDocx(
    input: z.infer<typeof docxRestoreInput>,
  ): Promise<AuditSafeResult> {
    const source = await this.#scope.readInput({
      path: input.inputPath,
      extension: ".docx",
      maximumBytes: DOCX_ARCHIVE_MAX_BYTES,
      label: "DOCX",
    });
    const destination = await this.#scope.output(input.outputPath, ".docx");
    assertDifferentPaths(source.path, destination.path);
    const lease = await this.#readSession(input.sessionId);
    try {
      const result = restoreDocxText({
        document: source.bytes,
        session: lease.entry.session,
        expectedSessionId: input.sessionId,
        ...(lease.observedAtEpochSeconds === undefined
          ? {}
          : { observedAtEpochSeconds: lease.observedAtEpochSeconds }),
      });
      if (result.coverage.status === "partial" && !input.allowPartialCoverage) {
        throw new Error(
          "DOCX restoration has partial coverage; set allowPartialCoverage to publish it",
        );
      }
      await destination.write(result.document);
      this.#commitSession(lease);
      return {
        operation: "restore",
        format: "docx",
        outputCreated: true,
        sessionId: input.sessionId,
        rewrittenBlockCount: result.restoredBlockCount,
        restoredPlaceholderCount: result.restoredPlaceholderCount,
        coverageStatus: result.coverage.status,
      };
    } catch (error) {
      await this.#rollbackSession(lease);
      throw error;
    }
  }

  async inspectDocx(inputPath: string): Promise<AuditSafeResult> {
    return this.#runOperation(() => this.#inspectDocx(inputPath));
  }

  async #inspectDocx(inputPath: string): Promise<AuditSafeResult> {
    const source = await this.#scope.readInput({
      path: inputPath,
      extension: ".docx",
      maximumBytes: DOCX_ARCHIVE_MAX_BYTES,
      label: "DOCX",
    });
    const extraction = extractDocxText(source.bytes);
    const unsupported = extraction.coverage.parts.some(
      (part) => part.status === "unsupported",
    );
    const structuralGap =
      extraction.coverage.hyperlinkTextSegmentCount > 0 ||
      extraction.coverage.revisionTextSegmentCount > 0 ||
      extraction.coverage.unsupportedAlternateContentCount > 0 ||
      extraction.coverage.unsupportedFieldInstructionCount > 0 ||
      extraction.coverage.unsupportedSymbolCount > 0;
    return {
      operation: "inspect",
      format: "docx",
      outputCreated: false,
      blockCount: extraction.blocks.length,
      coverageStatus: unsupported || structuralGap ? "partial" : "full",
    };
  }
}

const result = (value: AuditSafeResult) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: { ...value },
});

const MCP_TOOL_NAMES = [
  "anonymize_docx_file",
  "anonymize_text_file",
  "anonymize_text_file_with_external_detections",
  "capabilities",
  "inspect_docx_file",
  "restore_docx_file",
  "restore_text_file",
] as const;

const capabilitiesResult = (service: LocalAnonymizeService) => {
  const value = {
    capabilityManifest: CAPABILITY_MANIFEST,
    runtimeVersion: nativeNodeSurface.native_package_version(),
    mcp: {
      externalDetectionBatch: {
        ingestion: "path-only" as const,
        version: EXTERNAL_DETECTION_BATCH_VERSION,
      },
      formats: ["docx", "text"] as const,
      sessionMode: service.sessionMode,
      sessionTtlSeconds: service.sessionTtlSeconds,
      tools: MCP_TOOL_NAMES,
      transport: "stdio" as const,
    },
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
};

const externalDetectionErrorResult = (error: unknown) => {
  const failure = externalDetectionFailure(
    error,
    EXTERNAL_DETECTION_FAILURES.operationFailed,
  );
  const value = { errorCode: failure.code, message: failure.message };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
};

export const createAnonymizeMcpServer = (
  service: LocalAnonymizeService,
): McpServer => {
  const server = new McpServer(
    {
      name: "stella-anonymize-local",
      version: nativeNodeSurface.native_package_version(),
    },
    {
      instructions:
        "All tools accept local paths only. Never request or return document contents or session mappings. Outputs must be new explicit paths inside configured roots.",
    },
  );
  server.registerTool(
    "capabilities",
    {
      description:
        "Return the public runtime capability manifest and MCP surface metadata.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => capabilitiesResult(service),
  );
  server.registerTool(
    "anonymize_text_file",
    {
      description: "Anonymize a local UTF-8 text file into a new local file.",
      inputSchema: textInput,
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => result(await service.anonymizeText(input)),
  );
  server.registerTool(
    "restore_text_file",
    {
      description: "Restore a text file using the configured session store.",
      inputSchema: restoreInput,
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => result(await service.restoreText(input)),
  );
  server.registerTool(
    "anonymize_text_file_with_external_detections",
    {
      description:
        "Anonymize a local UTF-8 text file with a provider-neutral ExternalDetectionBatch v1 JSON sidecar into a new local file.",
      inputSchema: externalDetectionTextInput,
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        return result(await service.anonymizeTextWithExternalDetections(input));
      } catch (error) {
        return externalDetectionErrorResult(error);
      }
    },
  );
  server.registerTool(
    "anonymize_docx_file",
    {
      description:
        "Structure-preservingly anonymize a local DOCX into a new local DOCX.",
      inputSchema: docxInput,
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => result(await service.anonymizeDocx(input)),
  );
  server.registerTool(
    "restore_docx_file",
    {
      description: "Restore a DOCX using the configured session store.",
      inputSchema: docxRestoreInput,
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => result(await service.restoreDocx(input)),
  );
  server.registerTool(
    "inspect_docx_file",
    {
      description:
        "Return only aggregate DOCX coverage and block counts; never document text.",
      inputSchema: z.object({
        inputPath: z.string().min(1).max(PATH_MAX_CHARACTERS),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ inputPath }) => result(await service.inspectDocx(inputPath)),
  );
  return server;
};
