import type { Entity } from "../types";

// Common Czech words that start uppercase at sentence
// beginnings but are not street names. Module-level
// to avoid allocation in a hot loop.
const BARE_STOPWORDS = new Set([
  "Příloha",
  "Smlouva",
  "Článek",
  "Dodatek",
  "Celkem",
  "Strana",
  "Faktura",
  "Částka",
  "Položka",
  "Kapitola",
  "Zákon",
  "Vyhláška",
  "Nařízení",
  "Usnesení",
  "Rozsudek",
  "Bod",
  "Odstavec",
  "Záloha",
  "Zbývá",
  "Dne",
  "Platba",
  "Datum",
  "Splatnost",
  "Variabilní",
  "Konstantní",
  "Specifický",
]);

const NEAR_MISS_BAND = 0.15;
const BOOST_PER_NEIGHBOUR = 0.05;
const CONTEXT_WINDOW_CHARS = 150;
const HIGH_CONFIDENCE_FLOOR = 0.9;

/**
 * Boost confidence of near-miss NER entities that appear
 * near high-confidence detections (regex, trigger phrase).
 *
 * If an NER entity scored between (threshold - 0.15) and
 * threshold, count how many confirmed entities exist within
 * a 150-char window. Add +0.05 per co-located entity.
 * If the boosted score crosses the threshold, include it.
 *
 * Only mutates score on near-miss entities; high-confidence
 * entities pass through unchanged.
 */
export const boostNearMissEntities = (
  entities: Entity[],
  threshold: number,
): Entity[] => {
  const nearMissBand = Math.max(0, threshold - NEAR_MISS_BAND);
  const confirmed = entities.filter((e) => e.score >= HIGH_CONFIDENCE_FLOOR);

  const boosted: Entity[] = [];

  for (const entity of entities) {
    if (entity.score >= threshold) {
      boosted.push(entity);
      continue;
    }

    if (entity.score < nearMissBand) {
      continue;
    }

    const midpoint = (entity.start + entity.end) / 2;
    let neighbourCount = 0;

    for (const anchor of confirmed) {
      const anchorMid = (anchor.start + anchor.end) / 2;
      if (Math.abs(midpoint - anchorMid) <= CONTEXT_WINDOW_CHARS) {
        neighbourCount++;
      }
    }

    const boostedScore = entity.score + neighbourCount * BOOST_PER_NEIGHBOUR;

    if (boostedScore >= threshold) {
      boosted.push({ ...entity, score: boostedScore });
    }
  }

  return boosted;
};

// ── Address backward scan ────────────────────────────

const UPPER_WORD_RE = /\p{Lu}/u;

/** Header zone: top 15% of document */
const HEADER_ZONE_FRACTION = 0.15;

/** Context window for address adjacency */
const STREET_CONTEXT_WINDOW = 200;

// ── Preposition data (lazy-loaded from JSON) ────────

type PrepositionData = {
  address: Record<string, string[] | string>;
  temporal: Record<string, string[] | string>;
};

let _addressPreps: ReadonlySet<string> | null = null;
let _temporalPreps: ReadonlySet<string> | null = null;
let _prepsPromise: Promise<void> | null = null;

const loadPrepositions = async (): Promise<void> => {
  try {
    const mod = await import(
      "@stll/anonymize-data/config/address-prepositions.json"
    );
    const data: PrepositionData = mod.default ?? mod;
    // Merge all languages into flat sets
    const addr = new Set<string>();
    const temp = new Set<string>();
    for (const words of Object.values(data.address)) {
      if (Array.isArray(words)) {
        for (const w of words) addr.add(w.toLowerCase());
      }
    }
    for (const words of Object.values(data.temporal)) {
      if (Array.isArray(words)) {
        for (const w of words) temp.add(w.toLowerCase());
      }
    }
    _addressPreps = addr;
    _temporalPreps = temp;
  } catch {
    _addressPreps = new Set();
    _temporalPreps = new Set();
  }
};

/** Ensure preposition data is loaded. */
export const initPrepositions =
  (): Promise<void> => {
    if (!_prepsPromise) {
      _prepsPromise = loadPrepositions();
    }
    return _prepsPromise;
  };

