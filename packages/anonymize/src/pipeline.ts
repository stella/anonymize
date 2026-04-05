import {
  extractDefinedTerms,
  findCoreferenceSpans,
} from "./detectors/coreference";
import { processGazetteerMatches } from "./detectors/gazetteer";
import { detectNameCorpus, initNameCorpus } from "./detectors/names";
import { processRegexMatches } from "./detectors/regex";
import { processLegalFormMatches } from "./detectors/legal-forms";
import { processTriggerMatches } from "./detectors/triggers";
import {
  ensureDenyListData,
  processDenyListMatches,
} from "./detectors/deny-list";
import { processAddressSeeds } from "./detectors/address-seeds";
import { propagateOrgNames } from "./detectors/org-propagation";
import {
  boostNearMissEntities,
  detectStreetPatternsNearAddresses,
  detectOrphanStreetLines,
  initPrepositions,
  initStreetAbbrevs,
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
import {
  applyHotwordRules,
  expandLabelsForHotwordRules,
  initHotwordRules,
} from "./filters/hotword-rules";
import { enforceBoundaryConsistency } from "./filters/boundary-consistency";
import type { Entity, GazetteerEntry, PipelineConfig } from "./types";
import {
  DEFAULT_ENTITY_LABELS,
  DETECTOR_PRIORITY,
  isLegalFormsEnabled,
} from "./types";
import {
  buildUnifiedSearch,
  type UnifiedSearchInstance,
} from "./build-unified-search";
import { runUnifiedSearch } from "./unified-search";
import { maskDetectedSpans, unmaskNerEntities } from "./util/entity-masking";
import type { PipelineContext } from "./context";
import { defaultContext } from "./context";

/**
 * Sources backed by curated literal dictionaries.
 * Longer matches from these sources are more specific,
 * so the containment rule trusts their length.
 */
const LITERAL_SOURCES: ReadonlySet<string> = new Set([
  "deny-list",
  "gazetteer",
]);

const shouldReplace = (a: Entity, b: Entity): boolean => {
  const aLen = a.end - a.start;
  const bLen = b.end - b.start;
  // Containment: when a literal-match entity (deny-list
  // or gazetteer) fully contains a shorter entity with
  // the same label, prefer the longer one. Curated
  // dictionary entries are more specific when longer:
  // "656 91 Brno" (deny-list) should beat "656 91"
  // (regex) even though regex has higher priority.
  // Non-literal sources (trigger, regex, NER) are
  // excluded because their length does not reliably
  // indicate accuracy.
  if (
    a.label === b.label &&
    LITERAL_SOURCES.has(a.source) &&
    a.start <= b.start &&
    a.end >= b.end &&
    aLen > bLen
  ) {
    return true;
  }
  if (
    a.label === b.label &&
    LITERAL_SOURCES.has(b.source) &&
    b.start <= a.start &&
    b.end >= a.end &&
    bLen > aLen
  ) {
    return false;
  }
  const aPri = DETECTOR_PRIORITY[a.source] ?? 0;
  const bPri = DETECTOR_PRIORITY[b.source] ?? 0;
  if (aPri !== bPri) return aPri > bPri;
  return a.score > b.score || (a.score === b.score && aLen > bLen);
};

/** Labels where colons are structurally significant. */
const COLON_LABELS = new Set(["ip address", "mac address"]);

/** Strip leading/trailing whitespace and punctuation. */
export const sanitizeEntities = (entities: Entity[]): Entity[] =>
  entities.flatMap((e) => {
    const strip = COLON_LABELS.has(e.label) ? /[\s,;]+/ : /[\s:,;]+/;
    // Also strip leading dots followed by whitespace —
    // artifact from trigger extraction after abbreviations
    // like "dat. nar." or "č.p." where the extraction
    // starts at the trailing dot of the abbreviation.
    const leadTrimmed = e.text
      .replace(/^(?:\.\s)+/, "")
      .replace(new RegExp(`^${strip.source}`, strip.flags), "");
    const lead = e.text.length - leadTrimmed.length;
    const cleaned = leadTrimmed.replace(
      new RegExp(`${strip.source}$`, strip.flags),
      "",
    );
    if (cleaned.length === 0) return [];
    // Reject entities with no alphanumeric content
    if (!/[\p{L}\p{N}]/u.test(cleaned)) return [];
    // Collapse internal whitespace runs (address entities
    // spanning multiple lines in structured documents)
    const collapsed = cleaned.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");
    if (collapsed === e.text) return [e];
    return [
      {
        ...e,
        start: e.start + lead,
        end: e.start + lead + collapsed.length,
        text: collapsed,
      },
    ];
  });

export const mergeAndDedup = (...layers: Entity[][]): Entity[] => {
  const all: Entity[] = [];
  for (const layer of layers) {
    for (const entity of layer) {
      all.push(entity);
    }
  }
  if (all.length === 0) return [];

  const sorted = all.toSorted((a, b) => a.start - b.start);

  // Single-pass sweep-line: since entities are sorted
  // by start, a new entity can only overlap the tail
  // of merged[] (all earlier entries end before it).
  const first = sorted[0];
  if (!first) return [];
  const merged: Entity[] = [{ ...first }];

  for (let i = 1; i < sorted.length; i++) {
    const entity = sorted[i];
    const last = merged[merged.length - 1];
    if (!entity || !last) continue;

    if (last.end <= entity.start) {
      // No overlap: append.
      merged.push({ ...entity });
    } else if (shouldReplace(entity, last)) {
      // Overlap: new entity wins.
      merged[merged.length - 1] = { ...entity };
    }
    // else: overlap but existing wins; discard entity.
  }

  return sanitizeEntities(merged);
};

export type NerInferenceFn = (
  fullText: string,
  labels: string[],
  threshold: number,
  signal?: AbortSignal,
) => Promise<Entity[]>;

/**
 * Extend monetary amount entities to include a trailing
 * "(slovy ...)" or "(slovně ...)" parenthetical that
 * spells out the amount in words. Common in Czech legal
 * documents, e.g. "1 529,-Kč (slovy jeden-tisíc)".
 *
 * Keywords are loaded from amount-words.json config so
 * new languages can be added without code changes.
 */
type AmountWordsConfig = {
  patterns: { lang: string; keywords: string[] }[];
};

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let amountWordsRe: RegExp | null = null;
let amountWordsLoaded = false;

const getAmountWordsRe = async (): Promise<RegExp> => {
  if (amountWordsLoaded && amountWordsRe) {
    return amountWordsRe;
  }
  try {
    const mod = await import("@stll/anonymize-data/config/amount-words.json");
    // eslint-disable-next-line no-unsafe-type-assertion -- JSON module shape
    const data = (mod as { default: AmountWordsConfig }).default;
    const keywords = data.patterns.flatMap((p) => p.keywords);
    const alt = keywords.map(escapeRegex).join("|");
    amountWordsRe = new RegExp(
      `^[,;]?[^\\S\\n]*(\\((?:${alt})[:\\s][^)\\n]{1,120}\\))`,
      "i",
    );
  } catch {
    // Fallback: original Czech-only pattern
    amountWordsRe = /^[,;]?[^\S\n]*(\((?:slovy|slovně)[:\s][^)\n]{1,120}\))/i;
  }
  amountWordsLoaded = true;
  return amountWordsRe;
};

