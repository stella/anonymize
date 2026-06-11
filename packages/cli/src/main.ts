import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";

import type {
  createPipelineContext,
  deanonymise,
  Entity,
  exportRedactionKey,
  OperatorConfig,
  OperatorType,
  PipelineConfig,
  preparePipelineSearch,
  redactText,
  runPipeline,
} from "@stll/anonymize";
import { DEFAULT_ENTITY_LABELS } from "@stll/anonymize/constants";

import type { CliOptions } from "./args";
import { HELP, parseCliArgs, UsageError } from "./args";
import { loadCliDictionaries } from "./dictionaries";

/**
 * The pipeline functions the CLI needs. Satisfied by both
 * @stll/anonymize (native) and @stll/anonymize-wasm, so the
 * entry point decides which engine backs the binary.
 */
export type AnonymizeApi = {
  createPipelineContext: typeof createPipelineContext;
  deanonymise: typeof deanonymise;
  exportRedactionKey: typeof exportRedactionKey;
  preparePipelineSearch: typeof preparePipelineSearch;
  redactText: typeof redactText;
  runPipeline: typeof runPipeline;
};

const cliVersion = (): string => {
  const requireFromHere = createRequire(import.meta.url);
  // SAFETY: our own package.json always carries a version.
  const pkg = requireFromHere("../package.json") as { version: string };
  return pkg.version;
};

const readStdin = async (): Promise<string> => {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
};

type NamedInput = {
  /** Source path, or null when reading stdin. */
  path: string | null;
  text: string;
};

const readInputs = async (files: string[]): Promise<NamedInput[]> => {
  if (files.length === 0) {
    if (process.stdin.isTTY) {
      throw new UsageError(
        "no input files and stdin is a terminal (see --help)",
      );
    }
    return [{ path: null, text: await readStdin() }];
  }
  return Promise.all(
    files.map(async (path) => ({ path, text: await readFile(path, "utf8") })),
  );
};

const validateLabels = (labels: readonly string[]): string[] => {
  // Widening the literal tuple to string[] is safe here;
  // we only test membership.
  const known: readonly string[] = DEFAULT_ENTITY_LABELS;
  const invalid = labels.find((label) => !known.includes(label));
  if (invalid) {
    throw new UsageError(
      `--labels: unknown label "${invalid}"; available: ${DEFAULT_ENTITY_LABELS.join(", ")}`,
    );
  }
  return [...labels];
};

const buildPipelineConfig = async (
  opts: CliOptions,
): Promise<PipelineConfig> => {
  const dictionaries = await loadCliDictionaries({
    languages: opts.languages,
    countries: opts.countries,
  });
  return {
    threshold: opts.threshold,
    enableTriggerPhrases: true,
    enableRegex: true,
    enableLegalForms: true,
    enableNameCorpus: true,
    ...(opts.languages === undefined
      ? {}
      : { nameCorpusLanguages: [...opts.languages] }),
    enableDenyList: true,
    ...(opts.countries === undefined
      ? {}
      : { denyListCountries: [...opts.countries] }),
    enableGazetteer: false,
    enableCountries: true,
    enableNer: false,
    enableConfidenceBoost: true,
    enableCoreference: true,
    enableZoneClassification: true,
    enableHotwordRules: true,
    labels:
      opts.labels === undefined
        ? [...DEFAULT_ENTITY_LABELS]
        : validateLabels(opts.labels),
    workspaceId: "cli",
    dictionaries,
  };
};

const buildOperatorConfig = (
  opts: CliOptions,
  entities: Entity[],
): OperatorConfig => {
  const operators: Record<string, OperatorType> = {};
  if (opts.mode === "redact") {
    for (const entity of entities) operators[entity.label] = "redact";
  }
  return { operators, redactString: opts.redactString };
};

const writeOutput = async (
  path: string | undefined,
  content: string,
): Promise<void> => {
  if (path === undefined) {
    process.stdout.write(content);
    return;
  }
  await writeFile(path, content, "utf8");
};

type RedactionKeyFile = {
  entries: Record<string, { original: string; operator: string }>;
};

const parseRedactionKey = (raw: string): Map<string, string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError("redaction key is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || !("entries" in parsed)) {
    throw new UsageError(
      'redaction key must be an object with an "entries" field',
    );
  }
  const { entries } = parsed as RedactionKeyFile;
  const map = new Map<string, string>();
  for (const [placeholder, entry] of Object.entries(entries)) {
    if (typeof entry?.original !== "string") {
      throw new UsageError(
        `redaction key entry "${placeholder}" has no original text`,
      );
    }
    map.set(placeholder, entry.original);
  }
  return map;
};

