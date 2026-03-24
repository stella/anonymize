import {
  extractDefinedTerms,
  findCoreferenceSpans,
} from "./detectors/coreference";
import { processGazetteerMatches } from "./detectors/gazetteer";
import {
  detectNameCorpus,
  initNameCorpus,
} from "./detectors/names";
import { processRegexMatches } from "./detectors/regex";
import { processLegalFormMatches } from "./detectors/legal-forms";
import { processTriggerMatches } from "./detectors/triggers";
import {
  ensureDenyListData,
  processDenyListMatches,
} from "./detectors/deny-list";
import { processAddressSeeds } from "./detectors/address-seeds";
import {
  boostNearMissEntities,
  detectStreetPatternsNearAddresses,
} from "./filters/confidence-boost";
import {
  filterFalsePositives,
  loadGenericRoles,
} from "./filters/false-positives";
import {
  applyZoneAdjustments,
  classifyZones,
  initZoneClassifier,
  type ZoneSpan,
} from "./filters/zone-classifier";
import { enforceBoundaryConsistency } from "./filters/boundary-consistency";
import type {
  Entity,
  GazetteerEntry,
  PipelineConfig,
} from "./types";
import { DETECTOR_PRIORITY } from "./types";
import {
  buildUnifiedSearch,
  type UnifiedSearchInstance,
} from "./build-unified-search";
import { runUnifiedSearch } from "./unified-search";
import {
  maskDetectedSpans,
  unmaskNerEntities,
} from "./util/entity-masking";
import type { PipelineContext } from "./context";
import { defaultContext } from "./context";

const shouldReplace = (
  a: Entity,
  b: Entity,
): boolean => {
  const aPri = DETECTOR_PRIORITY[a.source] ?? 0;
  const bPri = DETECTOR_PRIORITY[b.source] ?? 0;
  if (aPri !== bPri) return aPri > bPri;
  return (
    a.score > b.score ||
    (a.score === b.score &&
      a.end - a.start > b.end - b.start)
  );
};

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
  signal?: AbortSignal,
) => Promise<Entity[]>;

const checkAbort = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new DOMException(
      "Pipeline aborted",
      "AbortError",
    );
  }
};

const configKey = (
  config: PipelineConfig,
  gazetteerEntries: GazetteerEntry[],
): string => {
  // Gazetteer fingerprint: sorted entry IDs,
  // canonical forms, labels, and variants.
  // Skip when gazetteer is disabled to avoid
  // unnecessary cache misses.
  const gazFingerprint =
    config.enableGazetteer &&
    gazetteerEntries.length > 0
      ? gazetteerEntries
          .map(
            (e) =>
              `${e.id}:${e.canonical}:${e.label}:${[...e.variants].sort().join(",")}`,
          )
          .toSorted()
          .join(";")
      : "";
  return (
    `${config.enableDenyList}:` +
    `${config.enableTriggerPhrases}:` +
    `${config.denyListCountries?.toSorted().join(",") ?? ""}:` +
    `${config.denyListRegions?.toSorted().join(",") ?? ""}:` +
    `${config.denyListExcludeCategories?.toSorted().join(",") ?? ""}:` +
    `${config.enableGazetteer}:${gazFingerprint}`
  );
};

/**
 * Get or build a cached search instance. Cache state
 * lives on the provided PipelineContext, not at module
 * level.
 */
const getCachedSearch = async (
  config: PipelineConfig,
  gazetteerEntries: GazetteerEntry[],
  ctx: PipelineContext,
): Promise<UnifiedSearchInstance> => {
  const key = configKey(config, gazetteerEntries);
  if (ctx.search && ctx.searchKey === key) {
    return ctx.search;
  }
  if (ctx.searchPromise && ctx.searchKey === key) {
    return ctx.searchPromise;
  }
  // Build new search. Null the cached instance first
  // so concurrent callers don't use stale data while
  // the new build is in flight.
  ctx.search = null;
  ctx.searchKey = key;
  const promise = buildUnifiedSearch(
    config,
    gazetteerEntries,
    ctx,
  );
  ctx.searchPromise = promise;
  const result = await promise;
  // Guard: another call may have replaced the key
  // while we were awaiting. Only cache if still ours.
  if (ctx.searchKey === key) {
    ctx.search = result;
  }
  return result;
};

/**
 * Run the full detection pipeline.
 *
 * Two TextSearch instances scan the text (regex +
 * literals). Results are dispatched to each
 * detector's post-processor by pattern index range.
 *
 * Pass an AbortSignal to cancel the pipeline between
 * stages. Throws a DOMException with name "AbortError"
 * when cancelled.
 *
 * Pass an optional `context` to isolate cached state
 * from other pipeline runs. If omitted, a module-level
 * default context is used (backward compatible).
 *
 * @param cachedSearch Pre-built search instance.
 *   When provided, `config` and `gazetteerEntries`
 *   are not used for building; the caller must
 *   ensure the instance matches both parameters.
 */
