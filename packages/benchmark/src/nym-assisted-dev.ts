import { join } from "node:path";

import { createNymAssistedAdapter } from "./adapters/nym-assisted";
import { createStllAdapter } from "./adapters/stella";
import { buildGroundTruthDocument, type RawDocument } from "./ground-truth";
import { aggregate, scoreCorpus } from "./metrics";
import { STELLA_MAPPING } from "./taxonomy";

const fixturePath = join(
  import.meta.dir,
  "..",
  "fixtures",
  "model-assisted",
  "de.json",
);
const raw = (await Bun.file(fixturePath).json()) as RawDocument[];
const documents = raw.map(buildGroundTruthDocument);

for (const adapter of [createStllAdapter(), createNymAssistedAdapter()]) {
  const outcome = await adapter.run(documents);
  if (outcome.status === "unavailable") {
    throw new Error(`${adapter.name} unavailable: ${outcome.reason}`);
  }
  const score = aggregate(
    scoreCorpus(documents, outcome.predictions, STELLA_MAPPING, "overlap"),
  );
  console.log(
    JSON.stringify({
      provider: adapter.name,
      documents: documents.length,
      precision: score.precision,
      recall: score.recall,
      f1: score.f1,
      tp: score.tp,
      fp: score.fp,
      fn: score.fn,
      timing: outcome.timing,
    }),
  );
}
