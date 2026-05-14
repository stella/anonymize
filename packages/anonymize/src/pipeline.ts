import {
  extractDefinedTerms,
  findCoreferenceSpans,
} from "./detectors/coreference";
import { processGazetteerMatches } from "./detectors/gazetteer";
import { detectNameCorpus, initNameCorpus } from "./detectors/names";
import { processRegexMatches } from "./detectors/regex";
import {
  getKnownLegalSuffixes,
  processLegalFormMatches,
  warmLegalRoleHeads,
} from "./detectors/legal-forms";
import {
  processTriggerMatches,
  warmAddressStopKeywords,
} from "./detectors/triggers";
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
  initAddressComponents,
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

const isCallerOwnedEntity = (entity: Entity): boolean =>
  entity.sourceDetail === "custom-deny-list" ||
  entity.sourceDetail === "custom-regex";

const hasLockedBoundary = (entity: Entity): boolean =>
  isCallerOwnedEntity(entity);

const shouldReplace = (a: Entity, b: Entity): boolean => {
  const aLen = a.end - a.start;
  const bLen = b.end - b.start;
  const aCallerOwned = isCallerOwnedEntity(a);
  const bCallerOwned = isCallerOwnedEntity(b);
  if (aCallerOwned !== bCallerOwned) {
    return aCallerOwned;
  }

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

/**
 * Labels whose detectors emit precise, evidence-backed spans. When
 * one of these fires at the exact same offsets as a fuzzier
 * `address` hit (city dictionary lookup, address-seed cluster), the
 * `address` label is almost always a dictionary collision — "March
 * 15" the date getting tagged as an address because "March" appears
 * in a city corpus, or "Brent Phillips" emitted as both `person`
 * and `address` because "Brent" is a UK city. The precise detector
 * wins.
 */
const PRECISE_OVER_ADDRESS: ReadonlySet<string> = new Set([
  "person",
  "date",
  "date of birth",
  "phone number",
  "email address",
  "monetary amount",
  "iban",
  "bank account number",
  "tax identification number",
  "registration number",
  "identity card number",
  "national identification number",
  "passport number",
  "credit card number",
]);

/**
 * Labels the `person` chain wins against at identical offsets. The
 * chain carries adjacent-name evidence (deny-list surname plus a
 * capitalised follow-up) a single-token dictionary collision does
 * not. Kept narrow: organizations are NOT here — "Morgan Stanley"
 * legitimately appears in both the org and name dictionaries, and
 * the existing detector priority is the right tie-breaker there.
 */
const PERSON_PREFERRED_OVER: ReadonlySet<string> = new Set([
  "address",
  "land parcel",
]);

const resolveSameSpanLabelConflicts = (entities: Entity[]): Entity[] => {
  if (entities.length < 2) return entities;
  const byOffsets = new Map<string, Entity[]>();
  for (const entity of entities) {
    const key = `${entity.start}:${entity.end}`;
    const list = byOffsets.get(key);
    if (list) {
      list.push(entity);
    } else {
      byOffsets.set(key, [entity]);
    }
  }
  const dropped = new Set<Entity>();
  for (const [, group] of byOffsets) {
    if (group.length < 2) continue;
    const labels = new Set(group.map((e) => e.label));
    if (labels.size < 2) continue;

    const hasPerson = labels.has("person");
    const hasPreciseNonAddress = [...labels].some(
      (l) => l !== "address" && PRECISE_OVER_ADDRESS.has(l),
    );

    // When entities at the same offsets have different labels,
    // also let detector priority break ties: a `legal-form`
    // organization hit (priority 3) should keep its label over a
    // coincident `deny-list` person hit (priority 2). Compute the
    // max priority once so we can drop strictly-lower-priority
    // duplicates regardless of label.
    let maxPriority = -1;
    for (const e of group) {
      if (hasLockedBoundary(e)) continue;
      const pri = DETECTOR_PRIORITY[e.source] ?? 0;
      if (pri > maxPriority) maxPriority = pri;
    }

    for (const e of group) {
      // Caller-owned spans (custom deny-list / custom regex) carry
      // explicit user intent; never drop them in favour of a
      // detector-generated label.
      if (hasLockedBoundary(e)) continue;
      const pri = DETECTOR_PRIORITY[e.source] ?? 0;
      if (pri < maxPriority) {
        dropped.add(e);
        continue;
      }
      if (hasPerson && PERSON_PREFERRED_OVER.has(e.label)) {
        dropped.add(e);
        continue;
      }
      if (hasPreciseNonAddress && e.label === "address") {
        dropped.add(e);
      }
    }
  }
  if (dropped.size === 0) return entities;
  return entities.filter((e) => !dropped.has(e));
};

/** Strip leading/trailing whitespace and punctuation. */
export const sanitizeEntities = (entities: Entity[]): Entity[] =>
  entities.flatMap((e) => {
    if (hasLockedBoundary(e)) {
      return [e];
    }

    const strip = COLON_LABELS.has(e.label) ? /[\s,;]+/ : /[\s:,;]+/;
    // Also strip leading dots followed by whitespace —
    // artifact from trigger extraction after abbreviations
    // like "dat. nar." or "č.p." where the extraction
    // starts at the trailing dot of the abbreviation.
    const leadTrimmed = e.text
      .replace(/^(?:\.\s)+/, "")
      .replace(new RegExp(`^${strip.source}`, strip.flags), "");
    const lead = e.text.length - leadTrimmed.length;
    let cleaned = leadTrimmed.replace(
      new RegExp(`${strip.source}$`, strip.flags),
      "",
    );
    // Trailing-period strip for organization entities that
    // don't end in a legal-form abbreviation. Court trigger
    // captures often include the sentence terminator
    // ("Krajského soudu v Praze." → "Krajského soudu v Praze").
    // Exact deny-list and gazetteer spans are skipped — those
    // boundaries come from curated dictionaries and may legally
    // end in `.` (e.g. "U.S.C."); normalising them here would
    // leave the dot dangling outside the redaction.
    // For everything else, keep the period when it follows the
    // FULL detector vocabulary (data/legal-forms.json plus
    // `LEGAL_SUFFIXES`), not only the small propagation list,
    // so detected forms like "Acme Kft." or "Bank of America,
    // N.A." retain their final dot.
    if (
      e.label === "organization" &&
      cleaned.endsWith(".") &&
      !LITERAL_SOURCES.has(e.source)
    ) {
      const known = getKnownLegalSuffixes();
      const keepsPeriod = known.some((suffix) => cleaned.endsWith(suffix));
      if (!keepsPeriod) {
        cleaned = cleaned.slice(0, -1).trimEnd();
      }
    }
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
      continue;
    }

    const overlapStart = (() => {
      for (let j = merged.length - 1; j >= 0; j--) {
        const existing = merged[j];
        if (!existing || existing.end <= entity.start) {
          return j + 1;
        }
      }
      return 0;
    })();
    const overlaps = merged.slice(overlapStart);
    const hasPartialOverlap = overlaps.some(
      (existing) =>
        existing.start !== entity.start || existing.end !== entity.end,
    );

    if (!hasPartialOverlap) {
      const sameLabelIndex = overlaps.findIndex(
        (existing) => existing.label === entity.label,
      );
      if (sameLabelIndex === -1) {
        merged.push({ ...entity });
        continue;
      }

      const actualIndex = overlapStart + sameLabelIndex;
      const sameLabel = merged[actualIndex];
      if (sameLabel && shouldReplace(entity, sameLabel)) {
        merged[actualIndex] = { ...entity };
      }
      continue;
    }

    if (overlaps.every((existing) => shouldReplace(entity, existing))) {
      merged.splice(overlapStart, overlaps.length, { ...entity });
    }
  }

  return resolveSameSpanLabelConflicts(sanitizeEntities(merged));
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
    const mod = await import("./data/amount-words.json");
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
    if (e.label !== "monetary amount" || isCallerOwnedEntity(e)) {
      return e;
    }
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

const DEFAULT_CUSTOM_REGEX_SCORE = 0.9;

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

// MISC is intentionally a label without detection — only the
// custom deny-list path produces it. Asking the NER schema for
// MISC would invite zero-shot guesses that contradict that
// contract and cause over-redaction.
const NON_NER_LABELS: ReadonlySet<string> = new Set(["misc"]);

const getRequestedNerLabels = (
  config: PipelineConfig,
  expandForHotwords = false,
): readonly string[] => {
  const labels =
    config.labels.length > 0 ? config.labels : DEFAULT_ENTITY_LABELS;
  const expanded = expandForHotwords
    ? expandLabelsForHotwordRules(labels)
    : labels;
  return expanded.filter((label) => !NON_NER_LABELS.has(label));
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
  const customDenyFingerprint =
    config.enableDenyList && config.customDenyList
      ? config.customDenyList
          .map((entry) =>
            JSON.stringify({
              label: entry.label,
              value: entry.value,
              variants: [...(entry.variants ?? [])].sort(),
            }),
          )
          .sort()
          .join("\n")
      : "";
  const customRegexFingerprint =
    config.enableRegex && config.customRegexes
      ? config.customRegexes
          .map((entry) =>
            JSON.stringify({
              label: entry.label,
              pattern: entry.pattern,
              score: entry.score ?? DEFAULT_CUSTOM_REGEX_SCORE,
            }),
          )
          .sort()
          .join("\n")
      : "";
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
    `${config.enableRegex}:` +
    `${config.denyListCountries?.toSorted().join(",") ?? ""}:` +
    `${config.denyListRegions?.toSorted().join(",") ?? ""}:` +
    `${config.denyListExcludeCategories?.toSorted().join(",") ?? ""}:` +
    `${customDenyFingerprint}:` +
    `${customRegexFingerprint}:` +
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
      initAddressComponents(),
      warmAddressStopKeywords(),
      zoneInit,
      hotwordInit,
    ]);
  } else {
    await Promise.all([
      loadGenericRoles(ctx),
      initPrepositions(),
      initStreetAbbrevs(),
      initAddressComponents(),
      warmAddressStopKeywords(),
      hotwordInit,
    ]);
  }

  // When a pre-built search is provided, buildDenyList
  // was skipped for this context. Ensure stopwords,
  // allow list, and person stopwords are loaded so
  // processDenyListMatches filters correctly.
  if (cachedSearch && config.enableDenyList) {
    await ensureDenyListData(ctx, config.dictionaries);
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
  const { regexMatches, customRegexMatches, literalMatches } = runUnifiedSearch(
    search,
    fullText,
  );
  const { slices } = search;

  const rawRegexEntities = config.enableRegex
    ? processRegexMatches(
        regexMatches,
        slices.regex.start,
        slices.regex.end,
        search.regexMeta,
      )
    : [];
  const rawCustomRegexEntities = config.enableRegex
    ? processRegexMatches(
        customRegexMatches,
        slices.customRegex.start,
        slices.customRegex.end,
        search.customRegexMeta,
      )
    : [];
  const customRegexEntities = filterAllowedLabels(
    rawCustomRegexEntities,
    preHotwordAllowedLabels,
  );
  const regexEntities = filterAllowedLabels(
    [...rawRegexEntities, ...customRegexEntities],
    preHotwordAllowedLabels,
  );
  if (regexEntities.length > 0) log("regex", `${regexEntities.length} matches`);

  if (legalFormsEnabled) {
    // Populate the per-language legal-role-head cache so the
    // synchronous match processor below can read it. Cheap and
    // idempotent — only the first call kicks the loads.
    await warmLegalRoleHeads();
  }
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

  if (config.enableTriggerPhrases) {
    // Populate the address-stop-keywords cache so the
    // synchronous address strategy uses the merged
    // per-language list instead of the seed fallback.
    await warmAddressStopKeywords();
  }
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
    await initNameCorpus(ctx, config.dictionaries);
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

  const rawCustomDenyListEntities = rawDenyListEntities.filter((entity) =>
    isCallerOwnedEntity(entity),
  );
  const rawCuratedDenyListEntities = rawDenyListEntities.filter(
    (entity) => !isCallerOwnedEntity(entity),
  );
  const customDenyListEntities = filterAllowedLabels(
    rawCustomDenyListEntities,
    preHotwordAllowedLabels,
  );

  const ruleContextEntities = [
    ...rawTriggerEntities,
    ...rawRegexEntities,
    ...customRegexEntities,
    ...rawLegalFormEntities,
    ...rawNameCorpusEntities,
    ...rawCuratedDenyListEntities,
    ...customDenyListEntities,
    ...rawGazetteerEntities,
  ];
  const nerMaskEntities = [
    ...rawTriggerEntities,
    ...rawRegexEntities,
    ...customRegexEntities,
    ...rawLegalFormEntities,
    ...rawNameCorpusEntities,
    ...rawCuratedDenyListEntities,
    ...customDenyListEntities,
    ...rawGazetteerEntities,
  ];

  // NER (mask rule-detected spans so the model doesn't
  // produce contradictory boundaries for known entities)
  let rawNerEntities: Entity[] = [];
  let nerEntities: Entity[] = [];
  const requestedNerLabels = getRequestedNerLabels(config, hotwordsActive);
  if (config.enableNer && nerInference && requestedNerLabels.length > 0) {
    const maskResult = maskDetectedSpans(fullText, nerMaskEntities);
    log("ner", "running inference...");
    const rawNer = await nerInference(
      maskResult.maskedText,
      [...requestedNerLabels],
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
  const preBoostEntities = (() => {
    if (!hotwordsActive) {
      return zoneAdjusted;
    }
    const hotwordCandidates = zoneAdjusted.filter(
      (entity) => !isCallerOwnedEntity(entity),
    );
    const callerOwnedEntities = zoneAdjusted.filter(isCallerOwnedEntity);
    return [
      ...filterAllowedLabels(
        applyHotwordRules(hotwordCandidates, fullText),
        allowedLabels,
      ),
      ...callerOwnedEntities,
    ];
  })();

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
    const coreferenceSeeds = merged.filter(
      (entity) => !isCallerOwnedEntity(entity),
    );
    const terms = await extractDefinedTerms(fullText, coreferenceSeeds, ctx);
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
