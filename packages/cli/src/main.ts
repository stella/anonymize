import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import type {
  createPipelineContext,
  deanonymise,
  Dictionaries,
  Entity,
  exportRedactionKey,
  OperatorConfig,
  OperatorType,
  PipelineConfig,
  redactText,
  runPipeline,
} from "@stll/anonymize";
import { DEFAULT_ENTITY_LABELS } from "@stll/anonymize/constants";

import pkg from "../package.json" with { type: "json" };

import type { CliOptions } from "./args";
import { HELP, parseCliArgs, parseCountries, UsageError } from "./args";
import type { DictionaryScope } from "./dictionary-scope";

/**
 * The pipeline functions the CLI needs. Satisfied by both
 * @stll/anonymize (native) and @stll/anonymize-wasm, so the
 * entry point decides which engine backs the binary.
 */
export type AnonymizeApi = {
  createPipelineContext: typeof createPipelineContext;
  deanonymise: typeof deanonymise;
  exportRedactionKey: typeof exportRedactionKey;
  redactText: typeof redactText;
  runPipeline: typeof runPipeline;
};

/**
 * Everything an entry point injects: the pipeline engine
 * and the dictionary source (npm data package for the
 * Node bin, embedded gzip blob for the compiled binary).
 */
export type CliEngine = {
  api: AnonymizeApi;
  loadDictionaries: (scope: DictionaryScope) => Promise<Dictionaries>;
};

// Statically imported so the version is baked into both
// the npm bundle and the compiled binary; a runtime
// package.json lookup would fail inside the binary's
// virtual filesystem.
const cliVersion = (): string => pkg.version;

/**
 * Filesystem identity of a path: realpath when it exists
 * (so symlinks to the same file compare equal), lexical
 * resolution otherwise (the file may not exist yet).
 */
const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
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
  loadDictionaries: CliEngine["loadDictionaries"],
): Promise<PipelineConfig> => {
  const dictionaries = await loadDictionaries({
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
  if (
    typeof entries !== "object" ||
    entries === null ||
    Array.isArray(entries)
  ) {
    throw new UsageError('redaction key "entries" must be an object');
  }
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

/**
 * Ask for a country scope when running interactively on
 * files with no scope flags. Skipped for piped stdin so
 * the CLI stays scriptable.
 */
export const shouldPromptForScope = (
  opts: CliOptions,
  tty: { stdinIsTTY: boolean; stderrIsTTY: boolean },
): boolean =>
  opts.countries === undefined &&
  opts.languages === undefined &&
  !opts.quiet &&
  opts.files.length > 0 &&
  tty.stdinIsTTY &&
  tty.stderrIsTTY;

const promptForCountries = async (): Promise<string[] | undefined> => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(
      "Country scope (ISO codes like CZ,DE,GB; Enter loads all): ",
    );
    const trimmed = answer.trim();
    return trimmed === "" ? undefined : parseCountries(trimmed);
  } finally {
    rl.close();
  }
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
  if (opts.output !== undefined) {
    guardWriteTargets(input.path === null ? [] : [input.path], [
      { path: opts.output, flag: "--output" },
    ]);
  }
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

/**
 * Reject any write target (output or key file) whose
 * filesystem identity collides with an input file or with
 * another write target. Symlinks count as collisions.
 */
const guardWriteTargets = (
  inputPaths: readonly string[],
  writeTargets: readonly { path: string; flag: string }[],
): void => {
  const inputs = new Set(inputPaths.map(canonicalPath));
  const seen = new Map<string, string>();
  for (const target of writeTargets) {
    const canonical = canonicalPath(target.path);
    if (inputs.has(canonical)) {
      throw new UsageError(
        `refusing to overwrite input file "${target.path}" (${target.flag})`,
      );
    }
    const clash = seen.get(canonical);
    if (clash !== undefined) {
      throw new UsageError(
        `${target.flag} "${target.path}" collides with ${clash}`,
      );
    }
    seen.set(canonical, `${target.flag} "${target.path}"`);
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
  { api, loadDictionaries }: CliEngine,
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

  const scoped = shouldPromptForScope(opts, {
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
  })
    ? { ...opts, countries: await promptForCountries() }
    : opts;

  const inputs = await readInputs(scoped.files);

  // Validate every write target before any work: output
  // collisions (same basename from different input dirs,
  // symlinks to an input, --key hitting the output) fail
  // fast instead of silently clobbering files mid-batch.
  const outputPaths = inputs.map((input) => outputPathFor(input, opts, multi));
  const writeTargets: { path: string; flag: string }[] = [];
  for (const path of outputPaths) {
    if (path !== undefined) writeTargets.push({ path, flag: "--output" });
  }
  if (opts.keyPath !== undefined) {
    writeTargets.push({ path: opts.keyPath, flag: "--key" });
  }
  guardWriteTargets(
    inputs.flatMap((input) => (input.path === null ? [] : [input.path])),
    writeTargets,
  );

  const config = await buildPipelineConfig(scoped, loadDictionaries);

  // One shared context for the whole batch: the first
  // runPipeline builds the search automaton after its own
  // init steps (hotword rules included) and caches it on
  // the context for the remaining files. Cross-document
  // reuse is supported — coref links travel on entities.
  const context = api.createPipelineContext();

  if (multi && opts.output !== undefined) {
    await mkdir(opts.output, { recursive: true });
  }

  for (const [index, input] of inputs.entries()) {
    const outputPath = outputPaths[index];

    const entities = await api.runPipeline({
      fullText: input.text,
      config,
      gazetteerEntries: [],
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

const dispatch = async (engine: CliEngine): Promise<void> => {
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
    await runDeanonymise(opts, engine.api);
    return;
  }
  await runAnonymise(opts, engine);
};

/**
 * Run the CLI against the given engine and set the
 * process exit code (0 ok, 1 runtime error, 2 usage).
 */
export const runCli = async (engine: CliEngine): Promise<void> => {
  try {
    await dispatch(engine);
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
