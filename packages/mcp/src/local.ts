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
  link,
  lstat,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
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
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

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

  async input(path: string, extension: ".docx" | ".txt"): Promise<string> {
    if (!isAbsolute(path) || extname(path).toLowerCase() !== extension) {
      throw new Error(`Input must be an absolute ${extension} path`);
    }
    const canonical = await realpath(path);
    if (!this.#roots.some((root) => inside(root, canonical))) {
      throw new Error("Input is outside the configured roots");
    }
    const metadata = await stat(canonical);
    if (!metadata.isFile()) {
      throw new Error("Input must be a regular file");
    }
    return canonical;
  }

  async output(path: string, extension: ".docx" | ".txt"): Promise<string> {
    if (!isAbsolute(path) || extname(path).toLowerCase() !== extension) {
      throw new Error(`Output must be an absolute ${extension} path`);
    }
    const normalized = resolve(path);
    const parent = await realpath(dirname(normalized));
    if (!this.#roots.some((root) => inside(root, parent))) {
      throw new Error("Output is outside the configured roots");
    }
    try {
      await lstat(normalized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return normalized;
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
};

type RedactionSession = DocxAnonymizationSession &
  DocxRestorationSession & {
    redact_text(text: string): {
      redaction: { redactedText: string; entityCount: number };
    };
    restoreText(text: string): string;
  };

type NativeNodeSurface = {
  getDefaultNativePipeline: (options: { language?: string }) => {
    createRedactionSession: (sessionId: string) => RedactionSession;
  };
  native_package_version: () => string;
};

const nativeNodeSurface = nativeNode as unknown as NativeNodeSurface; // SAFETY: These native-node runtime exports are public, but their generated declarations are minified during workspace builds.

const safeWrite = async (
  path: string,
  bytes: Uint8Array | string,
): Promise<void> => {
  const temporary = `${path}.stella-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

type ReadBoundedFileOptions = {
  path: string;
  maximumBytes: number;
  label: "DOCX" | "Text";
};

const readBoundedFile = async ({
  path,
  maximumBytes,
  label,
}: ReadBoundedFileOptions): Promise<Uint8Array> => {
  const metadata = await stat(path);
  if (metadata.size > maximumBytes) {
    throw new Error(`${label} inputs must not exceed ${maximumBytes} bytes`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`${label} inputs must not exceed ${maximumBytes} bytes`);
  }
  return bytes;
};

const readTextFile = async (path: string): Promise<string> => {
  const bytes = await readBoundedFile({
    path,
    maximumBytes: TEXT_MAX_BYTES,
    label: "Text",
  });
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

const docxInput = textInput.extend({
  allowPartialCoverage: z.boolean().optional().default(false),
});

export class LocalAnonymizeService {
  readonly #scope: PathScope;
  readonly #sessions = new Map<string, SessionEntry>();

  constructor(scope: PathScope) {
    this.#scope = scope;
  }

  #session(sessionId: string, language?: string): RedactionSession {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      if (existing.language !== language) {
        throw new Error("A session cannot change language");
      }
      return existing.session;
    }
    if (this.#sessions.size >= SESSION_MAX_COUNT) {
      throw new Error(`MCP sessions must not exceed ${SESSION_MAX_COUNT}`);
    }
    const pipeline = nativeNodeSurface.getDefaultNativePipeline(
      language === undefined ? {} : { language },
    );
    const session = pipeline.createRedactionSession(sessionId);
    this.#sessions.set(sessionId, { language, session });
    return session;
  }

  #existingSession(sessionId: string): RedactionSession {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) {
      throw new Error("The requested in-memory session is unavailable");
    }
    return entry.session;
  }

  async anonymizeText(
    input: z.infer<typeof textInput>,
  ): Promise<AuditSafeResult> {
    const source = await this.#scope.input(input.inputPath, ".txt");
    const destination = await this.#scope.output(input.outputPath, ".txt");
    assertDifferentPaths(source, destination);
    const text = await readTextFile(source);
    const result = this.#session(input.sessionId, input.language).redact_text(
      text,
    );
    await safeWrite(destination, result.redaction.redactedText);
    return {
      operation: "anonymize",
      format: "text",
      outputCreated: true,
      sessionId: input.sessionId,
      entityCount: result.redaction.entityCount,
    };
  }

  async restoreText(
    input: z.infer<typeof restoreInput>,
  ): Promise<AuditSafeResult> {
    const source = await this.#scope.input(input.inputPath, ".txt");
    const destination = await this.#scope.output(input.outputPath, ".txt");
    assertDifferentPaths(source, destination);
    const restored = this.#existingSession(input.sessionId).restoreText(
      await readTextFile(source),
    );
    await safeWrite(destination, restored);
    return {
      operation: "restore",
      format: "text",
      outputCreated: true,
      sessionId: input.sessionId,
    };
  }

  async anonymizeDocx(
    input: z.infer<typeof docxInput>,
  ): Promise<AuditSafeResult> {
    const source = await this.#scope.input(input.inputPath, ".docx");
    const destination = await this.#scope.output(input.outputPath, ".docx");
    assertDifferentPaths(source, destination);
    const result = anonymizeDocx({
      document: await readBoundedFile({
        path: source,
        maximumBytes: DOCX_ARCHIVE_MAX_BYTES,
        label: "DOCX",
      }),
      session: this.#session(input.sessionId, input.language),
      expectedSessionId: input.sessionId,
      policy: {
        coverage: {
          mode: input.allowPartialCoverage
            ? DOCX_COVERAGE_MODES.allowPartial
            : DOCX_COVERAGE_MODES.requireFull,
        },
      },
    });
    await safeWrite(destination, result.document);
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
  }

  async restoreDocx(
    input: z.infer<typeof restoreInput>,
  ): Promise<AuditSafeResult> {
    const source = await this.#scope.input(input.inputPath, ".docx");
    const destination = await this.#scope.output(input.outputPath, ".docx");
    assertDifferentPaths(source, destination);
    const result = restoreDocxText({
      document: await readBoundedFile({
        path: source,
        maximumBytes: DOCX_ARCHIVE_MAX_BYTES,
        label: "DOCX",
      }),
      session: this.#existingSession(input.sessionId),
      expectedSessionId: input.sessionId,
    });
    await safeWrite(destination, result.document);
    return {
      operation: "restore",
      format: "docx",
      outputCreated: true,
      sessionId: input.sessionId,
      rewrittenBlockCount: result.restoredBlockCount,
      restoredPlaceholderCount: result.restoredPlaceholderCount,
      coverageStatus: result.coverage.status,
    };
  }

  async inspectDocx(inputPath: string): Promise<AuditSafeResult> {
    const source = await this.#scope.input(inputPath, ".docx");
    const extraction = extractDocxText(
      await readBoundedFile({
        path: source,
        maximumBytes: DOCX_ARCHIVE_MAX_BYTES,
        label: "DOCX",
      }),
    );
    const unsupported = extraction.coverage.parts.some(
      (part) => part.status === "unsupported",
    );
    const structuralGap =
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
      inputSchema: restoreInput,
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
