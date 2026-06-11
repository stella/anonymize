import { parseArgs } from "node:util";

export const CLI_MODES = ["replace", "redact"] as const;
export type CliMode = (typeof CLI_MODES)[number];

export const DEFAULT_THRESHOLD = 0.3;
export const DEFAULT_REDACT_STRING = "[REDACTED]";

/** Invalid invocation; printed with usage hint, exit code 2. */
export class UsageError extends Error {}

export type CliOptions = {
  files: string[];
  output?: string | undefined;
  mode: CliMode;
  keyPath?: string | undefined;
  deanonymiseKeyPath?: string | undefined;
  labels?: string[] | undefined;
  languages?: string[] | undefined;
  countries?: string[] | undefined;
  threshold: number;
  redactString: string;
  json: boolean;
  quiet: boolean;
  help: boolean;
  version: boolean;
};

export const HELP = `Usage: anonymize [options] [file ...]

Detect and anonymize PII in text. Reads the given files, or stdin
when no files are given. Writes to stdout, or to --output.
All processing is local; the CLI makes no network calls.

Options:
  -o, --output <path>       Output file, or directory when multiple
                            input files are given
  -m, --mode <mode>         "replace" (reversible [PERSON_1]
                            placeholders) or "redact"
                            (default: replace)
  -k, --key <path>          Write the redaction key as JSON
                            (single input, replace mode)
  -d, --deanonymise <path>  Restore redacted text using the
                            redaction key at <path>
      --labels <list>       Comma-separated entity labels to detect
                            (default: all)
      --languages <list>    Name-corpus languages, e.g. "cs,de,en"
                            (default: all bundled)
      --countries <list>    ISO 3166-1 alpha-2 codes scoping deny
                            lists and city data, e.g. "CZ,DE,GB"
                            (default: all deny lists; city data
                            for a 30-country default set)
      --threshold <n>       Minimum confidence score, 0-1
                            (default: ${DEFAULT_THRESHOLD})
      --redact-string <s>   Replacement text in redact mode
                            (default: "${DEFAULT_REDACT_STRING}")
      --json                Emit JSON (entities + redacted text) to
                            stdout (single input only)
      --quiet               Suppress the summary on stderr
  -h, --help                Show this help
  -v, --version             Show the version

Interactive prompt:
  When run on files from a terminal without --countries or
  --languages, the CLI asks once which country scope to load.
  Piped stdin/stderr or --quiet skips the prompt, so scripts
  and agents never block on input.

Exit codes:
  0  success
  1  runtime error (message on stderr)
  2  usage error (message on stderr)

JSON output (--json):
  { "entityCount": number,
    "entities": [{ "start": number, "end": number,
                   "label": string, "text": string,
                   "score": number, "source": string }],
    "redactedText": string }
  Offsets are UTF-16 code-unit indexes into the input.
  The stderr summary contains entity counts only, never
  the detected text.

Examples:
  anonymize contract.txt > contract.anon.txt
  anonymize -k contract.key.json -o contract.anon.txt contract.txt
  anonymize -d contract.key.json contract.anon.txt
  cat notes.md | anonymize --countries CZ,SK --languages cs,sk
  anonymize --json --quiet input.txt | jq '.entities[].label'
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

const parseMode = (raw: string): CliMode => {
  const mode = CLI_MODES.find((candidate) => candidate === raw);
  if (!mode) {
    throw new UsageError(
      `--mode must be one of: ${CLI_MODES.join(", ")}; got "${raw}"`,
    );
  }
  return mode;
};

const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

export const parseCountries = (raw: string): string[] => {
  const countries = [
    ...new Set(splitList(raw).map((code) => code.toUpperCase())),
  ];
  const invalid = countries.find((code) => !COUNTRY_CODE_RE.test(code));
  if (invalid) {
    throw new UsageError(
      `--countries expects ISO 3166-1 alpha-2 codes (e.g. "CZ,DE"), got "${invalid}"`,
    );
  }
  return countries;
};

export const parseCliArgs = (argv: string[]): CliOptions => {
  let parsed: ReturnType<typeof parseArgs<typeof PARSE_CONFIG>>;
  try {
    parsed = parseArgs({ ...PARSE_CONFIG, args: argv });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;

  return {
    files: positionals,
    output: values.output,
    mode: values.mode === undefined ? "replace" : parseMode(values.mode),
    keyPath: values.key,
    deanonymiseKeyPath: values.deanonymise,
    labels: values.labels === undefined ? undefined : splitList(values.labels),
    languages:
      values.languages === undefined ? undefined : splitList(values.languages),
    countries:
      values.countries === undefined
        ? undefined
        : parseCountries(values.countries),
    threshold:
      values.threshold === undefined
        ? DEFAULT_THRESHOLD
        : parseThreshold(values.threshold),
    redactString: values["redact-string"] ?? DEFAULT_REDACT_STRING,
    json: values.json === true,
    quiet: values.quiet === true,
    help: values.help === true,
    version: values.version === true,
  };
};

const PARSE_CONFIG = {
  allowPositionals: true,
  strict: true,
  options: {
    output: { type: "string", short: "o" },
    mode: { type: "string", short: "m" },
    key: { type: "string", short: "k" },
    deanonymise: { type: "string", short: "d" },
    labels: { type: "string" },
    languages: { type: "string" },
    countries: { type: "string" },
    threshold: { type: "string" },
    "redact-string": { type: "string" },
    json: { type: "boolean" },
    quiet: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
} as const;
