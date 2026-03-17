import {
  extractDefinedTerms,
  findCoreferenceSpans,
} from "./detectors/coreference";
import { buildDenyList, scanDenyList } from "./detectors/deny-list";
import type { DenyListAutomaton } from "./detectors/deny-list";
import { scanExact, scanFuzzy } from "./detectors/gazetteer";
import { detectLegalFormEntities } from "./detectors/legal-forms";
import { detectNameCorpus } from "./detectors/names";
import { detectRegexPii } from "./detectors/regex";
import { detectTriggerPhrases } from "./detectors/triggers";
import { boostNearMissEntities } from "./filters/confidence-boost";
import { filterFalsePositives } from "./filters/false-positives";
import type { Entity, GazetteerEntry, PipelineConfig } from "./types";

/**
 * Check if entity `a` should replace entity `b`.
 * Prefers higher score; on tie, prefers longer span.
 */
const shouldReplace = (a: Entity, b: Entity): boolean =>
  a.score > b.score ||
  (a.score === b.score &&
    a.end - a.start > b.end - b.start);

/**
 * Merge entity arrays, sort by offset, and deduplicate
 * overlapping spans. Keeps the highest-scoring entity;
 * on equal score, keeps the longer span.
 */
export const mergeAndDedup = (
  ...layers: Entity[][]
): Entity[] => {
  const all: Entity[] = [];
  for (const layer of layers) {
    for (const entity of layer) {
      all.push(entity);
    }
  }

  const sorted = all.toSorted(
    (a, b) => a.start - b.start,
  );

  const merged: Entity[] = [];
  for (const entity of sorted) {
    const idx = merged.findIndex(
      (e) =>
        entity.start < e.end && entity.end > e.start,
    );

    if (idx !== -1) {
      const existing = merged[idx];
      if (existing && shouldReplace(entity, existing)) {
        merged[idx] = { ...entity };
      }
    } else {
      merged.push({ ...entity });
    }
  }

  // Second pass: a replacement may have widened a span,
  // creating new overlaps. Repeat until stable to handle
  // cascading overlaps from span-widening replacements.
  let result = merged.toSorted(
    (a, b) => a.start - b.start,
  );
  let changed = true;
  while (changed) {
    changed = false;
    const deduped: Entity[] = [];
    for (const entity of result) {
      const idx = deduped.findIndex(
        (e) =>
          entity.start < e.end && entity.end > e.start,
      );
      if (idx !== -1) {
        const existing = deduped[idx];
        if (existing && shouldReplace(entity, existing)) {
          deduped[idx] = entity;
          changed = true;
        }
      } else {
        deduped.push(entity);
      }
    }
    result = deduped;
  }

  return result;
};

/**
 * Pipeline callback for NER inference (Step 4).
 * The caller provides this because NER runs in a Web
 * Worker and the pipeline itself stays on the main thread.
 */
export type NerInferenceFn = (
  fullText: string,
  labels: string[],
  threshold: number,
) => Promise<Entity[]>;

/**
 * Run the full detection pipeline.
 *
 * Steps 1-3 and 5-8 are pure TypeScript on the main
 * thread. Step 4 (NER) is delegated to the caller via
 * the `nerInference` callback.
 *
 * Pipeline order:
 *   1. Trigger-phrase scan (Czech/German legal)
 *   2. Regex scan (structured PII formats)
 *   3. Aho-Corasick gazetteer scan (known entities)
 *   4. GLiNER NER (Web Worker, ONNX/WebGPU)
 *   5. Context confidence boosting
 *   6. Merge + dedup all layers
 *   7. Defined-term coreference extraction
 *   8. Re-scan with new coreference variants
 *
 * Returns the final merged entity array.
 */
