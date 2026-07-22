import { randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { PreparedNativePipeline } from "@stll/anonymize";
import {
  anonymizePdfRaster,
  PDF_DOCUMENT_MAX_BYTES,
  renderPdfWithPopplerTesseract,
} from "@stll/anonymize-pdf";

import { parseCountries, UsageError } from "./args";

export type PdfDetectionOptions = {
  labels?: string[] | undefined;
  languages?: string[] | undefined;
  countries?: string[] | undefined;
  threshold: number;
};

export type PdfCliPipeline = Pick<
  PreparedNativePipeline,
  "redactText" | "redactTextWithCallerDetections"
>;

export type PdfPipelineRequest = { detection: PdfDetectionOptions };

type RunPdfCommandOptions = {
  argv: readonly string[];
  preparePipeline: (request: PdfPipelineRequest) => Promise<PdfCliPipeline>;
};

type PdfCommand =
  | { type: "help" }
  | {
      type: "anonymize";
      inputPath: string;
      outputPath: string;
      ocrLanguage: string;
      dpi: number;
      timeoutMs: number;
      pdftoppmPath?: string | undefined;
      tesseractPath?: string | undefined;
      fillRgb: readonly [number, number, number];
      detection: PdfDetectionOptions;
      json: boolean;
      quiet: boolean;
    };

const PDF_HELP = `Usage:
  anonymize pdf anonymize [options] <input.pdf>

Render and OCR every page locally, run stella detection, and write a verified,
fresh image-only PDF. The command never overwrites the input or an existing
output and rejects symlink inputs. Searchability, accessibility, signatures,
forms, links, metadata, attachments, and other interactive structure are
deliberately removed.

Required options:
  -o, --output <path>          New PDF output path
      --ocr-language <pack>    One installed Tesseract pack, e.g. "eng"

Provider options:
      --dpi <n>                Integer render DPI from 72 to 600 (default: 300)
      --pdftoppm <path>        Poppler executable (default: pdftoppm on PATH)
      --tesseract <path>       Tesseract executable (default: tesseract on PATH)
      --timeout-ms <n>         Per-process timeout, 100-300000 (default: 120000)
      --fill-rgb <r,g,b>       Destructive fill color (default: 0,0,0)

Detection options:
      --labels <list>          Comma-separated entity labels
      --languages <list>       Name-corpus languages, e.g. "cs,de,en"
      --countries <list>       ISO 3166-1 alpha-2 country codes
      --threshold <n>          Minimum confidence score 0-1 (default: 0.3)

Output options:
      --json                   Print the aggregate verification certificate
      --quiet                  Suppress the human-readable stderr summary
  -h, --help                   Show this help

The OCR language is explicit and singular. The certificate proves a fresh
image-only structure and requested pixel rewrite; it does not prove perfect OCR
or detector recall and always reports piiCleanGuaranteed=false.
`;

const PDF_PARSE_CONFIG = {
  allowPositionals: true,
  strict: true,
  options: {
    output: { type: "string", short: "o" },
    "ocr-language": { type: "string" },
    dpi: { type: "string" },
    pdftoppm: { type: "string" },
    tesseract: { type: "string" },
    "timeout-ms": { type: "string" },
    "fill-rgb": { type: "string" },
    labels: { type: "string" },
    languages: { type: "string" },
    countries: { type: "string" },
    threshold: { type: "string" },
    json: { type: "boolean" },
    quiet: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
} as const;

const required = (value: string | undefined, flag: string): string => {
  if (!value) throw new UsageError(`${flag} is required for PDF anonymization`);
  return value;
};

const integerOption = (
  value: string | undefined,
  flag: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new UsageError(
      `${flag} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return parsed;
};

const thresholdOption = (value: string | undefined): number => {
  if (value === undefined) return 0.3;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new UsageError("--threshold must be a number from 0 to 1");
  }
  return parsed;
};

const listOption = (value: string | undefined): string[] | undefined =>
  value === undefined
    ? undefined
    : [
        ...new Set(
          value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ];

const fillOption = (
  value: string | undefined,
): readonly [number, number, number] => {
  if (value === undefined) return [0, 0, 0];
  const channels = value.split(",").map(Number);
  if (
    channels.length !== 3 ||
    channels.some(
      (channel) => !Number.isInteger(channel) || channel < 0 || channel > 255,
    )
  ) {
    throw new UsageError(
      "--fill-rgb must contain three integers from 0 to 255",
    );
  }
  return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0];
};

const parsePdfCommand = (argv: readonly string[]): PdfCommand => {
  const action = argv.at(0);
  if (action === undefined || action === "--help" || action === "-h") {
    return { type: "help" };
  }
  if (action !== "anonymize") {
    throw new UsageError(
      `unknown PDF action "${action}"; expected "anonymize"`,
    );
  }
  let parsed: ReturnType<typeof parseArgs<typeof PDF_PARSE_CONFIG>>;
  try {
    parsed = parseArgs({ ...PDF_PARSE_CONFIG, args: argv.slice(1) });
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (parsed.values.help === true) return { type: "help" };
  if (parsed.positionals.length !== 1 || parsed.positionals[0] === undefined) {
    throw new UsageError("PDF anonymization requires exactly one input file");
  }
  return {
    type: "anonymize",
    inputPath: parsed.positionals[0],
    outputPath: required(parsed.values.output, "--output"),
    ocrLanguage: required(parsed.values["ocr-language"], "--ocr-language"),
    dpi: integerOption(parsed.values.dpi, "--dpi", 300, 72, 600),
    timeoutMs: integerOption(
      parsed.values["timeout-ms"],
      "--timeout-ms",
      120_000,
      100,
      300_000,
    ),
    pdftoppmPath: parsed.values.pdftoppm,
    tesseractPath: parsed.values.tesseract,
    fillRgb: fillOption(parsed.values["fill-rgb"]),
    detection: {
      labels: listOption(parsed.values.labels),
      languages: listOption(parsed.values.languages),
      countries:
        parsed.values.countries === undefined
          ? undefined
          : parseCountries(parsed.values.countries),
      threshold: thresholdOption(parsed.values.threshold),
    },
    json: parsed.values.json === true,
    quiet: parsed.values.quiet === true,
  };
};

const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const isNodeError = (
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === code;

const preflight = async (
  command: Extract<PdfCommand, { type: "anonymize" }>,
): Promise<void> => {
  if (canonicalPath(command.inputPath) === canonicalPath(command.outputPath)) {
    throw new UsageError("--output must not overwrite the PDF input");
  }
  let input;
  try {
    input = await lstat(command.inputPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new UsageError("PDF input must be a regular non-symlink file");
    }
    throw error;
  }
  if (!input.isFile() || input.isSymbolicLink()) {
    throw new UsageError("PDF input must be a regular non-symlink file");
  }
  try {
    await lstat(command.outputPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  throw new UsageError("--output refuses to overwrite an existing path");
};

const readRegularInput = async (path: string): Promise<Uint8Array> => {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error, "ELOOP")) {
      throw new UsageError("PDF input must be a regular non-symlink file");
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !Number.isSafeInteger(opened.size) ||
      opened.size > PDF_DOCUMENT_MAX_BYTES
    ) {
      throw new UsageError(
        `PDF input must be a regular file no larger than ${PDF_DOCUMENT_MAX_BYTES} bytes`,
      );
    }
    const document = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < document.length) {
      const { bytesRead } = await handle.read(
        document,
        offset,
        document.length - offset,
        offset,
      );
      if (bytesRead === 0) {
        throw new UsageError("PDF input changed while it was being read");
      }
      offset += bytesRead;
    }
    const sentinel = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await handle.read(
      sentinel,
      0,
      1,
      offset,
    );
    const current = await lstat(path);
    if (
      trailingBytes !== 0 ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    ) {
      throw new UsageError("PDF input changed during validation");
    }
    return document;
  } finally {
    await handle.close();
  }
};

const removeStaged = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
};

const publishNewFile = async (
  target: string,
  content: Uint8Array,
): Promise<void> => {
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    try {
      await link(temporary, target);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new UsageError("--output refuses to overwrite an existing path");
      }
      throw error;
    }
  } catch (error) {
    try {
      await handle.close();
    } catch {
      // Preserve the primary publication error.
    }
    throw error;
  } finally {
    await removeStaged(temporary);
  }
};

export const runPdfCommand = async ({
  argv,
  preparePipeline,
}: RunPdfCommandOptions): Promise<void> => {
  const command = parsePdfCommand(argv);
  if (command.type === "help") {
    process.stdout.write(PDF_HELP);
    return;
  }
  await preflight(command);
  const document = await readRegularInput(command.inputPath);
  const pipeline = await preparePipeline({ detection: command.detection });
  const observed = await renderPdfWithPopplerTesseract({
    document,
    ocrLanguage: command.ocrLanguage,
    dpi: command.dpi,
    timeoutMs: command.timeoutMs,
    pdftoppmPath: command.pdftoppmPath,
    tesseractPath: command.tesseractPath,
  });
  const result = anonymizePdfRaster({
    document,
    pipeline,
    provider: observed.provider,
    pages: observed.pages,
    fillRgb: command.fillRgb,
  });
  await publishNewFile(command.outputPath, result.document);
  if (command.json) {
    process.stdout.write(`${JSON.stringify(result.certificate, null, 2)}\n`);
  }
  if (!command.quiet) {
    process.stderr.write(
      `anonymize: PDF anonymized: ${result.certificate.pageCount} pages, ${result.certificate.detectionCount} detections, PII-clean guarantee=false\n`,
    );
  }
};