const getAddressPreps = (): ReadonlySet<string> =>
  _addressPreps ?? new Set();

const getTemporalPreps = (): ReadonlySet<string> =>
  _temporalPreps ?? new Set();

// ── Street type abbreviations (lazy-loaded) ─────────

let _streetAbbrevs: ReadonlySet<string> | null = null;
let _streetAbbrevsPromise: Promise<void> | null = null;

const loadStreetAbbrevs = async (): Promise<void> => {
  try {
    const mod = await import(
      "@stll/anonymize-data/config/address-street-types.json"
    );
    const data: Record<string, string[] | string> =
      mod.default ?? mod;
    const abbrevs = new Set<string>();
    for (const [key, words] of Object.entries(data)) {
      if (key.startsWith("_")) continue;
      if (!Array.isArray(words)) continue;
      for (const w of words) {
        // Only keep abbreviated forms (with dots)
        if (w.includes(".")) {
          abbrevs.add(w.toLowerCase());
        }
      }
    }
    _streetAbbrevs = abbrevs;
  } catch {
    _streetAbbrevs = new Set();
  }
};

/** Ensure street abbreviation data is loaded. */
export const initStreetAbbrevs =
  (): Promise<void> => {
    if (!_streetAbbrevsPromise) {
      _streetAbbrevsPromise = loadStreetAbbrevs();
    }
    return _streetAbbrevsPromise;
  };

const getStreetAbbrevs = (): ReadonlySet<string> =>
  _streetAbbrevs ?? new Set();

/**
 * Scan backwards from known address entities and
 * house number patterns to find street names.
 *
 * Strategy (a): from a house number like "2512/2a",
 * walk left to find the first uppercase word — that's
 * the street name start. "Mezi úvozy 2512/2a" →
 * captures "Mezi úvozy 2512/2a".
 *
 * Strategy (b): if a colon ":" appears within 3 chars
 * before the street start, boost confidence. Colons
 * signal "label: value" pairs universal in contracts.
 *
 * Strategy (c): in the header zone (top 15% of doc),
 * be more aggressive — detect street patterns even
 * without nearby address entities.
 */
