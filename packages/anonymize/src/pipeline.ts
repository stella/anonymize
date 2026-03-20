import {
  extractDefinedTerms,
  findCoreferenceSpans,
} from "./detectors/coreference";
import { scanExact, scanFuzzy } from "./detectors/gazetteer";
import { detectNameCorpus } from "./detectors/names";
import { processRegexMatches } from "./detectors/regex";
import { processLegalFormMatches } from "./detectors/legal-forms";
import { processTriggerMatches } from "./detectors/triggers";
import { processDenyListMatches } from "./detectors/deny-list";
import { processAddressSeeds } from "./detectors/address-seeds";
import { boostNearMissEntities } from "./filters/confidence-boost";
import { filterFalsePositives } from "./filters/false-positives";
import type { Entity, GazetteerEntry, PipelineConfig } from "./types";
import {
  buildUnifiedSearch,
  type UnifiedSearchInstance,
} from "./build-unified-search";
import { runUnifiedSearch } from "./unified-search";

const shouldReplace = (a: Entity, b: Entity): boolean =>
  a.score > b.score ||
  (a.score === b.score && a.end - a.start > b.end - b.start);

export const mergeAndDedup = (...layers: Entity[][]): Entity[] => {
  const all: Entity[] = [];
  for (const layer of layers) {
    for (const entity of layer) all.push(entity);
  }
  const sorted = all.toSorted((a, b) => a.start - b.start);
  const merged: Entity[] = [];
  for (const entity of sorted) {
    const idx = merged.findIndex(
      (e) => entity.start < e.end && entity.end > e.start,
    );
    if (idx !== -1) {
      const existing = merged[idx];
      if (existing && shouldReplace(entity, existing))
        merged[idx] = { ...entity };
    } else {
      merged.push({ ...entity });
    }
  }
  let result = merged.toSorted((a, b) => a.start - b.start);
  let changed = true;
  while (changed) {
    changed = false;
    const deduped: Entity[] = [];
    for (const entity of result) {
      const idx = deduped.findIndex(
        (e) => entity.start < e.end && entity.end > e.start,
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

export type NerInferenceFn = (
  fullText: string,
  labels: string[],
  threshold: number,
) => Promise<Entity[]>;

/**
 * Run the full detection pipeline.
 *
 * Single unified TextSearch scans the text once.
 * Results are dispatched to each detector's
 * post-processor by pattern index range.
 */
export const runPipeline = async (
  fullText: string,
  config: PipelineConfig,
  gazetteerEntries: GazetteerEntry[],
  nerInference: NerInferenceFn | null,
  onProgress?: (step: string, detail: string) => void,
  cachedSearch?: UnifiedSearchInstance,
): Promise<Entity[]> => {
  const log = (step: string, detail: string) => {
    onProgress?.(step, detail);
  };

  const search = cachedSearch ?? (await buildUnifiedSearch(config));

  // Two-pass scan (regex + literals)
  const { regexMatches, literalMatches } =
    runUnifiedSearch(search, fullText);
  const { slices } = search;

  const regexEntities = config.enableRegex
    ? processRegexMatches(
        regexMatches,
        slices.regex.start,
        slices.regex.end,
      )
    : [];
  if (regexEntities.length > 0)
    log("regex", `${regexEntities.length} matches`);

  const legalFormEntities = processLegalFormMatches(
    regexMatches,
    slices.legalForms.start,
    slices.legalForms.end,
  );
  if (legalFormEntities.length > 0)
    log(
      "legal-forms",
      `${legalFormEntities.length} matches`,
    );

  const triggerEntities =
    config.enableTriggerPhrases
      ? processTriggerMatches(
          regexMatches,
          slices.triggers.start,
          slices.triggers.end,
          fullText,
          search.triggerRules,
        )
      : [];
  if (triggerEntities.length > 0)
    log(
      "trigger-phrases",
      `${triggerEntities.length} matches`,
    );

  let nameCorpusEntities: Entity[] = [];
  if (
    config.enableNameCorpus &&
    !config.enableDenyList
  ) {
    nameCorpusEntities = detectNameCorpus(fullText);
    log(
      "name-corpus",
      `${nameCorpusEntities.length} matches`,
    );
  }

  const denyListEntities =
    config.enableDenyList && search.denyListData
      ? processDenyListMatches(
          literalMatches,
          slices.denyList.start,
          slices.denyList.end,
          fullText,
          search.denyListData,
        )
      : [];
  if (denyListEntities.length > 0)
    log(
      "deny-list",
      `${denyListEntities.length} matches`,
    );

  // Gazetteer: per-workspace, separate search
  let gazetteerExact: Entity[] = [];
  let gazetteerFuzzy: Entity[] = [];
  if (config.enableGazetteer && gazetteerEntries.length > 0) {
    gazetteerExact = scanExact(fullText, gazetteerEntries);
    gazetteerFuzzy = scanFuzzy(fullText, gazetteerEntries, gazetteerExact);
    log("gazetteer", `${gazetteerExact.length} exact + ${gazetteerFuzzy.length} fuzzy`);
  }

  // NER
  let nerEntities: Entity[] = [];
  if (config.enableNer && nerInference) {
    log("ner", "running inference...");
    nerEntities = await nerInference(fullText, config.labels, config.threshold);
    log("ner", `${nerEntities.length} entities`);
  }

  // Address seed expansion
  const preAddressEntities = [
    ...triggerEntities, ...regexEntities, ...legalFormEntities,
    ...nameCorpusEntities, ...denyListEntities,
    ...gazetteerExact, ...gazetteerFuzzy, ...nerEntities,
  ];
  const addressSeedEntities = await processAddressSeeds(
    literalMatches,
    slices.streetTypes.start,
    slices.streetTypes.end,
    fullText,
    preAddressEntities,
  );
  if (addressSeedEntities.length > 0)
    log("address-seeds", `${addressSeedEntities.length} expanded`);

  // Confidence boost
  const preBoostEntities = [...preAddressEntities, ...addressSeedEntities];
  let allEntities: Entity[];
  if (config.enableConfidenceBoost) {
    allEntities = boostNearMissEntities(preBoostEntities, config.threshold);
    const boosted = allEntities.length -
      preBoostEntities.filter((e) => e.score >= config.threshold).length;
    if (boosted > 0) log("confidence-boost", `${boosted} near-miss promoted`);
  } else {
    allEntities = preBoostEntities.filter((e) => e.score >= config.threshold);
  }

  // Merge + dedup
  const rawMerged = mergeAndDedup(allEntities);
  log("merge", `${rawMerged.length} after dedup`);

  // False-positive filtering
  const merged = filterFalsePositives(rawMerged);
  if (merged.length < rawMerged.length)
    log("filter", `removed ${rawMerged.length - merged.length} FPs`);

  // Coreference
  if (config.enableCoreference) {
    const terms = extractDefinedTerms(fullText, merged);
    if (terms.length > 0) {
      log("coreference", `${terms.length} defined terms`);
      const corefSpans = findCoreferenceSpans(fullText, terms);
      if (corefSpans.length > 0) {
        log("coreference-rescan", `${corefSpans.length} aliases`);
        return mergeAndDedup(merged, corefSpans);
      }
    }
  }

  return merged;
};
