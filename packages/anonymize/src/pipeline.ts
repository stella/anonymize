import {
  extractDefinedTerms,
  findCoreferenceSpans,
} from "./detectors/coreference";
import { processGazetteerMatches } from "./detectors/gazetteer";
import { processCountryMatches } from "./detectors/countries";
import { detectNameCorpus, initNameCorpus } from "./detectors/names";
import { detectSignatures } from "./detectors/signatures";
import { processRegexMatches } from "./detectors/regex";
import {
  getKnownLegalSuffixes,
  warmLegalRoleHeads,
} from "./detectors/legal-forms";
import { detectLegalFormsV2 } from "./detectors/legal-forms-v2";
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
  getStreetAbbrevs,
  detectOrphanStreetLines,
  initPrepositions,
  initStreetAbbrevs,
} from "./filters/confidence-boost";
import {
  filterFalsePositives,
  initAddressComponents,
  loadDocumentStructureHeadings,
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
  DETECTION_SOURCES,
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

const LITERAL_BOUNDARY_PUNCT_RE = /^["“„‟‘‛'«]|["”’'»!.]$/u;

// Bare postal-code shapes used by the address-containment rule.
// Covers Czech `160 00`, German/EU `12345`, US ZIP / ZIP+4
// (`94304`, `94304-1050`), and the standard `\d{3} \d{2}` /
// `\d{2}-\d{3}` continental variants. Surrounding whitespace
// is allowed so the trigger detector's trimmed span still matches.
const BARE_POSTAL_CODE_RE =
  /^\s*(?:\d{3}\s?\d{2}|\d{2}[-–]\d{3}|\d{5}(?:[-–]\d{3,4})?)\s*$/u;

const hasCuratedLiteralBoundary = (entity: Entity): boolean =>
  LITERAL_SOURCES.has(entity.source) &&
  entity.label !== "person" &&
  entity.sourceDetail !== "gazetteer-extension" &&
  LITERAL_BOUNDARY_PUNCT_RE.test(entity.text);

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

  // Postal-code inside a fuller address: when a longer same-label
  // address span fully contains a shorter span whose text is just
  // a bare postal code (Czech `160 00`, German `12345`, US `94304`
  // or `94304-1050`), the shorter span is a fragment of the same
  // data point. The longer span wins regardless of source priority.
  // Bare postal-code text without surrounding street/city evidence
  // is the only narrow case where containment beats the priority
  // comparison; field-label trims (\`… IČ\`, \`… oddíl\`) and other
  // address-vs-address comparisons stay on the standard path.
  if (
    a.label === "address" &&
    b.label === "address" &&
    a.start <= b.start &&
    a.end >= b.end &&
    aLen > bLen &&
    BARE_POSTAL_CODE_RE.test(b.text)
  ) {
    return true;
  }
  if (
    a.label === "address" &&
    b.label === "address" &&
    b.start <= a.start &&
    b.end >= a.end &&
    bLen > aLen &&
    BARE_POSTAL_CODE_RE.test(a.text)
  ) {
    return false;
  }

  // Legal-form containment: a v2 legal-form entity span anchors on
  // a suffix and grows back through CapWords + connectors, so its
  // length DOES reliably indicate accuracy. When such a span fully
  // contains a shorter same-label entity from a higher-priority
  // detector (typically a trigger reclassifying a city name like
  // `Prahy` inside `Technologie hlavního města Prahy, a. s.`), the
  // legal-form span wins regardless of source priority.
  if (
    a.label === b.label &&
    a.source === DETECTION_SOURCES.LEGAL_FORM &&
    a.start <= b.start &&
    a.end >= b.end &&
    aLen > bLen
  ) {
    return true;
  }
  if (
    a.label === b.label &&
    b.source === DETECTION_SOURCES.LEGAL_FORM &&
    b.start <= a.start &&
    b.end >= a.end &&
    bLen > aLen
  ) {
    return false;
  }

  // Same-start same-label longest-wins rule for shape-extending
  // detectors. For labels where the entity naturally extends to
  // include trailing context (a date that grows from `21.` to
  // `21. März 1968`, a monetary amount that grows from `273,-`
  // to `273,- Kč`), the longer span at the same offset is the
  // correct boundary regardless of which detector emitted it.
  // Without this rule the priority comparison below picks the
  // shorter-but-higher-priority trigger and discards the full
  // entity. The list is intentionally narrow — `address`,
  // `organization`, `person` keep the priority semantics
  // because their detectors don't have the same "trigger
  // captures a prefix, regex captures the whole shape"
  // relationship.
  const LONGEST_WINS_LABELS: ReadonlySet<string> = new Set([
    "date",
    "date of birth",
    "monetary amount",
    "phone number",
    "email address",
    "url",
  ]);
  if (
    a.label === b.label &&
    a.start === b.start &&
    aLen !== bLen &&
    LONGEST_WINS_LABELS.has(a.label)
  ) {
    return aLen > bLen;
  }

  // Cross-label containment for country: a country token
  // contained inside a longer person or organization span
  // is almost always a first-name collision ("Chad Smith",
  // "Georgia Smith", "Jordan Williams"). The longer span
  // carries more evidence — keep it and drop the country.
  if (
    a.label === "country" &&
    (b.label === "person" || b.label === "organization") &&
    b.start <= a.start &&
    b.end >= a.end &&
    bLen > aLen
  ) {
    return false;
  }
  if (
    b.label === "country" &&
    (a.label === "person" || a.label === "organization") &&
    a.start <= b.start &&
    a.end >= b.end &&
    aLen > bLen
  ) {
    return true;
  }

  const aPri = DETECTOR_PRIORITY[a.source] ?? 0;
  const bPri = DETECTOR_PRIORITY[b.source] ?? 0;
  if (aPri !== bPri) return aPri > bPri;
  return a.score > b.score || (a.score === b.score && aLen > bLen);
};

/** Labels where colons are structurally significant. */
const COLON_LABELS = new Set(["ip address", "mac address"]);

/**
 * Labels whose entities should have a trailing sentence
 * `.` stripped during sanitisation. Restricted to
 * proper-noun-style labels where a final period is
 * almost always the sentence terminator that ran into
 * the capture, not a structural part of the value.
 * Numeric labels (`date`, `date of birth`, `phone
 * number`, `monetary amount`, `time`) and `person`
 * stay out — German writes `21. März`, post-nominal
 * degrees write `M.Sc.`, times write `5:00 p.m.`, and
 * stripping the dot would corrupt those spans.
 */
const PERIOD_STRIPPED_LABELS: ReadonlySet<string> = new Set([
  "organization",
  "location",
  "address",
]);
const ADDRESS_FINAL_TOKEN_RE = /(?:^|[\s,])([\p{L}\p{M}.]+\.)$/u;
const LOCATION_FINAL_DOTTED_ABBREV_RE = /(?:^|[\s,])(?:\p{Lu}\.){2,}$/u;

const hasKnownAddressFinalAbbrev = (text: string): boolean => {
  const finalToken = ADDRESS_FINAL_TOKEN_RE.exec(text)?.[1];
  if (!finalToken) {
    return false;
  }
  return getStreetAbbrevs().has(finalToken.toLowerCase());
};

const hasLocationFinalAbbrev = (text: string): boolean =>
  LOCATION_FINAL_DOTTED_ABBREV_RE.test(text);

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
 *
 * `country` is included because the country detector runs at the
 * same offsets as deny-list person matches for names like `Chad`,
 * `Georgia`, `Jordan` (all valid first names AND country names).
 * Letting a higher-priority country span win there would mark
 * `Chad Smith` as country + leave `Smith` unredacted.
 */
const PERSON_PREFERRED_OVER: ReadonlySet<string> = new Set([
  "address",
  "country",
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

    // Person-preferred drops are decided up front so the
    // priority-based pass below doesn't keep a higher-pri country
    // span (e.g., `Chad` from the country detector at priority 3)
    // while also dropping the lower-pri person hit (`Chad` from
    // the deny-list at priority 2) for being below the same group's
    // max. Without this, person tokens that happen to be country
    // names would be flipped to `country` and the surrounding
    // surname left exposed.
    const yieldingToPerson = new Set<Entity>();
    if (hasPerson) {
      for (const e of group) {
        if (hasLockedBoundary(e)) continue;
        if (PERSON_PREFERRED_OVER.has(e.label)) {
          yieldingToPerson.add(e);
        }
      }
    }

    // When entities at the same offsets have different labels,
    // also let detector priority break ties: a `legal-form`
    // organization hit (priority 3) should keep its label over a
    // coincident `deny-list` person hit (priority 2). Compute the
    // max priority over entities NOT already yielding to person,
    // so the person hit isn't accidentally crowded out by the
    // priority of the very entity it's beating.
    let maxPriority = -1;
    for (const e of group) {
      if (hasLockedBoundary(e)) continue;
      if (yieldingToPerson.has(e)) continue;
      const pri = DETECTOR_PRIORITY[e.source] ?? 0;
      if (pri > maxPriority) maxPriority = pri;
    }

    for (const e of group) {
      // Caller-owned spans (custom deny-list / custom regex) carry
      // explicit user intent; never drop them in favour of a
      // detector-generated label.
      if (hasLockedBoundary(e)) continue;
      if (yieldingToPerson.has(e)) {
        dropped.add(e);
        continue;
      }
      const pri = DETECTOR_PRIORITY[e.source] ?? 0;
      if (pri < maxPriority) {
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

/**
 * Trailing typographic punctuation that detectors
 * occasionally swallow when a capture runs to the end
 * of a sentence or quoted phrase. Stripped from every
 * non-literal, non-locked entity. Curated dictionary and
 * gazetteer entries with punctuation that is clearly part of
 * the literal (`Hello bank!`, `"Juez y parte"`) keep their
 * own boundaries. Generated/extended spans from the same
 * sources still pass through cleanup so dangling punctuation
 * does not become part of the redaction
 * (e.g. `Bond Hedge Documentation"` →
 * `Bond Hedge Documentation`).
 *
 * `)` is deliberately omitted — monetary amounts are
 * extended to include trailing "(slovy ...)" / "(in
 * words ...)" parentheticals where the closing paren
 * is structural, and stripping it would leave the open
 * paren dangling. `.` is also omitted because the
 * trailing-period rule below has label-aware handling
 * (legal-form abbreviations keep their dot).
 */
const TRAILING_PUNCT_CLASS = `["“”‘’'»!?]`;

/**
 * Leading typographic punctuation that detectors
 * occasionally swallow when a capture starts at an
 * opening quote. `(` is deliberately omitted — it is
 * almost always the opening of a structural
 * parenthetical (registration number group, monetary
 * "(slovy ...)" extension) that the detector
 * intentionally captured.
 */
const LEADING_PUNCT_CLASS = `["“”‘’'«¿¡]`;
const LEADING_ELLIPSIS_RE = /^(?:\.{2,}|…+)/u;
const ELLIPSIS_PREFIX_LABELS: ReadonlySet<string> = new Set([
  "date",
  "date of birth",
  "monetary amount",
  "phone number",
  "email address",
  "url",
  "time",
]);
const STRIP_BY_LABEL = {
  colon: /[\s,;]+/,
  default: /[\s:,;]+/,
} as const;
const LEADING_TRIM_BY_LABEL = {
  colon: new RegExp(
    `^(?:\\.\\s|${STRIP_BY_LABEL.colon.source}|${LEADING_PUNCT_CLASS})+`,
  ),
  default: new RegExp(
    `^(?:\\.\\s|${STRIP_BY_LABEL.default.source}|${LEADING_PUNCT_CLASS})+`,
  ),
} as const;
const TRAILING_TRIM_BY_LABEL = {
  colon: new RegExp(
    `(?:${STRIP_BY_LABEL.colon.source}|${TRAILING_PUNCT_CLASS})+$`,
  ),
  default: new RegExp(
    `(?:${STRIP_BY_LABEL.default.source}|${TRAILING_PUNCT_CLASS})+$`,
  ),
} as const;

/** Strip leading/trailing whitespace and punctuation. */
export const sanitizeEntities = (entities: Entity[]): Entity[] =>
  entities.flatMap((e) => {
    if (hasLockedBoundary(e) || hasCuratedLiteralBoundary(e)) {
      return [e];
    }

    const stripKind = COLON_LABELS.has(e.label) ? "colon" : "default";
    // Also strip leading dots followed by whitespace —
    // artifact from trigger extraction after abbreviations
    // like "dat. nar." or "č.p." where the extraction
    // starts at the trailing dot of the abbreviation.
    // The typographic-punctuation passes run in a loop
    // alongside the whitespace strip so combinations like
    // `"Some Org",` or ` "Name" ` collapse cleanly.
    const leadRe = LEADING_TRIM_BY_LABEL[stripKind];
    const trailRe = TRAILING_TRIM_BY_LABEL[stripKind];
    // Sentence-tail ellipsis: a date or other shape-extending
    // entity that sits at the end of a clause sometimes gets
    // captured with the preceding `...` / `…` run still attached
    // (`V Praze, dne ...2. 2. 2026` → `...2. 2. 2026`). The
    // generic punctuation strip below doesn't touch them because
    // the trailing dots aren't followed by whitespace. Strip the
    // run explicitly for the labels that have this shape — numeric
    // values where leading punctuation is never structurally part
    // of the entity.
    const ellipsisStripped = ELLIPSIS_PREFIX_LABELS.has(e.label)
      ? e.text.replace(LEADING_ELLIPSIS_RE, "")
      : e.text;
    const leadTrimmed = ellipsisStripped.replace(leadRe, "");
    const lead = e.text.length - leadTrimmed.length;
    let cleaned = leadTrimmed.replace(trailRe, "");
    // Trailing-period strip for proper-noun labels that
    // don't end in a legal-form abbreviation. Trigger
    // and NER captures often include the sentence
    // terminator
    // ("Krajského soudu v Praze." → "Krajského soudu v Praze",
    // "State of Delaware." → "State of Delaware").
    // Numeric labels (`date`, `phone number`, `monetary
    // amount`, `time`, etc.) and the `person` label keep
    // their trailing period — German dates write `21.`,
    // post-nominals write `M.Sc.`, times write `p.m.`,
    // all of which are structurally significant.
    // Literal deny-list and gazetteer spans whose
    // punctuation is part of the dictionary entry are
    // skipped above. For everything else, keep the period
    // when it follows the FULL detector vocabulary
    // (data/legal-forms.json plus `LEGAL_SUFFIXES`), not
    // only the small propagation list, so detected forms
    // like "Acme Kft." or "Bank of America, N.A." retain
    // their final dot.
    if (
      PERIOD_STRIPPED_LABELS.has(e.label) &&
      cleaned.endsWith(".") &&
      !LITERAL_SOURCES.has(e.source)
    ) {
      const known = getKnownLegalSuffixes();
      const keepsPeriod =
        known.some((suffix) => cleaned.endsWith(suffix)) ||
        (e.label === "address" && hasKnownAddressFinalAbbrev(cleaned)) ||
        (e.label === "location" && hasLocationFinalAbbrev(cleaned));
      if (!keepsPeriod) {
        cleaned = cleaned.slice(0, -1).trimEnd();
      }
    }
    // After the period strip, re-run the trailing-punctuation
    // pass in case the period sat between the entity and
    // already-stripped quotes/parens (e.g., `Foo."` →
    // `Foo.` → `Foo`).
    cleaned = cleaned.replace(trailRe, "");
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
    const last = merged.at(-1);
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

let monetaryTrailingCurrencyRe: RegExp | null = null;
let monetaryTrailingCurrencyLoaded = false;

type CurrenciesData = {
  codes?: string[];
  symbols?: string[];
  localNames?: string[];
};

const getMonetaryTrailingCurrencyRe = async (): Promise<RegExp | null> => {
  if (monetaryTrailingCurrencyLoaded) return monetaryTrailingCurrencyRe;
  try {
    const mod = await import("./data/currencies.json");
    const data: CurrenciesData = mod.default ?? mod;
    const codes = (data.codes ?? []).filter((c) => /^[A-Z]{2,4}$/.test(c));
    const names = (data.localNames ?? []).filter((n) => n.length > 0);
    const parts: string[] = [];
    if (names.length > 0) {
      parts.push(names.map(escapeRegex).join("|"));
    }
    if (codes.length > 0) {
      parts.push(codes.map(escapeRegex).join("|"));
    }
    if (parts.length === 0) {
      monetaryTrailingCurrencyRe = null;
    } else {
      const alt = parts.join("|");
      monetaryTrailingCurrencyRe = new RegExp(
        `^([^\\S\\n\\t]{0,4})(${alt})(?![\\p{L}\\p{N}])`,
        "u",
      );
    }
  } catch {
    monetaryTrailingCurrencyRe = null;
  }
  monetaryTrailingCurrencyLoaded = true;
  return monetaryTrailingCurrencyRe;
};

// Extend a monetary-amount entity to include a trailing currency
// code/name when one sits within a short whitespace gap after the
// captured span (`273,-` followed by `   Kč`, `1 000` followed by
// ` CZK`). The unified regex backend occasionally drops the longer
// currency pattern in favour of a shorter NUM-only match depending
// on Rust regex DFA construction order; this post-process pass
// re-attaches the suffix from \`currencies.json\` so the boundary
// is the same regardless of which match resolved.
const extendMonetaryTrailingCurrency = (
  entities: Entity[],
  fullText: string,
  re: RegExp | null,
): Entity[] => {
  if (!re) return entities;
  return entities.map((e) => {
    if (e.label !== "monetary amount" || isCallerOwnedEntity(e)) return e;
    if (/\p{L}/u.test(e.text.slice(-1) ?? "")) return e;
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
};

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
    `${config.nameCorpusLanguages?.toSorted().join(",") ?? ""}:` +
    `${config.enableRegex}:` +
    `${config.labels.toSorted().join(",")}:` +
    `${config.denyListCountries?.toSorted().join(",") ?? ""}:` +
    `${config.denyListRegions?.toSorted().join(",") ?? ""}:` +
    `${config.denyListExcludeCategories?.toSorted().join(",") ?? ""}:` +
    `${customDenyFingerprint}:` +
    `${customRegexFingerprint}:` +
    `${config.enableGazetteer}:${gazFingerprint}:` +
    `${config.enableCountries !== false}`
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

export type PipelineSearchOptions = {
  config: PipelineConfig;
  gazetteerEntries?: GazetteerEntry[];
  context?: PipelineContext;
};

/**
 * Pre-build and cache the unified search instance for a
 * pipeline configuration. Use the same context in
 * `runPipeline` to reuse the prepared automata without
 * passing `cachedSearch` around manually.
 */
export const preparePipelineSearch = ({
  config,
  gazetteerEntries = [],
  context,
}: PipelineSearchOptions): Promise<UnifiedSearchInstance> =>
  getCachedSearch(config, gazetteerEntries, context ?? defaultContext);

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
      loadDocumentStructureHeadings(),
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
      loadDocumentStructureHeadings(),
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
    await ensureDenyListData(
      ctx,
      config.dictionaries,
      config.nameCorpusLanguages,
    );
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
  const searchConfig = hotwordsActive
    ? {
        ...config,
        labels: [...expandLabelsForHotwordRules(config.labels)],
      }
    : config;

  const search =
    cachedSearch ??
    (await getCachedSearch(searchConfig, gazetteerEntries, ctx));

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

  if (legalFormsEnabled || config.enableTriggerPhrases) {
    // Populate the per-language legal-role-head cache so the
    // synchronous match processor below can read it. Cheap and
    // idempotent — only the first call kicks the loads.
    // Triggers also need this: the trigger reclassification step
    // (person → organization when the captured text contains a
    // legal-form suffix) reads `getKnownLegalSuffixes()`, which
    // falls back to the seed list until the cache is warmed.
    await warmLegalRoleHeads();
  }
  const rawLegalFormEntities = legalFormsEnabled
    ? detectLegalFormsV2(fullText)
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

  // Signature-block recognition. Always on: the
  // anchors ("/s/", "Name:", "By:", "IN WITNESS
  // WHEREOF") are unambiguous legal-document markers
  // and produce no matches in unrelated prose.
  const rawSignatureEntities = detectSignatures(fullText, ctx);
  const signatureEntities = filterAllowedLabels(
    rawSignatureEntities,
    preHotwordAllowedLabels,
  );
  if (signatureEntities.length > 0)
    log("signatures", `${signatureEntities.length} matches`);

  checkAbort(signal);

  let rawNameCorpusEntities: Entity[] = [];
  let nameCorpusEntities: Entity[] = [];
  if (config.enableNameCorpus && !config.enableDenyList) {
    await initNameCorpus(ctx, config.dictionaries, config.nameCorpusLanguages);
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

  const rawCountryEntities = search.countryData
    ? processCountryMatches(
        literalMatches,
        slices.countries.start,
        slices.countries.end,
        fullText,
        search.countryData,
      )
    : [];
  const countryEntities = filterAllowedLabels(
    rawCountryEntities,
    preHotwordAllowedLabels,
  );
  if (countryEntities.length > 0)
    log("countries", `${countryEntities.length} matches`);

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
    ...signatureEntities,
    ...regexEntities,
    ...legalFormEntities,
    ...nameCorpusEntities,
    ...denyListEntities,
    ...gazetteerEntities,
    ...countryEntities,
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
  const monetaryAmountWordsRe = await getAmountWordsRe();
  const monetaryTrailingRe = await getMonetaryTrailingCurrencyRe();
  const mergedWithCurrency = extendMonetaryTrailingCurrency(
    rawMerged,
    fullText,
    monetaryTrailingRe,
  );
  const mergedExtended = extendMonetaryAmountWords(
    mergedWithCurrency,
    fullText,
    monetaryAmountWordsRe,
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
    // Coreference's alias filter rejects parenthetical
    // captures that are nothing but a legal-form suffix
    // ("(« SAS »)"), which needs the full vocabulary from
    // `data/legal-forms.json`. Warm it here so configs
    // that enable coreference without legal-form detection
    // still see the complete suffix set.
    if (!legalFormsEnabled) {
      await warmLegalRoleHeads();
    }
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