export const detectStreetPatternsNearAddresses = (
  fullText: string,
  existingEntities: Entity[],
): Entity[] => {
  const results: Entity[] = [];
  const addressEntities = existingEntities.filter(
    (e) => e.label === "address",
  );
  const headerEnd = Math.floor(
    fullText.length * HEADER_ZONE_FRACTION,
  );

  // Find all house number positions in the text.
  // Slash-style house numbers only: either with a letter
  // suffix ("2512/2a") or primary >= 100 ("853/12").
  // This excludes date-like patterns ("31/12", "1/1").
  // Require either a letter suffix (2512/2a) or a
  // primary part > 31 to avoid matching Czech slash
  // dates like "31/12" or "1/1". Slash house numbers
  // in Czech addresses almost always have primary > 99
  // or carry a letter suffix.
  const houseNumRe =
    /\b(?:\d{1,4}\/\d+[a-zA-Z]\b|\d{3,4}\/\d+\b|(?:1[3-9]|[2-9]\d)\/\d{3,}\b)/g;
  houseNumRe.lastIndex = 0;

  for (
    let m = houseNumRe.exec(fullText);
    m !== null;
    m = houseNumRe.exec(fullText)
  ) {
    const numStart = m.index;
    const numEnd = numStart + m[0].length;

    // Skip if already covered by an existing entity
    if (
      existingEntities.some(
        (e) => e.start <= numStart && e.end >= numEnd,
      )
    ) {
      continue;
    }

    // Is this near a known address entity OR in header?
    const inHeader = numStart < headerEnd;
    const nearAddress = addressEntities.some(
      (e) =>
        Math.abs(e.start - numEnd) <
          STREET_CONTEXT_WINDOW ||
        Math.abs(e.end - numStart) <
          STREET_CONTEXT_WINDOW,
    );

    if (!inHeader && !nearAddress) {
      continue;
    }

    // Backward scan: find street name before the
    // house number. Walk left over whitespace, then
    // collect words that start with uppercase.
    let scanPos = numStart - 1;

    // Skip whitespace before the number (including
    // non-breaking spaces from PDF extraction)
    while (
      scanPos >= 0 &&
      /[\s\u00A0]/.test(fullText[scanPos] ?? "")
    ) {
      scanPos--;
    }

    if (scanPos < 0) {
      continue;
    }

    // Track if any temporal preposition was passed
    // through during the scan (e.g., "do", "od").
    // If so, the result is likely a date expression
    // even if wordCount > 1 ("Praha do 225/1").
    let hasTemporalPrep = false;

    // Collect words backwards until we hit:
    // - a non-letter character (except space/dot)
    // - a newline
    // - start of text
    // - a lowercase-only word (not a street name)
    let streetStart = scanPos + 1;
    let wordCount = 0;
    const MAX_WORDS = 5;

    while (scanPos >= 0 && wordCount < MAX_WORDS) {
      // Find end of current word. If we're on a dot,
      // include it (street abbreviations: "ul.", "nám.")
      let wordEnd = scanPos + 1;
      const hasDot = fullText[scanPos] === ".";
      if (hasDot) {
        scanPos--;
      }

      // Walk back through word chars
      while (
        scanPos >= 0 &&
        /[\p{L}\p{M}]/u.test(
          fullText[scanPos] ?? "",
        )
      ) {
        scanPos--;
      }
      const wordStart = scanPos + 1;
      const rawWord = fullText.slice(
        wordStart,
        wordEnd,
      );
      // Strip trailing dot for word checks
      const word = hasDot
        ? rawWord.slice(0, -1)
        : rawWord;

      if (word.length === 0) {
        break;
      }

      // Check if this is a known street abbreviation
      // (e.g., "ul.", "nám.", "tř.", "nábř.")
      const isStreetAbbrev =
        hasDot &&
        getStreetAbbrevs().has(rawWord.toLowerCase());

      // Word must start with uppercase (street name),
      // be a known preposition, a street abbreviation,
      // or a digit-starting token (e.g., "28." in
      // "28. října 1168/102").
      const isUpper = UPPER_WORD_RE.test(
        word[0] ?? "",
      );
      const isPrep = getAddressPreps().has(
        word.toLowerCase(),
      );
      const isDigitToken = /^\d/.test(word);

      if (
        !isUpper &&
        !isPrep &&
        !isStreetAbbrev &&
        !isDigitToken
      ) {
        break;
      }

      // Track temporal prepositions passed through
      if (
        isPrep &&
        getTemporalPreps().has(word.toLowerCase())
      ) {
        hasTemporalPrep = true;
      }

      streetStart = wordStart;
      wordCount++;

      // Skip whitespace before this word (inc. NBSP)
      while (
        scanPos >= 0 &&
        /[\s\u00A0]/.test(fullText[scanPos] ?? "")
      ) {
        scanPos--;
      }

      // Stop at newline, tab, comma, semicolon
      const prevCh = fullText[scanPos];
      if (
        prevCh === "\n" ||
        prevCh === "\t" ||
        prevCh === ";" ||
        prevCh === undefined
      ) {
        break;
      }

      // Comma: stop (it separates address from
      // previous clause)
      if (prevCh === ",") {
        break;
      }
    }

    if (wordCount === 0) {
      continue;
    }

    const streetText = fullText.slice(
      streetStart,
      numEnd,
    );

    // Skip if too short (single digit without name)
    if (streetText.length < 4) {
      continue;
    }

    // Guard: reject if any temporal preposition was
    // encountered during the backward scan. Catches
    // both "do 225/1" (wordCount=1) and "Praha do
    // 225/1" (wordCount=2).
    if (hasTemporalPrep) {
      continue;
    }

    // Skip if already covered
    if (
      existingEntities.some(
        (e) =>
          e.start <= streetStart && e.end >= numEnd,
      )
    ) {
      continue;
    }

    // Colon boost: if ":" appears within 5 chars
    // before street start, this is a "label: value"
    // pair — very high confidence.
    const beforeStreet = fullText.slice(
      Math.max(0, streetStart - 5),
      streetStart,
    );
    const hasColon = beforeStreet.includes(":");
    const score = hasColon ? 0.95 : inHeader ? 0.85 : 0.8;

    results.push({
      start: streetStart,
      end: numEnd,
      label: "address",
      text: streetText,
      score,
      source: "regex",
    });
  }

  // ── Second scan: bare house numbers near addresses ─
  // "Vinohradská 46" near "Praha 2" → address.
  // Uppercase word + space + 1-3 digit number, no slash.
  // Capped at 3 digits to exclude year numbers (2024).
  const bareHouseRe =
    /(?<=\s|^)(\p{Lu}\p{Ll}[\p{Ll}\p{Lu}]+\s+\d{1,3})\b/gu;
  bareHouseRe.lastIndex = 0;

  // Merge existing + newly found entities for proximity
  const allAddr = [
    ...addressEntities,
    ...results,
  ];

  for (
    let m = bareHouseRe.exec(fullText);
    m !== null;
    m = bareHouseRe.exec(fullText)
  ) {
    const captured = m[1];
    if (captured === undefined) continue;

    const start = m.index;
    const end = start + captured.length;

    // Must be on the same line as a confirmed address
    // entity and within 50 chars.
    const nearAddr = allAddr.some((e) => {
      const dist = Math.min(
        Math.abs(e.start - end),
        Math.abs(e.end - start),
      );
      if (dist > 50) return false;
      // Ensure same line: no newline between
      const lo = Math.min(e.start, start);
      const hi = Math.max(e.end, end);
      const between = fullText.slice(lo, hi);
      return !between.includes("\n");
    });

    if (!nearAddr) continue;

    // Extract the uppercase word to check stopwords
    const spaceIdx = captured.search(/\s+\d/);
    const word =
      spaceIdx > 0
        ? captured.slice(0, spaceIdx)
        : captured;

    if (BARE_STOPWORDS.has(word)) continue;

    // Skip if overlapping an existing entity
    const allEntities = [
      ...existingEntities,
      ...results,
    ];
    const overlaps = allEntities.some(
      (e) => e.start < end && e.end > start,
    );
    if (overlaps) continue;

    results.push({
      start,
      end,
      label: "address",
      text: captured,
      score: 0.75,
      source: "regex",
    });
  }

  return results;
};

