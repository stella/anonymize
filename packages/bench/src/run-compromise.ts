/**
 * Runs compromise (the closest JS-ecosystem NLP baseline with span
 * output) over the English corpus documents and writes predictions
 * in the bench interchange format. compromise targets English, so
 * other languages are omitted and reported as skipped by the
 * quality runner.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import nlp from "compromise";

import { loadGoldDocuments } from "./fixtures";
import type { BenchSpan, PredictionsFile } from "./types";

type CompromiseMatch = {
  offset?: { start: number; length: number };
};

const matchesToSpans = (
  matches: CompromiseMatch[],
  label: string,
): BenchSpan[] => {
  const spans: BenchSpan[] = [];
  for (const match of matches) {
    if (!match.offset) continue;
    spans.push({
      start: match.offset.start,
      end: match.offset.start + match.offset.length,
      label,
    });
  }
  return spans;
};

const { values: args } = parseArgs({
  options: { out: { type: "string" } },
});

const predictions: PredictionsFile = { tool: "compromise", docs: [] };
for (const doc of loadGoldDocuments()) {
  if (doc.language !== "en") continue;
  const parsed = nlp(doc.text);
  const entities = [
    // SAFETY: compromise's .json({ offset: true }) returns match
    // objects with an offset field; the library ships no types.
    ...matchesToSpans(
      parsed.people().json({ offset: true }) as CompromiseMatch[],
      "person",
    ),
    ...matchesToSpans(
      parsed.organizations().json({ offset: true }) as CompromiseMatch[],
      "organization",
    ),
  ];
  predictions.docs.push({ id: doc.id, entities });
  console.log(
    JSON.stringify({ event: "doc", id: doc.id, entities: entities.length }),
  );
}

const outPath =
  args.out ??
  join(import.meta.dir, "..", "results", "predictions.compromise.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(predictions, null, 2)}\n`);
console.log(JSON.stringify({ event: "written", path: outPath }));
