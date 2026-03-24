import {
  extractDefinedTerms,
  findCoreferenceSpans,
} from "./detectors/coreference";
import { scanExact, scanFuzzy } from "./detectors/gazetteer";
import {
  detectNameCorpus,
  initNameCorpus,
} from "./detectors/names";
import { processRegexMatches } from "./detectors/regex";
import { processLegalFormMatches } from "./detectors/legal-forms";
import { processTriggerMatches } from "./detectors/triggers";
import { processDenyListMatches } from "./detectors/deny-list";
import { processAddressSeeds } from "./detectors/address-seeds";
import {
  boostNearMissEntities,
  detectStreetPatternsNearAddresses,
} from "./filters/confidence-boost";
import {
  filterFalsePositives,
  loadGenericRoles,
} from "./filters/false-positives";
import type { Entity, GazetteerEntry, PipelineConfig } from "./types";
import {
  buildUnifiedSearch,
  type UnifiedSearchInstance,
} from "./build-unified-search";
import { runUnifiedSearch } from "./unified-search";

const shouldReplace = (a: Entity, b: Entity): boolean =>
  a.score > b.score ||
  (a.score === b.score && a.end - a.start > b.end - b.start);

export const mergeAndDedup = (
  ...layers: Entity[][]
): Entity[] => {
  const all: Entity[] = [];
  for (const layer of layers) {
    for (const entity of layer) all.push(entity);
  }
  if (all.length === 0) return [];

  const sorted = all.toSorted(
    (a, b) => a.start - b.start,
  );

  // Single-pass sweep-line: since entities are sorted
  // by start, a new entity can only overlap the tail
  // of merged[] (all earlier entries end before it).
  const merged: Entity[] = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const entity = sorted[i];
    const last = merged[merged.length - 1];

    if (last.end <= entity.start) {
      // No overlap: append.
      merged.push({ ...entity });
    } else if (shouldReplace(entity, last)) {
      // Overlap: new entity wins.
      merged[merged.length - 1] = { ...entity };
    }
    // else: overlap but existing wins; discard entity.
  }

  return merged;
};

export type NerInferenceFn = (
  fullText: string,
  labels: string[],
  threshold: number,
) => Promise<Entity[]>;

// Module-level cache keyed on config fingerprint.
// Rebuilds when config changes (different countries,
// features enabled/disabled).
let _cachedKey = "";
let _cachedSearch: UnifiedSearchInstance | null =
  null;
let _cachedSearchPromise: Promise<UnifiedSearchInstance> | null =
  null;

const configKey = (config: PipelineConfig): string =>
  `${config.enableDenyList}:${config.enableTriggerPhrases}:` +
  `${config.denyListCountries?.toSorted().join(",") ?? ""}:` +
  `${config.denyListRegions?.toSorted().join(",") ?? ""}:` +
  `${config.denyListExcludeCategories?.toSorted().join(",") ?? ""}`;

const getCachedSearch = async (
  config: PipelineConfig,
): Promise<UnifiedSearchInstance> => {
  const key = configKey(config);
  if (_cachedSearch && _cachedKey === key) {
    return _cachedSearch;
  }
  if (_cachedSearchPromise && _cachedKey === key) {
    return _cachedSearchPromise;
  }
  // Build new search. Null the cached instance first
  // so concurrent callers don't use stale data while
  // the new build is in flight.
  _cachedSearch = null;
  _cachedKey = key;
  const promise = buildUnifiedSearch(config);
  _cachedSearchPromise = promise;
  const result = await promise;
  // Guard: another call may have replaced the key
  // while we were awaiting. Only cache if still ours.
  if (_cachedKey === key) {
    _cachedSearch = result;
  }
  return result;
};

/**
 * Run the full detection pipeline.
 *
 * Two TextSearch instances scan the text (regex +
 * literals). Results are dispatched to each
 * detector's post-processor by pattern index range.
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

  // Ensure generic-roles data is loaded before
  // filterFalsePositives runs. This is a no-op if
  // buildDenyList already loaded it.
  await loadGenericRoles();

  const search =
    cachedSearch ?? (await getCachedSearch(config));

  // Two-pass scan (regex + literals)
  const { regexMatches, literalMatches } =
    runUnifiedSearch(search, fullText);
  const { slices } = search;

  const regexEntities = config.enableRegex
    ? processRegexMatches(
        regexMatches,
        slices.regex.start,
        slices.regex.end,
        search.regexMeta,
      )
    : [];
  if (regexEntities.length > 0)
    log("regex", `${regexEntities.length} matches`);

  const legalFormEntities = processLegalFormMatches(
    regexMatches,
    slices.legalForms.start,
    slices.legalForms.end,
    fullText,
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
    await initNameCorpus();
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

  // Street patterns near existing addresses
  // (e.g. "Ostrovní 225/1" near "110 00 Praha 1")
  const streetPatterns = detectStreetPatternsNearAddresses(
    fullText,
    allEntities,
  );
  if (streetPatterns.length > 0) {
    allEntities = [...allEntities, ...streetPatterns];
    log("street-context", `${streetPatterns.length} street patterns near addresses`);
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
    const terms = await extractDefinedTerms(fullText, merged);
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
