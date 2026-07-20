import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { extractDocxText } from "@stll/anonymize-docx";
import { strToU8, zipSync } from "fflate";
import { readFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LocalAnonymizeService,
  PathScope,
  createAnonymizeMcpServer,
} from "../local";

const temporaryDirectories: string[] = [];
const WORD_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const PACKAGE_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const writeDocx = async (path: string, body: string): Promise<void> => {
  await writeFile(
    path,
    zipSync({
      "[Content_Types].xml": strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_NAMESPACE}"><Relationship Id="rId1" Type="${OFFICE_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${body}</w:body></w:document>`,
      ),
    }),
  );
};

const packageVersion = (): string => {
  const manifest: unknown = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    throw new TypeError("MCP package version is unavailable");
  }
  return manifest.version;
};

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "stella-mcp-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("PathScope", () => {
  test("allows regular files and new outputs only inside canonical roots", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const input = join(root, "input.txt");
    const existing = join(root, "existing.txt");
    const dotDotDirectory = join(root, "..fixtures");
    const dotDotInput = join(dotDotDirectory, "input.txt");
    await mkdir(dotDotDirectory);
    await writeFile(input, "Alice");
    await writeFile(existing, "occupied");
    await writeFile(dotDotInput, "Bob");
    const scope = await PathScope.create([root]);

    const scopedInput = await scope.readInput({
      path: input,
      extension: ".txt",
      maximumBytes: 1024,
      label: "Text",
    });
    expect(scopedInput.path).toBe(await realpath(input));
    expect(new TextDecoder().decode(scopedInput.bytes)).toBe("Alice");
    expect((await scope.output(join(root, "output.txt"), ".txt")).path).toBe(
      join(root, "output.txt"),
    );
    expect(
      (
        await scope.readInput({
          path: dotDotInput,
          extension: ".txt",
          maximumBytes: 1024,
          label: "Text",
        })
      ).path,
    ).toBe(await realpath(dotDotInput));
    expect(
      (await scope.output(join(dotDotDirectory, "output.txt"), ".txt")).path,
    ).toBe(join(dotDotDirectory, "output.txt"));
    await expect(scope.output(existing, ".txt")).rejects.toThrow(
      "already exists",
    );
    await expect(
      scope.readInput({
        path: join(outside, "missing.txt"),
        extension: ".txt",
        maximumBytes: 1024,
        label: "Text",
      }),
    ).rejects.toThrow();
  });

  test("rejects a symlink that escapes an allowed root", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const target = join(outside, "secret.txt");
    const link = join(root, "linked.txt");
    const insideTarget = join(root, "inside.txt");
    const insideLink = join(root, "inside-linked.txt");
    await writeFile(target, "secret");
    await writeFile(insideTarget, "inside");
    await symlink(target, link);
    await symlink(insideTarget, insideLink);
    const scope = await PathScope.create([root]);
    await expect(
      scope.readInput({
        path: link,
        extension: ".txt",
        maximumBytes: 1024,
        label: "Text",
      }),
    ).rejects.toThrow("outside the configured roots");
    await expect(
      scope.readInput({
        path: insideLink,
        extension: ".txt",
        maximumBytes: 1024,
        label: "Text",
      }),
    ).rejects.toThrow();
    const linkedDirectory = join(root, "linked-directory");
    await symlink(outside, linkedDirectory);
    await expect(
      scope.output(join(linkedDirectory, "output.txt"), ".txt"),
    ).rejects.toThrow("outside the configured roots");
  });

  test("rejects publication when the validated output directory is replaced", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const directory = join(root, "output-directory");
    const movedDirectory = join(root, "moved-output-directory");
    const outputPath = join(directory, "output.txt");
    await mkdir(directory);
    const scope = await PathScope.create([root]);
    const output = await scope.output(outputPath, ".txt");

    await rename(directory, movedDirectory);
    await symlink(outside, directory);
    await expect(output.write("sensitive output")).rejects.toThrow(
      "Output directory changed",
    );
    await expect(readFile(join(outside, "output.txt"))).rejects.toThrow();
    await expect(
      readFile(join(movedDirectory, "output.txt")),
    ).rejects.toThrow();
  });
});

describe("local MCP surface", () => {
  test("anonymizes and restores text without returning file contents", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "input.txt");
    const anonymized = join(root, "anonymized.txt");
    const restored = join(root, "restored.txt");
    await writeFile(input, "Alice Smith signed.");
    const service = new LocalAnonymizeService(await PathScope.create([root]));

    const anonymizeResult = await service.anonymizeText({
      inputPath: input,
      outputPath: anonymized,
      sessionId: "local_case_1",
      language: "en",
    });
    expect(anonymizeResult).toMatchObject({
      operation: "anonymize",
      outputCreated: true,
      sessionId: "local_case_1",
    });
    expect(JSON.stringify(anonymizeResult)).not.toContain("Alice");
    expect(await readFile(anonymized, "utf8")).not.toBe("Alice Smith signed.");
    expect((await stat(anonymized)).mode & 0o777).toBe(0o600);
    await expect(
      service.anonymizeText({
        inputPath: input,
        outputPath: join(root, "language-mismatch.txt"),
        sessionId: "local_case_1",
        language: "de",
      }),
    ).rejects.toThrow("cannot change language");

    const restoreResult = await service.restoreText({
      inputPath: anonymized,
      outputPath: restored,
      sessionId: "local_case_1",
    });
    expect(restoreResult.operation).toBe("restore");
    expect(await readFile(restored, "utf8")).toBe("Alice Smith signed.");
  });

  test("rejects invalid UTF-8 without creating an output", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "invalid.txt");
    const output = join(root, "output.txt");
    await writeFile(input, new Uint8Array([0xc3, 0x28]));
    const service = new LocalAnonymizeService(await PathScope.create([root]));

    await expect(
      service.anonymizeText({
        inputPath: input,
        outputPath: output,
        sessionId: "invalid_utf8_1",
        language: "en",
      }),
    ).rejects.toThrow("valid UTF-8");
    await expect(readFile(output)).rejects.toThrow();
  });

  test("rolls back an existing session when output publication fails", async () => {
    const root = await temporaryDirectory();
    const firstInput = join(root, "first.txt");
    const firstOutput = join(root, "first-output.txt");
    const failedInput = join(root, "failed.txt");
    const tooLongTemporary = join(root, `${"x".repeat(240)}.txt`);
    const probeInput = join(root, "probe.txt");
    const probeOutput = join(root, "probe-output.txt");
    const recoveredOutput = join(root, "recovered.txt");
    await writeFile(firstInput, "Alice Smith signed.");
    await writeFile(failedInput, "Bob Jones signed.");
    const service = new LocalAnonymizeService(await PathScope.create([root]));
    await service.anonymizeText({
      inputPath: firstInput,
      outputPath: firstOutput,
      sessionId: "rollback_case_1",
      language: "en",
    });

    await expect(
      service.anonymizeText({
        inputPath: failedInput,
        outputPath: tooLongTemporary,
        sessionId: "rollback_case_1",
      }),
    ).rejects.toThrow();
    const predictedPlaceholder = "[PERSON_rollback%5Fcase%5F1_2]";
    await writeFile(probeInput, predictedPlaceholder);
    await expect(
      service.restoreText({
        inputPath: probeInput,
        outputPath: probeOutput,
        sessionId: "rollback_case_1",
      }),
    ).rejects.toThrow("unknown session placeholder");
    await expect(readFile(probeOutput)).rejects.toThrow();
    await service.restoreText({
      inputPath: firstOutput,
      outputPath: recoveredOutput,
      sessionId: "rollback_case_1",
    });
    expect(await readFile(recoveredOutput, "utf8")).toBe("Alice Smith signed.");
  });

  test("anonymizes and restores DOCX through path-only operations", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "input.docx");
    const anonymized = join(root, "anonymized.docx");
    const restored = join(root, "restored.docx");
    await writeDocx(
      input,
      "<w:p><w:r><w:t>Alice Smith signed.</w:t></w:r></w:p>",
    );
    const service = new LocalAnonymizeService(await PathScope.create([root]));
    const anonymizeResult = await service.anonymizeDocx({
      inputPath: input,
      outputPath: anonymized,
      sessionId: "local_docx_1",
      language: "en",
      allowPartialCoverage: false,
    });
    expect(anonymizeResult.coverageStatus).toBe("full");
    expect(
      extractDocxText(await readFile(anonymized)).blocks.at(0)?.text,
    ).not.toBe("Alice Smith signed.");

    await service.restoreDocx({
      inputPath: anonymized,
      outputPath: restored,
      sessionId: "local_docx_1",
      allowPartialCoverage: false,
    });
    expect(extractDocxText(await readFile(restored)).blocks.at(0)?.text).toBe(
      "Alice Smith signed.",
    );
  });

  test("reports and fails closed on partial DOCX coverage", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "partial.docx");
    const rejectedAnonymized = join(root, "partial-rejected-anonymized.docx");
    const anonymized = join(root, "partial-anonymized.docx");
    const rejectedRestore = join(root, "partial-rejected.docx");
    const restored = join(root, "partial-restored.docx");
    await writeDocx(
      input,
      "<w:p><w:r><w:t>Alice Smith signed.</w:t></w:r><w:hyperlink><w:r><w:t>Linked Name</w:t></w:r></w:hyperlink></w:p>",
    );
    const service = new LocalAnonymizeService(await PathScope.create([root]));

    expect((await service.inspectDocx(input)).coverageStatus).toBe("partial");
    await expect(
      service.anonymizeDocx({
        inputPath: input,
        outputPath: rejectedAnonymized,
        sessionId: "local_partial_docx_1",
        language: "de",
        allowPartialCoverage: false,
      }),
    ).rejects.toThrow("outside the fully supported");
    await expect(readFile(rejectedAnonymized)).rejects.toThrow();
    const anonymizeResult = await service.anonymizeDocx({
      inputPath: input,
      outputPath: anonymized,
      sessionId: "local_partial_docx_1",
      language: "en",
      allowPartialCoverage: true,
    });
    expect(anonymizeResult.coverageStatus).toBe("partial");
    await expect(
      service.restoreDocx({
        inputPath: anonymized,
        outputPath: rejectedRestore,
        sessionId: "local_partial_docx_1",
        allowPartialCoverage: false,
      }),
    ).rejects.toThrow("partial coverage");
    await expect(readFile(rejectedRestore)).rejects.toThrow();

    const restoreResult = await service.restoreDocx({
      inputPath: anonymized,
      outputPath: restored,
      sessionId: "local_partial_docx_1",
      allowPartialCoverage: true,
    });
    expect(restoreResult.coverageStatus).toBe("partial");
    expect(extractDocxText(await readFile(restored)).blocks.at(0)?.text).toBe(
      "Alice Smith signed.Linked Name",
    );
  });

  test("registers only path-oriented tools", async () => {
    const root = await temporaryDirectory();
    const scope = await PathScope.create([root]);
    const server = createAnonymizeMcpServer(new LocalAnonymizeService(scope));
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    expect(client.getServerVersion()?.version).toBe(packageVersion());
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name).toSorted()).toEqual([
      "anonymize_docx_file",
      "anonymize_text_file",
      "inspect_docx_file",
      "restore_docx_file",
      "restore_text_file",
    ]);
    for (const tool of tools.tools) {
      const properties = tool.inputSchema.properties ?? {};
      expect(properties).not.toHaveProperty("text");
      expect(properties).not.toHaveProperty("document");
      expect(properties).not.toHaveProperty("mapping");
    }
    await client.close();
  });
});
