import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

const TEXT_MAX_BYTES = 64 * 1024 * 1024;
const PATH_MAX_CHARACTERS = 32_768;
const SESSION_MAX_COUNT = 256;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

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
  extension: ".docx" | ".txt";
  maximumBytes: number;
  label: "DOCX" | "Text";
};

type ScopedInput = {
  bytes: Uint8Array;
  path: string;
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
    const handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
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
      const bytes = await handle.readFile();
      if (bytes.byteLength > maximumBytes) {
        throw new Error(
          `${label} inputs must not exceed ${maximumBytes} bytes`,
        );
      }
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
  language: string | undefined;
  session: RedactionSession;
  restoreSession: (plaintextJson: string) => RedactionSession;
  status: "busy" | "initializing" | "ready";
};

type SessionLease = {
  entry: SessionEntry;
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
    toPlaintextJson(): string;
  };

type NativeNodeSurface = {
  getDefaultNativePipeline: (options: { language?: string }) => {
    createRedactionSession: (sessionId: string) => RedactionSession;
    restoreRedactionSession: (plaintextJson: string) => RedactionSession;
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
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("Text inputs must contain valid UTF-8", { cause: error });
  }
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
  readonly #scope: PathScope;
  readonly #sessions = new Map<string, SessionEntry>();

  constructor(scope: PathScope) {
    this.#scope = scope;
  }

  #session(sessionId: string, language?: string): SessionLease {
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
      const checkpoint = existing.session.toPlaintextJson();
      existing.status = "busy";
      return {
        entry: existing,
        sessionId,
        rollback: { type: "restore", checkpoint },
      };
    }
    if (this.#sessions.size >= SESSION_MAX_COUNT) {
      throw new Error(`MCP sessions must not exceed ${SESSION_MAX_COUNT}`);
    }
    const pipeline = nativeNodeSurface.getDefaultNativePipeline(
      language === undefined ? {} : { language },
    );
    const session = pipeline.createRedactionSession(sessionId);
    const entry: SessionEntry = {
      language,
      session,
      restoreSession: (plaintextJson) =>
        pipeline.restoreRedactionSession(plaintextJson),
      status: "initializing",
    };
    this.#sessions.set(sessionId, entry);
    return {
      entry,
      sessionId,
      rollback: { type: "delete" },
    };
  }

  #commitSession({ entry }: SessionLease): void {
    entry.status = "ready";
  }

  #rollbackSession({ entry, rollback, sessionId }: SessionLease): void {
    if (this.#sessions.get(sessionId) !== entry) {
      return;
    }
    if (rollback.type === "delete") {
      this.#sessions.delete(sessionId);
      return;
    }
    if (rollback.type === "release") {
      entry.status = "ready";
      return;
    }
    try {
      entry.session = entry.restoreSession(rollback.checkpoint);
      entry.status = "ready";
    } catch {
      this.#sessions.delete(sessionId);
    }
  }

  #readSession(sessionId: string): SessionLease {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) {
      throw new Error("The requested in-memory session is unavailable");
    }
    if (entry.status !== "ready") {
      throw new Error("The requested in-memory session is unavailable");
    }
    entry.status = "busy";
    return { entry, sessionId, rollback: { type: "release" } };
  }

  async anonymizeText(
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
    const lease = this.#session(input.sessionId, input.language);
    try {
      const result = lease.entry.session.redact_text(text);
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
      this.#rollbackSession(lease);
      throw error;
    }
  }

  async restoreText(
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
    const lease = this.#readSession(input.sessionId);
    try {
      const restored = lease.entry.session.restoreText(text);
      await destination.write(restored);
      this.#commitSession(lease);
      return {
        operation: "restore",
        format: "text",
        outputCreated: true,
        sessionId: input.sessionId,
      };
    } catch (error) {
      this.#rollbackSession(lease);
      throw error;
    }
  }

  async anonymizeDocx(
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
    const lease = this.#session(input.sessionId, input.language);
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
      });
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
      this.#rollbackSession(lease);
      throw error;
    }
  }

  async restoreDocx(
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
    const lease = this.#readSession(input.sessionId);
    try {
      const result = restoreDocxText({
        document: source.bytes,
        session: lease.entry.session,
        expectedSessionId: input.sessionId,
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
      this.#rollbackSession(lease);
      throw error;
    }
  }

  async inspectDocx(inputPath: string): Promise<AuditSafeResult> {
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
      description:
        "Restore a text file using an in-memory session from this server process.",
      inputSchema: restoreInput,
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) => result(await service.restoreText(input)),
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
      description:
        "Restore a DOCX using an in-memory session from this server process.",
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
