import { readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

import type { Adapter, NativePrediction } from "./adapters/types";
import type { GroundTruthDocument } from "./ground-truth";
import { OVERLAP_THRESHOLD } from "./metrics";
import {
  type CommonLabel,
  isCommonLabel,
  type NativeMapping,
} from "./taxonomy";

/**
 * Ad-hoc ("unseen document") mode. Runs every available library over arbitrary
 * user-supplied text files WITHOUT ground truth and reports what each one
 * detected, side by side. This is the anti-overfitting escape hatch: paste any
 * previously unseen file and compare behaviour directly, instead of trusting
 * the curated corpus alone.
 *
 * PRIVACY: this prints excerpts of detected entities from the input files into
 * the report. Output therefore goes to an UNCOMMITTED path (`results/adhoc/`,
 * git-ignored). Do not commit or share those reports if the input was sensitive.
 */

/** Longest excerpt printed for any detected span (privacy cap). */
const EXCERPT_MAX = 48;

export type AdhocDoc = {
  readonly id: string;
  readonly text: string;
};

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".text", ".log", ".csv", ""]);

const hasReadableExtension = (name: string): boolean => {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
};

/**
 * Load one file or every readable file in a directory (non-recursive) as an
 * ad-hoc document. Hidden files and obvious binaries (by extension) are skipped.
 */
export const loadAdhocDocs = async (inputPath: string): Promise<AdhocDoc[]> => {
  const stats = statSync(inputPath);

  if (stats.isFile()) {
    const text = await Bun.file(inputPath).text();
    return [{ id: basename(inputPath), text }];
  }

  const docs: AdhocDoc[] = [];
  for (const name of readdirSync(inputPath).sort()) {
    if (name.startsWith(".")) {
      continue;
    }
    const full = join(inputPath, name);
    if (!statSync(full).isFile() || !hasReadableExtension(name)) {
      continue;
    }
    docs.push({
      id: relative(inputPath, full) || name,
      text: await Bun.file(full).text(),
    });
  }

  if (docs.length === 0) {
    throw new Error(`no readable text files found in ${inputPath}`);
  }
  return docs;
};

/**
 * Adapters take ground-truth documents; ad-hoc docs have no gold entities, so
 * we present them with an empty `entities` list. `language` defaults to the one
 * supplied on the command line (the Python adapters map an unknown language to
 * English).
 */
const asGroundTruth = (
  docs: readonly AdhocDoc[],
  language: string,
): GroundTruthDocument[] =>
  docs.map(({ id, text }) => ({
    id,
    language,
    title: id,
    text,
    entities: [],
  }));

const mapNative = (
  label: string,
  mapping: NativeMapping,
): CommonLabel | null => {
  if (label in mapping) {
    return mapping[label] ?? null;
  }
  return isCommonLabel(label) ? label : null;
};

/** A detected span, mapped to the common taxonomy and tagged with its library. */
type LibrarySpan = {
  readonly library: string;
  readonly start: number;
  readonly end: number;
  readonly common: CommonLabel;
  readonly text: string;
};

const overlapRatio = (a: LibrarySpan, b: LibrarySpan): number => {
  const interStart = Math.max(a.start, b.start);
  const interEnd = Math.min(a.end, b.end);
  const inter = Math.max(0, interEnd - interStart);
  if (inter === 0) {
    return 0;
  }
  return inter / (a.end - a.start + (b.end - b.start) - inter);
};

/** Two spans describe the same detection if they share a label and overlap. */
const sameDetection = (a: LibrarySpan, b: LibrarySpan): boolean =>
  a.common === b.common && overlapRatio(a, b) >= OVERLAP_THRESHOLD;

/** One aligned region: spans from one or more libraries that agree. */
type Cluster = {
  readonly common: CommonLabel;
  readonly start: number;
  readonly end: number;
  /** Widest span per library, for the aligned display row. */
  readonly byLibrary: Map<string, LibrarySpan>;
  /** Every span per library; pairwise agreement must see non-widest spans. */
  readonly allByLibrary: Map<string, LibrarySpan[]>;
  readonly excerpt: string;
};

