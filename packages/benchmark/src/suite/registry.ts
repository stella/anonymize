export type BenchmarkTask = "span-redaction" | "contextual-redaction";

export type BenchmarkAccess = "bundled-development" | "verified-download";

export type BenchmarkPolicy = "development" | "evaluation-only";

export type BenchmarkCorpus = {
  readonly id: string;
  readonly name: string;
  readonly domains: readonly string[];
  readonly languages: readonly string[];
  readonly task: BenchmarkTask;
  readonly access: BenchmarkAccess;
  readonly policy: BenchmarkPolicy;
  readonly license: string;
  readonly source: string;
  readonly version: string;
  readonly runnable: boolean;
  readonly execution?: {
    readonly script: string;
    readonly args: readonly string[];
  };
  readonly notes: string;
};

export const BENCHMARK_CORPORA: readonly BenchmarkCorpus[] = [
  {
    id: "stella-synthetic-legal",
    name: "stella synthetic legal fixtures",
    domains: ["contracts"],
    languages: ["cs", "de", "en"],
    task: "span-redaction",
    access: "bundled-development",
    policy: "development",
    license: "Apache-2.0",
    source: "packages/benchmark/fixtures",
    version: "repository",
    runnable: true,
    notes: "Public development fixtures; permitted for detector iteration.",
  },
  {
    id: "tab-echr-development",
    name: "Text Anonymization Benchmark (TAB) development split",
    domains: ["court decisions", "legal"],
    languages: ["en"],
    task: "span-redaction",
    access: "verified-download",
    policy: "development",
    license: "MIT",
    source: "https://github.com/NorskRegnesentral/text-anonymization-benchmark",
    version: "558e09e26d6b36f5f78440074e6a233946d98bd9",
    runnable: true,
    notes:
      "Declared TAB development split; deterministic five-document diagnostics may guide detector iteration.",
  },
  {
    id: "tab-echr",
    name: "Text Anonymization Benchmark (TAB)",
    domains: ["court decisions", "legal"],
    languages: ["en"],
    task: "span-redaction",
    access: "verified-download",
    policy: "evaluation-only",
    license: "MIT",
    source: "https://github.com/NorskRegnesentral/text-anonymization-benchmark",
    version: "558e09e26d6b36f5f78440074e6a233946d98bd9",
    runnable: true,
    execution: { script: "blind.ts", args: ["--full"] },
    notes: "Independent annotator judgments; aggregate-only sealed reports.",
  },
  {
    id: "redactionbench",
    name: "RedactionBench",
    domains: [
      "contracts",
      "legal",
      "medical",
      "financial",
      "government",
      "email",
      "code",
      "files",
      "logs",
      "terminal",
    ],
    languages: ["en"],
    task: "contextual-redaction",
    access: "verified-download",
    policy: "evaluation-only",
    license: "CC-BY-4.0",
    source: "https://huggingface.co/datasets/RedactionBench/RedactionBench",
    version: "d45e9cec89bc49c69355e252fec29cc0229982f6",
    runnable: true,
    execution: { script: "redactionbench.ts", args: [] },
    notes:
      "Mandatory/contextual spans. Reports transparent interim metrics until the official R-Score implementation is published.",
  },
  {
    id: "meddocan",
    name: "MEDDOCAN",
    domains: ["medical"],
    languages: ["es"],
    task: "span-redaction",
    access: "verified-download",
    policy: "evaluation-only",
    license: "CC-BY-4.0",
    source: "https://doi.org/10.5281/zenodo.4279323",
    version: "d0e4708b58689bc1440ede6f89e017e58d667827d927827622d73810cd68eac3",
    runnable: true,
    execution: { script: "meddocan.ts", args: [] },
    notes:
      "Complete 250-document test split; checksum-pinned Zenodo BRAT archive.",
  },
] as const;

export const validateBenchmarkRegistry = (): void => {
  const ids = new Set<string>();
  for (const corpus of BENCHMARK_CORPORA) {
    if (ids.has(corpus.id)) {
      throw new Error(`duplicate benchmark corpus id ${corpus.id}`);
    }
    ids.add(corpus.id);
    if (corpus.policy !== "development" && corpus.version.trim() === "") {
      throw new Error(`${corpus.id} must pin a source version`);
    }
    if (
      corpus.runnable &&
      corpus.policy === "evaluation-only" &&
      corpus.execution === undefined
    ) {
      throw new Error(`${corpus.id} must declare sealed-suite execution`);
    }
  }
};