// ── Orphan street lines in header zone ──────────────

// Orphan street: first word uppercase, subsequent words
// can be lowercase (Czech: "Karlínské náměstí 7",
// "Pražská ulice 12") or uppercase ("Národní třída 1").
// House number requires 2+ digits to avoid matching
// contract headings like "Příloha 1" or "Smlouva 3".
const ORPHAN_STREET_RE =
  /^\s*(\p{Lu}[\p{Ll}\p{Lu}]+(?:\s+[\p{Lu}\p{Ll}][\p{Ll}]+)*\s+\d{2,4}[a-zA-Z]?)\s*$/gmu;

/**
 * In the header zone (top 15%), find standalone lines
 * matching "[Uppercase word(s)] [number]" that sit
 * between other detected entities. These are almost
 * certainly street addresses in party definitions.
 *
 * Example: "Evropská 710" on its own line between
 * an organization entity and a postal code entity.
 */
export const detectOrphanStreetLines = (
  fullText: string,
  existingEntities: Entity[],
): Entity[] => {
  const headerEnd = Math.floor(
    fullText.length * HEADER_ZONE_FRACTION,
  );
  const results: Entity[] = [];
  ORPHAN_STREET_RE.lastIndex = 0;

  for (
    let m = ORPHAN_STREET_RE.exec(fullText);
    m !== null;
    m = ORPHAN_STREET_RE.exec(fullText)
  ) {
    const captured = m[1];
    if (captured === undefined) {
      continue;
    }
    const start = m.index + m[0].indexOf(captured);
    const end = start + captured.length;

    // Only in header zone
    if (start >= headerEnd) {
      continue;
    }

    // Skip if already covered
    if (
      existingEntities.some(
        (e) => e.start <= start && e.end >= end,
      )
    ) {
      continue;
    }

    // Must have a nearby entity (within 200 chars)
    const hasContext = existingEntities.some(
      (e) =>
        Math.abs(e.start - end) < 200 ||
        Math.abs(e.end - start) < 200,
    );
    if (!hasContext) {
      continue;
    }

    results.push({
      start,
      end,
      label: "address",
      text: captured,
      score: 0.85,
      source: "regex",
    });
  }

  return results;
};