/** Union-find clustering of a document's spans into aligned detection regions. */
const clusterSpans = (spans: readonly LibrarySpan[]): Cluster[] => {
  const parent = spans.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) {
      root = parent[root] as number;
    }
    let node = i;
    while (parent[node] !== root) {
      const next = parent[node] as number;
      parent[node] = root;
      node = next;
    }
    return root;
  };
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      // SAFETY: i, j in range by loop bounds.
      if (sameDetection(spans[i] as LibrarySpan, spans[j] as LibrarySpan)) {
        parent[find(i)] = find(j);
      }
    }
  }

  const groups = new Map<number, LibrarySpan[]>();
  for (let i = 0; i < spans.length; i++) {
    const root = find(i);
    const group = groups.get(root) ?? [];
    group.push(spans[i] as LibrarySpan);
    groups.set(root, group);
  }

  const clusters: Cluster[] = [];
  for (const group of groups.values()) {
    const byLibrary = new Map<string, LibrarySpan>();
    const allByLibrary = new Map<string, LibrarySpan[]>();
    for (const span of group) {
      const all = allByLibrary.get(span.library);
      if (all === undefined) {
        allByLibrary.set(span.library, [span]);
      } else {
        all.push(span);
      }
      // If a library reports several overlapping spans in one region, keep the
      // widest, so the aligned row shows its fullest detection.
      const existing = byLibrary.get(span.library);
      if (
        existing === undefined ||
        span.end - span.start > existing.end - existing.start
      ) {
        byLibrary.set(span.library, span);
      }
    }
    // SAFETY: union-find groups are never empty (each seeds from a real span).
    let widest = group[0] as LibrarySpan;
    for (const span of group) {
      if (span.end - span.start > widest.end - widest.start) {
        widest = span;
      }
    }
    clusters.push({
      common: widest.common,
      start: Math.min(...group.map((s) => s.start)),
      end: Math.max(...group.map((s) => s.end)),
      byLibrary,
      allByLibrary,
      excerpt: truncateExcerpt(widest.text),
    });
  }

  clusters.sort((a, b) => a.start - b.start || a.end - b.end);
  return clusters;
};

const truncateExcerpt = (value: string): string => {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= EXCERPT_MAX) {
    return collapsed;
  }
  const head = Math.ceil((EXCERPT_MAX - 1) / 2);
  const tail = Math.floor((EXCERPT_MAX - 1) / 2);
  return `${collapsed.slice(0, head)}…${collapsed.slice(collapsed.length - tail)}`;
};

const escapeCell = (value: string): string =>
  value.replace(/\|/g, "\\|").replace(/\n/g, " ");

type LibraryOutcome =
  | { readonly name: string; readonly status: "ok" }
  | {
      readonly name: string;
      readonly status: "unavailable";
      readonly reason: string;
    };

export type AdhocRunOptions = {
  readonly adapters: readonly {
    readonly adapter: Adapter;
    readonly mapping: NativeMapping;
  }[];
  readonly docs: readonly AdhocDoc[];
  readonly language: string;
};

/**
 * Run every adapter over the ad-hoc docs and render a Markdown comparison.
 * Returns the report text; the caller decides where to write it.
 */
export const runAdhoc = async ({
  adapters,
  docs,
  language,
}: AdhocRunOptions): Promise<string> => {
  const groundTruth = asGroundTruth(docs, language);

  // library -> docId -> spans
  const perLibrary = new Map<string, Map<string, LibrarySpan[]>>();
  const outcomes: LibraryOutcome[] = [];

  for (const { adapter, mapping } of adapters) {
    process.stderr.write(`running ${adapter.name}...\n`);
    const outcome = await adapter.run(groundTruth);
    if (outcome.status === "unavailable") {
      outcomes.push({
        name: adapter.name,
        status: "unavailable",
        reason: outcome.reason,
      });
      process.stderr.write(`  unavailable: ${outcome.reason}\n`);
      continue;
    }
    outcomes.push({ name: adapter.name, status: "ok" });
    const byDoc = new Map<string, LibrarySpan[]>();
    for (const doc of groundTruth) {
      const preds: readonly NativePrediction[] =
        outcome.predictions.get(doc.id) ?? [];
      const spans: LibrarySpan[] = [];
      for (const pred of preds) {
        const common = mapNative(pred.label, mapping);
        if (common === null) {
          continue;
        }
        spans.push({
          library: adapter.name,
          start: pred.start,
          end: pred.end,
          common,
          text: pred.text,
        });
      }
      byDoc.set(doc.id, spans);
    }
    perLibrary.set(adapter.name, byDoc);
  }

  const okLibraries = outcomes
    .filter((o) => o.status === "ok")
    .map((o) => o.name);

  return renderAdhoc({
    docs: groundTruth,
    language,
    okLibraries,
    outcomes,
    perLibrary,
  });
};

type RenderOptions = {
  readonly docs: readonly GroundTruthDocument[];
  readonly language: string;
  readonly okLibraries: readonly string[];
  readonly outcomes: readonly LibraryOutcome[];
  readonly perLibrary: ReadonlyMap<string, ReadonlyMap<string, LibrarySpan[]>>;
};

const STELLA = "stella";