export const runPipeline = async (
  fullText: string,
  config: PipelineConfig,
  gazetteerEntries: GazetteerEntry[],
  nerInference: NerInferenceFn | null,
  onProgress?: (step: string, detail: string) => void,
  cachedSearch?: UnifiedSearchInstance,
  signal?: AbortSignal,
  context?: PipelineContext,
): Promise<Entity[]> => {
  const ctx = context ?? defaultContext;

  const log = (step: string, detail: string) => {
    onProgress?.(step, detail);
  };

  checkAbort(signal);

  // Ensure generic-roles data and zone config are
  // loaded before the pipeline runs. Both are no-ops
  // after the first call. Zone init is isolated so a
  // transient failure degrades gracefully to no zones.
  let zoneInitOk = false;
  if (config.enableZoneClassification) {
    const zoneInit = initZoneClassifier()
      .then(() => {
        zoneInitOk = true;
      })
      .catch((err: unknown) => {
        log("zones", "init failed; skipping");
        console.warn(
          "[anonymize] zone classifier init failed",
          err,
        );
      });
    await Promise.all([
      loadGenericRoles(ctx),
      zoneInit,
    ]);
  } else {
    await loadGenericRoles(ctx);
  }

  // When a pre-built search is provided, buildDenyList
  // was skipped for this context. Ensure stopwords,
  // allow list, and person stopwords are loaded so
  // processDenyListMatches filters correctly.
  if (cachedSearch && config.enableDenyList) {
    await ensureDenyListData(ctx);
  }

  // Classify document zones once up front
  let zones: ZoneSpan[] = [];
  if (config.enableZoneClassification && zoneInitOk) {
    zones = classifyZones(fullText);
    if (zones.length > 0) {
      const zoneNames = [
        ...new Set(zones.map((z) => z.zone)),
      ];
      log("zones", zoneNames.join(", "));
    }
  }

  checkAbort(signal);

  const search =
    cachedSearch ??
    (await getCachedSearch(
      config,
      gazetteerEntries,
      ctx,
    ));

  checkAbort(signal);

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

  checkAbort(signal);

  let nameCorpusEntities: Entity[] = [];
  if (
    config.enableNameCorpus &&
    !config.enableDenyList
  ) {
    await initNameCorpus(ctx);
    checkAbort(signal);
    nameCorpusEntities = detectNameCorpus(fullText, ctx);
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
          ctx,
        )
      : [];
  if (denyListEntities.length > 0)
    log(
      "deny-list",
      `${denyListEntities.length} matches`,
    );

  // Gazetteer: unified into tsLiterals
  const gazetteerEntities =
    config.enableGazetteer && search.gazetteerData
      ? processGazetteerMatches(
          literalMatches,
          slices.gazetteer.start,
          slices.gazetteer.end,
          fullText,
          search.gazetteerData,
        )
      : [];
  if (gazetteerEntities.length > 0)
    log(
      "gazetteer",
      `${gazetteerEntities.length} matches`,
    );

  checkAbort(signal);

  // NER (mask rule-detected spans so the model doesn't
  // produce contradictory boundaries for known entities)
  let nerEntities: Entity[] = [];
  if (config.enableNer && nerInference) {
    const ruleEntities = [
      ...triggerEntities,
      ...regexEntities,
      ...legalFormEntities,
      ...nameCorpusEntities,
      ...denyListEntities,
      ...gazetteerEntities,
    ];
    const maskResult = maskDetectedSpans(
      fullText,
      ruleEntities,
    );
    log("ner", "running inference...");
    const rawNer = await nerInference(
      maskResult.maskedText,
      config.labels,
      config.threshold,
      signal,
    );
    nerEntities = unmaskNerEntities(
      rawNer,
      maskResult,
      fullText,
    );
    const dropped = rawNer.length - nerEntities.length;
    log(
      "ner",
      `${nerEntities.length} entities` +
        (dropped > 0 ? ` (${dropped} masked)` : ""),
    );
  }

  checkAbort(signal);

  // Address seed expansion
  const preAddressEntities = [
    ...triggerEntities,
    ...regexEntities,
    ...legalFormEntities,
    ...nameCorpusEntities,
    ...denyListEntities,
    ...gazetteerEntities,
    ...nerEntities,
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

  checkAbort(signal);

  // Zone-based score adjustment: apply before
  // threshold filtering so entities in PII-dense zones
  // can cross the threshold.
  const preBoostEntities = applyZoneAdjustments(
    [...preAddressEntities, ...addressSeedEntities],
    zones,
  );

  // Confidence boost + threshold filter
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
  // (e.g. "Ostrovni 225/1" near "110 00 Praha 1")
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

  // Boundary consistency (merge adjacent, fix partial
  // words, remove nested same-label)
  const consistent = enforceBoundaryConsistency(
    rawMerged,
    fullText,
  );
  if (consistent.length !== rawMerged.length)
    log(
      "boundary",
      `${rawMerged.length - consistent.length} consolidated`,
    );

  // False-positive filtering
  const merged = filterFalsePositives(consistent, ctx);
  if (merged.length < consistent.length)
    log("filter", `removed ${consistent.length - merged.length} FPs`);

  checkAbort(signal);

  // Coreference
  if (config.enableCoreference) {
    const terms = await extractDefinedTerms(
      fullText,
      merged,
      ctx,
    );
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
