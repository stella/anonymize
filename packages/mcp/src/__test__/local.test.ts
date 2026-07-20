import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { extractDocxText } from "@stll/anonymize-docx";
import { strToU8, zipSync } from "fflate";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
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
    await writeFile(input, "Alice");
    await writeFile(existing, "occupied");
    const scope = await PathScope.create([root]);

    expect(await scope.input(input, ".txt")).toBe(await realpath(input));
    expect(await scope.output(join(root, "output.txt"), ".txt")).toBe(
      join(root, "output.txt"),
    );
    await expect(scope.output(existing, ".txt")).rejects.toThrow(
      "already exists",
    );
    await expect(
      scope.input(join(outside, "missing.txt"), ".txt"),
    ).rejects.toThrow();
  });

  test("rejects a symlink that escapes an allowed root", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const target = join(outside, "secret.txt");
    const link = join(root, "linked.txt");
    await writeFile(target, "secret");
    await symlink(target, link);
    const scope = await PathScope.create([root]);
    await expect(scope.input(link, ".txt")).rejects.toThrow(
      "outside the configured roots",
    );
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

    const restoreResult = await service.restoreText({
      inputPath: anonymized,
      outputPath: restored,
      sessionId: "local_case_1",
    });
    expect(restoreResult.operation).toBe("restore");
    expect(await readFile(restored, "utf8")).toBe("Alice Smith signed.");
  });

  test("anonymizes and restores DOCX through path-only operations", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "input.docx");
    const anonymized = join(root, "anonymized.docx");
    const restored = join(root, "restored.docx");
    const wordNamespace =
      "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const packageNamespace =
      "http://schemas.openxmlformats.org/package/2006/relationships";
    const officeNamespace =
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    await writeFile(
      input,
      zipSync({
        "[Content_Types].xml": strToU8(
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        ),
        "_rels/.rels": strToU8(
          `<Relationships xmlns="${packageNamespace}"><Relationship Id="rId1" Type="${officeNamespace}/officeDocument" Target="word/document.xml"/></Relationships>`,
        ),
        "word/document.xml": strToU8(
          `<w:document xmlns:w="${wordNamespace}"><w:body><w:p><w:r><w:t>Alice Smith signed.</w:t></w:r></w:p></w:body></w:document>`,
        ),
      }),
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
    });
    expect(extractDocxText(await readFile(restored)).blocks.at(0)?.text).toBe(
      "Alice Smith signed.",
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