const renderAdhoc = ({
  docs,
  language,
  okLibraries,
  outcomes,
  perLibrary,
}: RenderOptions): string => {
  const lines: string[] = [];
  const totals: Record<string, number> = {};
  for (const name of okLibraries) {
    totals[name] = 0;
  }

  // Pairwise vs stella, aggregated over every document.
  const pair: Record<
    string,
    { both: number; stellaOnly: number; competitorOnly: number }
  > = {};
  for (const name of okLibraries) {
    if (name !== STELLA) {
      pair[name] = { both: 0, stellaOnly: 0, competitorOnly: 0 };
    }
  }

  const docSections: string[] = [];
  for (const doc of docs) {
    const spans: LibrarySpan[] = [];
    for (const name of okLibraries) {
      const docSpans = perLibrary.get(name)?.get(doc.id) ?? [];
      totals[name] = (totals[name] ?? 0) + docSpans.length;
      spans.push(...docSpans);
    }
    const clusters = clusterSpans(spans);

    for (const cluster of clusters) {
      const stellaSpans = cluster.allByLibrary.get(STELLA) ?? [];
      for (const name of okLibraries) {
        if (name === STELLA) {
          continue;
        }
        const competitorSpans = cluster.allByLibrary.get(name) ?? [];
        const bucket = pair[name];
        if (bucket === undefined) {
          continue;
        }
        // "both" requires a DIRECT overlap between the two libraries' spans
        // (any pair, not just the widest): union-find clusters are transitive,
        // so co-membership through a third library must not count.
        const agree = stellaSpans.some((s) =>
          competitorSpans.some((c) => sameDetection(s, c)),
        );
        if (agree) {
          bucket.both++;
        } else {
          if (stellaSpans.length > 0) {
            bucket.stellaOnly++;
          }
          if (competitorSpans.length > 0) {
            bucket.competitorOnly++;
          }
        }
      }
    }

    docSections.push(...renderDocSection(doc, clusters, okLibraries));
  }

  lines.push("# Ad-hoc PII detection comparison (unseen input)");
  lines.push("");
  lines.push(
    "Every available library run over user-supplied text files with NO ground",
    "truth. This is a behaviour comparison, not a scored benchmark: there is no",
    "recall/precision here, only what each library detected side by side. Generated",
    "by `bun run bench:compare --input <file-or-dir>`.",
    "",
  );
  lines.push(
    "> PRIVACY: the tables below quote excerpts of detected entities from your",
    "> input files. If the input was sensitive, do NOT commit or share this report.",
    "> It is written under `results/adhoc/`, which is git-ignored.",
    "",
  );
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Documents: ${docs.length}`);
  lines.push(`- Assumed language (for model selection): ${language}`);
  lines.push("");

  lines.push("## Totals (spans detected, mapped to the common taxonomy)");
  lines.push("");
  lines.push("| Library | Spans |");
  lines.push("| --- | --- |");
  for (const name of okLibraries) {
    lines.push(`| ${name} | ${totals[name] ?? 0} |`);
  }
  lines.push("");

  const competitors = okLibraries.filter((name) => name !== STELLA);
  if (okLibraries.includes(STELLA) && competitors.length > 0) {
    lines.push("## Pairwise agreement vs stella");
    lines.push("");
    lines.push(
      "Spans are the aligned detection regions below (same common label and",
      "character overlap >= 0.5). `both` = stella and the competitor agree on a",
      "region; `stella only` / `competitor only` = detected by just one of the two.",
      "",
    );
    lines.push("| Competitor | both | stella only | competitor only |");
    lines.push("| --- | --- | --- | --- |");
    for (const name of competitors) {
      const bucket = pair[name] ?? {
        both: 0,
        stellaOnly: 0,
        competitorOnly: 0,
      };
      lines.push(
        `| ${name} | ${bucket.both} | ${bucket.stellaOnly} | ${bucket.competitorOnly} |`,
      );
    }
    lines.push("");
  }

  const unavailable = outcomes.filter((o) => o.status === "unavailable");
  if (unavailable.length > 0) {
    lines.push("## Excluded libraries");
    lines.push("");
    for (const o of unavailable) {
      if (o.status === "unavailable") {
        lines.push(`- **${o.name}**: ${o.reason}`);
      }
    }
    lines.push("");
  }

  lines.push("## Per-document detections");
  lines.push("");
  lines.push(...docSections);

  return `${lines.join("\n")}\n`;
};

const renderDocSection = (
  doc: GroundTruthDocument,
  clusters: readonly Cluster[],
  okLibraries: readonly string[],
): string[] => {
  const lines: string[] = [];
  lines.push(`### ${escapeCell(doc.id)} (${doc.text.length} chars)`);
  lines.push("");
  if (clusters.length === 0) {
    lines.push("_No entities detected by any library._");
    lines.push("");
    return lines;
  }

  const header = ["label", "offset", "excerpt", ...okLibraries];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const cluster of clusters) {
    const cells = okLibraries.map((name) => {
      const span = cluster.byLibrary.get(name);
      return span === undefined ? "·" : `${span.start}–${span.end}`;
    });
    lines.push(
      `| ${cluster.common} | ${cluster.start}–${cluster.end} | ${escapeCell(cluster.excerpt)} | ${cells.join(" | ")} |`,
    );
  }
  lines.push("");
  return lines;
};