const extendMonetaryAmountWords = (
  entities: Entity[],
  fullText: string,
  re: RegExp,
): Entity[] =>
  entities.map((e) => {
    if (e.label !== "monetary amount") return e;
    const after = fullText.slice(e.end);
    const m = re.exec(after);
    if (!m) return e;
    const newEnd = e.end + m[0].length;
    return {
      ...e,
      end: newEnd,
      text: fullText.slice(e.start, newEnd),
    };
  });

type AllowedLabelSet = ReadonlySet<string> | null;

const createAllowedLabelSetFromLabels = (
  labels: readonly string[],
): AllowedLabelSet => (labels.length > 0 ? new Set(labels) : null);

const createAllowedLabelSet = (config: PipelineConfig): AllowedLabelSet =>
  createAllowedLabelSetFromLabels(config.labels);

const filterAllowedLabels = (
  entities: Entity[],
  allowedLabels: AllowedLabelSet,
): Entity[] => {
  if (!allowedLabels) {
    return entities;
  }
  return entities.filter((e) => allowedLabels.has(e.label));
};

const labelIsAllowed = (
  label: string,
  allowedLabels: AllowedLabelSet,
): boolean => !allowedLabels || allowedLabels.has(label);

const getRequestedNerLabels = (
  config: PipelineConfig,
  expandForHotwords = false,
): readonly string[] => {
  const labels =
    config.labels.length > 0 ? config.labels : DEFAULT_ENTITY_LABELS;
  return expandForHotwords ? expandLabelsForHotwordRules(labels) : labels;
};

