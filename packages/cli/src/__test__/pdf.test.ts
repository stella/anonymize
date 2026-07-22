import { readFileSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { inspectPdf, PDF_DOCUMENT_MAX_BYTES } from "@stll/anonymize-pdf";

import { UsageError } from "../args";
import { runPdfCommand, type PdfCliPipeline } from "../pdf";

const fixture = readFileSync(
  join(
    import.meta.dir,
    "../../../../crates/anonymize-pdf-core/tests/fixtures/minimal-text.pdf",
  ),
);

let directory = "";
let inputPath = "";
let pdftoppmPath = "";
let tesseractPath = "";

const executable = async (name: string, body: string): Promise<string> => {
  const path = join(directory, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}`, {
    flag: "wx",
    mode: 0o700,
  });
  await chmod(path, 0o700);
  return path;
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "anonymize pdf cli test-"));
  inputPath = join(directory, "input.pdf");
  await writeFile(inputPath, fixture, { flag: "wx", mode: 0o600 });
  pdftoppmPath = await executable(
    "pdftoppm fake",
    `
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-v")) {
  process.stderr.write("pdftoppm version 1.2.3\\n");
  process.exit(0);
}
if (!args.includes("-singlefile")) process.exit(2);
writeFileSync(args.at(-1) + ".ppm", Buffer.concat([
  Buffer.from("P6\\n612 792\\n255\\n"),
  Buffer.alloc(612 * 792 * 3, 255),
]));
`,
  );
  tesseractPath = await executable(
    "tesseract fake",
    `
if (process.argv.includes("--version")) {
  process.stdout.write("tesseract 5.4.1\\n");
  process.exit(0);
}
process.stdout.write("level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n");
process.stdout.write("5\\t1\\t1\\t1\\t1\\t1\\t72\\t80\\t36\\t12\\t99\\tAlice\\n");
`,
  );
});

afterAll(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
});

const detectorResult = {
  resolvedEntities: [
    {
      start: 0,
      end: 5,
      label: "PERSON",
      text: "Alice",
      score: 1,
      source: "test",
    },
  ],
  redaction: {
    redactedText: "[PERSON]",
    redactionMap: new Map<string, string>(),
    operatorMap: new Map(),
    entityCount: 1,
  },
};
const pipeline: PdfCliPipeline = {
  redactText: () => detectorResult,
  redactTextWithCallerDetections: () => detectorResult,
};

const args = (outputPath: string, sourcePath = inputPath): string[] => [
  "anonymize",
  "--output",
  outputPath,
  "--ocr-language",
  "eng",
  "--dpi",
  "72",
  "--pdftoppm",
  pdftoppmPath,
  "--tesseract",
  tesseractPath,
  "--quiet",
  sourcePath,
];

describe("PDF CLI workflow", () => {
  test("publishes a verified fresh image-only output", async () => {
    const outputPath = join(directory, "output.pdf");
    await runPdfCommand({
      argv: args(outputPath),
      preparePipeline: async ({ detection }) => {
        expect(detection.threshold).toBe(0.3);
        return pipeline;
      },
    });

    const output = await readFile(outputPath);
    expect(Buffer.from(output).includes("Public fixture")).toBeFalse();
    expect(inspectPdf(output).risks).toMatchObject({
      annotationCount: 0,
      embeddedFileCount: 0,
      imageObjectCount: 1,
      metadataStreamCount: 0,
    });
  });

  test("rejects input overwrite and symlink inputs", async () => {
    await expect(
      runPdfCommand({
        argv: args(inputPath),
        preparePipeline: async () => pipeline,
      }),
    ).rejects.toBeInstanceOf(UsageError);

    const symlinkPath = join(directory, "input-link.pdf");
    await symlink(inputPath, symlinkPath);
    await expect(
      runPdfCommand({
        argv: args(join(directory, "symlink-output.pdf"), symlinkPath),
        preparePipeline: async () => pipeline,
      }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  test("reports a missing input as usage failure before pipeline preparation", async () => {
    let pipelineCalls = 0;
    await expect(
      runPdfCommand({
        argv: args(
          join(directory, "missing-output.pdf"),
          join(directory, "missing-input.pdf"),
        ),
        preparePipeline: async () => {
          pipelineCalls += 1;
          return pipeline;
        },
      }),
    ).rejects.toBeInstanceOf(UsageError);
    expect(pipelineCalls).toBe(0);
  });

  test("rejects oversized sparse inputs before pipeline preparation", async () => {
    const oversized = join(directory, "oversized.pdf");
    await writeFile(oversized, "", { flag: "wx", mode: 0o600 });
    await truncate(oversized, PDF_DOCUMENT_MAX_BYTES + 1);
    let pipelineCalls = 0;

    await expect(
      runPdfCommand({
        argv: args(join(directory, "oversized-output.pdf"), oversized),
        preparePipeline: async () => {
          pipelineCalls += 1;
          return pipeline;
        },
      }),
    ).rejects.toBeInstanceOf(UsageError);
    expect(pipelineCalls).toBe(0);
  });

  test("atomically refuses an output created after preflight", async () => {
    const outputPath = join(directory, "raced-output.pdf");
    const marker = Buffer.from("do not replace");

    await expect(
      runPdfCommand({
        argv: args(outputPath),
        preparePipeline: async () => {
          await writeFile(outputPath, marker, { flag: "wx", mode: 0o600 });
          return pipeline;
        },
      }),
    ).rejects.toBeInstanceOf(UsageError);
    expect(await readFile(outputPath)).toEqual(marker);
  });
});