const runDeanonymise = async (
  opts: CliOptions,
  api: AnonymizeApi,
): Promise<void> => {
  if (opts.keyPath !== undefined) {
    throw new UsageError("--key cannot be combined with --deanonymise");
  }
  const keyPath = opts.deanonymiseKeyPath;
  if (keyPath === undefined) throw new UsageError("missing redaction key path");
  const redactionMap = parseRedactionKey(await readFile(keyPath, "utf8"));

  const inputs = await readInputs(opts.files);
  if (inputs.length > 1) {
    throw new UsageError("--deanonymise accepts a single input");
  }
  const input = inputs[0];
  if (!input) throw new UsageError("no input to deanonymise");
  await writeOutput(opts.output, api.deanonymise(input.text, redactionMap));
};

const outputPathFor = (
  input: NamedInput,
  opts: CliOptions,
  multi: boolean,
): string | undefined => {
  if (opts.output === undefined) return undefined;
  if (!multi) return opts.output;
  if (input.path === null)
    throw new UsageError("stdin cannot be combined with multiple files");
  return join(opts.output, basename(input.path));
};

const guardAgainstOverwrite = (
  input: NamedInput,
  outputPath: string | undefined,
): void => {
  if (input.path === null || outputPath === undefined) return;
  if (resolve(input.path) === resolve(outputPath)) {
    throw new UsageError(`refusing to overwrite input file "${input.path}"`);
  }
};

const summarize = (entities: Entity[]): string => {
  const counts = new Map<string, number>();
  for (const entity of entities) {
    counts.set(entity.label, (counts.get(entity.label) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([label, count]) => `${label}: ${count}`);
  return parts.length > 0 ? parts.join(", ") : "none";
};

const runAnonymise = async (
  opts: CliOptions,
  api: AnonymizeApi,
): Promise<void> => {
  const multi = opts.files.length > 1;
  if (multi && opts.output === undefined) {
    throw new UsageError("multiple input files require --output <directory>");
  }
  if (multi && opts.keyPath !== undefined) {
    throw new UsageError("--key works with a single input only");
  }
  if (multi && opts.json) {
    throw new UsageError("--json works with a single input only");
  }
  if (opts.keyPath !== undefined && opts.mode !== "replace") {
    throw new UsageError('--key requires --mode "replace"');
  }

  const inputs = await readInputs(opts.files);
  const config = await buildPipelineConfig(opts);

  const buildContext = api.createPipelineContext();
  const cachedSearch = await api.preparePipelineSearch({
    config,
    context: buildContext,
  });

  if (multi && opts.output !== undefined) {
    await mkdir(opts.output, { recursive: true });
  }

  for (const input of inputs) {
    const outputPath = outputPathFor(input, opts, multi);
    guardAgainstOverwrite(input, outputPath);

    const context = api.createPipelineContext();
    const entities = await api.runPipeline({
      fullText: input.text,
      config,
      gazetteerEntries: [],
      cachedSearch,
      context,
    });
    const result = api.redactText(
      input.text,
      entities,
      buildOperatorConfig(opts, entities),
      context,
    );

    if (opts.json) {
      const payload = {
        entityCount: result.entityCount,
        entities,
        redactedText: result.redactedText,
      };
      await writeOutput(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
    } else {
      await writeOutput(outputPath, result.redactedText);
    }

    if (opts.keyPath !== undefined) {
      await writeFile(
        opts.keyPath,
        api.exportRedactionKey(result.redactionMap, result.operatorMap),
        "utf8",
      );
    }

    if (!opts.quiet) {
      const source = input.path ?? "stdin";
      process.stderr.write(`anonymize: ${source}: ${summarize(entities)}\n`);
    }
  }
};

const dispatch = async (api: AnonymizeApi): Promise<void> => {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (opts.version) {
    process.stdout.write(`${cliVersion()}\n`);
    return;
  }
  if (opts.deanonymiseKeyPath !== undefined) {
    await runDeanonymise(opts, api);
    return;
  }
  await runAnonymise(opts, api);
};

/**
 * Run the CLI against the given engine and set the
 * process exit code (0 ok, 1 runtime error, 2 usage).
 */
export const runCli = async (api: AnonymizeApi): Promise<void> => {
  try {
    await dispatch(api);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`anonymize: ${err.message}\n`);
      process.stderr.write(`Try "anonymize --help" for usage.\n`);
      process.exitCode = 2;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`anonymize: ${message}\n`);
      process.exitCode = 1;
    }
  }
};