export const runPipeline = async (
  fullText: string,
  config: PipelineConfig,
  gazetteerEntries: GazetteerEntry[],
  nerInference: NerInferenceFn | null,
  onProgress?: (step: string, detail: string) => void,
  denyListAutomaton?: DenyListAutomaton | null,
): Promise<Entity[]> => {
  const log = (step: string, detail: string) => {
    onProgress?.(step, detail);
  };

  // Step 1: Trigger phrases
  let triggerEntities: Entity[] = [];
  if (config.enableTriggerPhrases) {
    triggerEntities = await detectTriggerPhrases(fullText);
    log("trigger-phrases", `${triggerEntities.length} matches`);
  }

  // Step 2: Regex
  let regexEntities: Entity[] = [];
  if (config.enableRegex) {
    regexEntities = detectRegexPii(fullText);
    log("regex", `${regexEntities.length} matches`);
  }

  // Step 2b: Legal form detection
  const legalFormEntities =
    await detectLegalFormEntities(fullText);
  if (legalFormEntities.length > 0) {
    log(
      "legal-forms",
      `${legalFormEntities.length} matches`,
    );
  }

  // Step 2c: Name corpus
  let nameCorpusEntities: Entity[] = [];
  if (config.enableNameCorpus) {
    nameCorpusEntities = detectNameCorpus(fullText);
    log(
      "name-corpus",
      `${nameCorpusEntities.length} matches`,
    );
  }

  // Step 2d: Deny list
  let denyListEntities: Entity[] = [];
  if (config.enableDenyList) {
    // Build automaton if not pre-built by the caller
    const automaton =
      denyListAutomaton !== undefined
        ? denyListAutomaton
        : await buildDenyList(config);
    if (automaton) {
      denyListEntities = scanDenyList(
        fullText,
        automaton,
      );
      log(
        "deny-list",
        `${denyListEntities.length} matches`,
      );
    }
  }

  // Step 3: Gazetteer
  let gazetteerExact: Entity[] = [];
  let gazetteerFuzzy: Entity[] = [];
  if (config.enableGazetteer && gazetteerEntries.length > 0) {
    gazetteerExact = scanExact(fullText, gazetteerEntries);
    gazetteerFuzzy = scanFuzzy(fullText, gazetteerEntries, gazetteerExact);
    log(
      "gazetteer",
      `${gazetteerExact.length} exact + ${gazetteerFuzzy.length} fuzzy`,
    );
  }

  // Step 4: NER
  let nerEntities: Entity[] = [];
  if (config.enableNer && nerInference) {
    log("ner", "running inference...");
    nerEntities = await nerInference(fullText, config.labels, config.threshold);
    log("ner", `${nerEntities.length} entities`);
  }

  // Step 5: Confidence boost
  const preBoostEntities = [
    ...triggerEntities,
    ...regexEntities,
    ...legalFormEntities,
    ...nameCorpusEntities,
    ...denyListEntities,
    ...gazetteerExact,
    ...gazetteerFuzzy,
    ...nerEntities,
  ];

  let allEntities: Entity[];
  if (config.enableConfidenceBoost) {
    allEntities = boostNearMissEntities(preBoostEntities, config.threshold);
    const boostedCount =
      allEntities.length -
      preBoostEntities.filter((e) => e.score >= config.threshold).length;
    if (boostedCount > 0) {
      log("confidence-boost", `${boostedCount} near-miss entities promoted`);
    }
  } else {
    allEntities = preBoostEntities.filter((e) => e.score >= config.threshold);
  }

  // Step 6: Merge + dedup
  const rawMerged = mergeAndDedup(allEntities);
  log("merge", `${rawMerged.length} after dedup`);

  // Step 6b: False-positive filtering
  const merged = filterFalsePositives(rawMerged);
  if (merged.length < rawMerged.length) {
    log(
      "filter",
      `removed ${rawMerged.length - merged.length} false positives`,
    );
  }

  // Step 7: Defined-term coreference
  if (config.enableCoreference) {
    const terms = extractDefinedTerms(fullText, merged);

    if (terms.length > 0) {
      log("coreference", `${terms.length} defined terms found`);

      // Step 8: Re-scan with extracted aliases
      const corefSpans = findCoreferenceSpans(fullText, terms);
      if (corefSpans.length > 0) {
        log("coreference-rescan", `${corefSpans.length} alias occurrences`);

        return mergeAndDedup(merged, corefSpans);
      }
    }
  }

  return merged;
};
