/**
 * Smoke test against the built artifact. The regression suite
 * imports from src, so it cannot see failures that only exist in
 * the bundled output (e.g. an import the bundler could not
 * resolve). This script imports the published entrypoint the way a
 * package consumer does and fails on either signal of silent
 * degradation: an "[anonymize]" warning, or a non-Western name the
 * corpus chunks are required to detect.
 *
 * Run after `bun run build`: `bun run smoke:dist`.
 */
import { createPipelineContext, runPipeline } from "../dist/index.mjs";

const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  warnings.push(args.map(String).join(" "));
  originalWarn(...args);
};

const config = {
  threshold: 0.3,
  enableTriggerPhrases: false,
  enableRegex: false,
  enableLegalForms: false,
  enableNameCorpus: true,
  enableDenyList: false,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["person"],
  workspaceId: "dist-smoke",
};

// Detectable only through the non-Western name corpus (honorific +
// corpus tokens); same public-figure example as the src test suite.
const fullText = "A speech was delivered by Smt. Smriti Irani.";

const entities = await runPipeline({
  fullText,
  config,
  gazetteerEntries: [],
  context: createPipelineContext(),
});

console.warn = originalWarn;

const degradations = warnings.filter((line) => line.includes("[anonymize]"));
if (degradations.length > 0) {
  throw new Error(
    `dist emitted degradation warnings:\n${degradations.join("\n")}`,
  );
}

const person = entities.find(
  (entity) => entity.label === "person" && entity.text.includes("Smriti Irani"),
);
if (!person) {
  throw new Error(
    "dist build did not detect a non-Western name; corpus chunks are missing from the bundle",
  );
}

console.log(
  JSON.stringify({ event: "dist-smoke", ok: true, detected: person.text }),
);