const checkAbort = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new DOMException("Pipeline aborted", "AbortError");
  }
};

const configKey = (
  config: PipelineConfig,
  gazetteerEntries: GazetteerEntry[],
): string => {
  const legalFormsEnabled = isLegalFormsEnabled(config);
  // Gazetteer fingerprint: sorted entry IDs,
  // canonical forms, labels, and variants.
  // Skip when gazetteer is disabled to avoid
  // unnecessary cache misses.
  const gazFingerprint =
    config.enableGazetteer && gazetteerEntries.length > 0
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
    `${legalFormsEnabled}:` +
    `${config.enableNameCorpus}:` +
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
  const promise = buildUnifiedSearch(config, gazetteerEntries, ctx);
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
 * Options for {@link runPipeline}.
 *
 * @property cachedSearch Pre-built search instance.
 *   When provided, `config` and `gazetteerEntries`
 *   are not used for building; the caller must
 *   ensure the instance matches both parameters.
 */
export type PipelineOptions = {
  fullText: string;
  config: PipelineConfig;
  gazetteerEntries: GazetteerEntry[];
  nerInference?: NerInferenceFn | null;
  onProgress?: (step: string, detail: string) => void;
  cachedSearch?: UnifiedSearchInstance;
  signal?: AbortSignal;
  context?: PipelineContext;
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
 */
export const runPipeline = async (
  options: PipelineOptions,
): Promise<Entity[]> => {
  const {
    fullText,
    config,
    gazetteerEntries,
    nerInference = null,
    onProgress,
    cachedSearch,
    signal,
    context,
  } = options;
  const ctx = context ?? defaultContext;
  const allowedLabels = createAllowedLabelSet(config);
  const legalFormsEnabled = isLegalFormsEnabled(config);

  const log = (step: string, detail: string) => {
    onProgress?.(step, detail);
  };

  checkAbort(signal);

  // Ensure generic-roles data, zone config, hotword
  // rules, and prepositions are loaded before the
  // pipeline runs. All are no-ops after the first call.
  let zoneInitOk = false;
  const enableHotwords = config.enableHotwordRules === true;
  let hotwordInitOk = false;
  const hotwordInit = enableHotwords
    ? initHotwordRules()
        .then(() => {
          hotwordInitOk = true;
        })
        .catch((err: unknown) => {
          log("hotwords", "init failed; skipping");
          console.warn("[anonymize] hotword rules init failed", err);
        })
    : Promise.resolve();
  if (config.enableZoneClassification) {
    const zoneInit = initZoneClassifier(ctx)
      .then(() => {
        zoneInitOk = true;
      })
      .catch((err: unknown) => {
        log("zones", "init failed; skipping");
        console.warn("[anonymize] zone classifier init failed", err);
      });
    await Promise.all([
      loadGenericRoles(ctx),
      initPrepositions(),
      initStreetAbbrevs(),
      zoneInit,
      hotwordInit,
    ]);
  } else {
    await Promise.all([
      loadGenericRoles(ctx),
      initPrepositions(),
      initStreetAbbrevs(),
      hotwordInit,
    ]);
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
    zones = classifyZones(fullText, ctx);
    if (zones.length > 0) {
      const zoneNames = [...new Set(zones.map((z) => z.zone))];
      log("zones", zoneNames.join(", "));
    }
  }

  checkAbort(signal);

  const hotwordsActive = enableHotwords && hotwordInitOk;
  const preHotwordAllowedLabels = hotwordsActive
    ? createAllowedLabelSetFromLabels(
        expandLabelsForHotwordRules(config.labels),
      )
    : allowedLabels;

  const search =
    cachedSearch ?? (await getCachedSearch(config, gazetteerEntries, ctx));

  checkAbort(signal);

  // Two-pass scan (regex + literals)
  const { regexMatches, literalMatches } = runUnifiedSearch(search, fullText);
  const { slices } = search;

  const rawRegexEntities = config.enableRegex
    ? processRegexMatches(
        regexMatches,
        slices.regex.start,
        slices.regex.end,
        search.regexMeta,
      )
    : [];
  const regexEntities = filterAllowedLabels(
    rawRegexEntities,
    preHotwordAllowedLabels,
  );
  if (regexEntities.length > 0) log("regex", `${regexEntities.length} matches`);

  const rawLegalFormEntities = legalFormsEnabled
    ? processLegalFormMatches(
        regexMatches,
        slices.legalForms.start,
        slices.legalForms.end,
        fullText,
      )
    : [];
  const legalFormEntities = filterAllowedLabels(
    rawLegalFormEntities,
    preHotwordAllowedLabels,
  );
  if (legalFormEntities.length > 0)
    log("legal-forms", `${legalFormEntities.length} matches`);

  const rawTriggerEntities = config.enableTriggerPhrases
    ? processTriggerMatches(
        regexMatches,
        slices.triggers.start,
        slices.triggers.end,
        fullText,
        search.triggerRules,
      )
    : [];
  const triggerEntities = filterAllowedLabels(
    rawTriggerEntities,
    preHotwordAllowedLabels,
  );
  if (triggerEntities.length > 0)
    log("trigger-phrases", `${triggerEntities.length} matches`);

  checkAbort(signal);

  let rawNameCorpusEntities: Entity[] = [];
  let nameCorpusEntities: Entity[] = [];
  if (config.enableNameCorpus && !config.enableDenyList) {
    await initNameCorpus(ctx);
    checkAbort(signal);
    rawNameCorpusEntities = detectNameCorpus(fullText, ctx);
    nameCorpusEntities = filterAllowedLabels(
      rawNameCorpusEntities,
      preHotwordAllowedLabels,
    );
    log("name-corpus", `${nameCorpusEntities.length} matches`);
  }

  const rawDenyListEntities =
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
  const denyListEntities = filterAllowedLabels(
    rawDenyListEntities,
    preHotwordAllowedLabels,
  );
  if (denyListEntities.length > 0)
    log("deny-list", `${denyListEntities.length} matches`);

  // Gazetteer: unified into tsLiterals
  const rawGazetteerEntities =
    config.enableGazetteer && search.gazetteerData
      ? processGazetteerMatches(
          literalMatches,
          slices.gazetteer.start,
          slices.gazetteer.end,
          fullText,
          search.gazetteerData,
        )
      : [];
  const gazetteerEntities = filterAllowedLabels(
    rawGazetteerEntities,
    preHotwordAllowedLabels,
  );
  if (gazetteerEntities.length > 0)
    log("gazetteer", `${gazetteerEntities.length} matches`);

  checkAbort(signal);

  const ruleContextEntities = [
    ...rawTriggerEntities,
    ...rawRegexEntities,
    ...rawLegalFormEntities,
    ...rawNameCorpusEntities,
    ...rawDenyListEntities,
    ...rawGazetteerEntities,
  ];

  // NER (mask rule-detected spans so the model doesn't
  // produce contradictory boundaries for known entities)
  let rawNerEntities: Entity[] = [];
  let nerEntities: Entity[] = [];
  if (config.enableNer && nerInference) {
    const maskResult = maskDetectedSpans(fullText, ruleContextEntities);
    log("ner", "running inference...");
    const rawNer = await nerInference(
      maskResult.maskedText,
      [...getRequestedNerLabels(config, hotwordsActive)],
      config.threshold,
      signal,
    );
    rawNerEntities = unmaskNerEntities(rawNer, maskResult, fullText);
    nerEntities = filterAllowedLabels(rawNerEntities, preHotwordAllowedLabels);
    const masked = rawNer.length - rawNerEntities.length;
    const labelFiltered = rawNerEntities.length - nerEntities.length;
    log(
      "ner",
      `${nerEntities.length} entities` +
        (masked > 0 ? ` (${masked} masked)` : "") +
        (labelFiltered > 0 ? ` (${labelFiltered} label-filtered)` : ""),
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
  const addressSeedEntities = labelIsAllowed("address", allowedLabels)
    ? await processAddressSeeds(
        literalMatches,
        slices.streetTypes.start,
        slices.streetTypes.end,
        fullText,
        [...ruleContextEntities, ...rawNerEntities],
      )
    : [];
  if (addressSeedEntities.length > 0)
    log("address-seeds", `${addressSeedEntities.length} expanded`);

  checkAbort(signal);

  // Zone-based score adjustment: apply before
  // threshold filtering so entities in PII-dense zones
  // can cross the threshold.
  const zoneAdjusted = applyZoneAdjustments(
    [...preAddressEntities, ...addressSeedEntities],
    zones,
  );

  // Hotword context rules: boost or reclassify
  // entities near relevant keywords. Applied after
  // zone adjustments so both effects stack.
  const preBoostEntities = hotwordsActive
    ? filterAllowedLabels(
        applyHotwordRules(zoneAdjusted, fullText),
        allowedLabels,
      )
    : zoneAdjusted;

  // Confidence boost + threshold filter
  let allEntities: Entity[];
  if (config.enableConfidenceBoost) {
    allEntities = boostNearMissEntities(preBoostEntities, config.threshold);
    const boosted =
      allEntities.length -
      preBoostEntities.filter((e) => e.score >= config.threshold).length;
    if (boosted > 0) log("confidence-boost", `${boosted} near-miss promoted`);
  } else {
    allEntities = preBoostEntities.filter((e) => e.score >= config.threshold);
  }

  // Street patterns near existing addresses
  // (e.g. "Ostrovni 225/1" near "110 00 Praha 1")
  const streetPatterns = labelIsAllowed("address", allowedLabels)
    ? detectStreetPatternsNearAddresses(fullText, allEntities)
    : [];
  if (streetPatterns.length > 0) {
    allEntities = [...allEntities, ...streetPatterns];
    log(
      "street-context",
      `${streetPatterns.length} street patterns near addresses`,
    );
  }

  // Orphan street lines in header zone
  const orphanStreets = labelIsAllowed("address", allowedLabels)
    ? detectOrphanStreetLines(fullText, allEntities)
    : [];
  if (orphanStreets.length > 0) {
    allEntities = [...allEntities, ...orphanStreets];
    log("orphan-streets", `${orphanStreets.length} header street lines`);
  }

  // Merge + dedup
  const rawMerged = mergeAndDedup(allEntities);
  log("merge", `${rawMerged.length} after dedup`);

  // Extend monetary amounts to include trailing
  // "(slovy ...)" or "(slovně ...)" parentheticals.
  // Runs after dedup so each monetary span is unique,
  // preventing duplicate extensions from clobbering
  // unrelated entities between e.end and newEnd.
  const amountWordsRe = await getAmountWordsRe();
  const mergedExtended = extendMonetaryAmountWords(
    rawMerged,
    fullText,
    amountWordsRe,
  );

  // Boundary consistency (merge adjacent, fix partial
  // words, remove nested same-label)
  const consistent = enforceBoundaryConsistency(mergedExtended, fullText);
  if (consistent.length < mergedExtended.length)
    log(
      "boundary",
      `${mergedExtended.length - consistent.length} consolidated`,
    );

  // Organization name propagation: strip legal form
  // suffixes from detected orgs and re-scan for bare
  // mentions of the base name. Gated by enableCoreference
  // since this is a coreference-like pass. Propagated
  // entities are filtered by the configured threshold to
  // ensure they respect the caller's confidence floor.
  let postOrgEntities = consistent;
  if (
    config.enableCoreference &&
    labelIsAllowed("organization", allowedLabels)
  ) {
    const orgPropagated = propagateOrgNames(consistent, fullText);
    const thresholded = orgPropagated.filter(
      (e) => e.score >= config.threshold,
    );
    if (thresholded.length > 0) {
      postOrgEntities = mergeAndDedup(consistent, thresholded);
      log("org-propagation", `${thresholded.length} base names`);
    }
  }

  // False-positive filtering
  const merged = filterFalsePositives(postOrgEntities, ctx, fullText);
  if (merged.length < postOrgEntities.length)
    log("filter", `removed ${postOrgEntities.length - merged.length} FPs`);

  checkAbort(signal);

  // Coreference
  // Clear stale entries unconditionally so a reused
  // context doesn't leak sourceText across documents.
  ctx.corefSourceMap.clear();
  if (config.enableCoreference) {
    const terms = await extractDefinedTerms(fullText, merged, ctx);
    if (terms.length > 0) {
      log("coreference", `${terms.length} defined terms`);
      const corefSpans = findCoreferenceSpans(fullText, terms, ctx);
      if (corefSpans.length > 0) {
        log("coreference-rescan", `${corefSpans.length} aliases`);
        const corefMerged = mergeAndDedup(merged, corefSpans);
        const corefConsistent = enforceBoundaryConsistency(
          corefMerged,
          fullText,
        );
        return sanitizeEntities(
          filterAllowedLabels(
            filterFalsePositives(corefConsistent, ctx, fullText),
            allowedLabels,
          ),
        );
      }
    }
  }

  // Re-sanitize: enforceBoundaryConsistency may adjust
  // entity boundaries after mergeAndDedup's sanitization,
  // potentially re-introducing whitespace or punctuation.
  return sanitizeEntities(filterAllowedLabels(merged, allowedLabels));
};
