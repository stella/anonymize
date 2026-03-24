import type { Entity } from "../types";

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

/**
 * House number pattern: digits, optionally with
 * orientation number (/digits) and letter suffix.
 * Examples: "42", "2512/2a", "1033/7", "799/37"
 */
const HOUSE_NUM_RE =
  /\d+(?:\/\d+[a-zA-Z]?)?/;

const UPPER_WORD_RE = /\p{Lu}/u;

/** Header zone: top 15% of document */
const HEADER_ZONE_FRACTION = 0.15;

/** Context window for address adjacency */
const STREET_CONTEXT_WINDOW = 200;

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

  // Find all house number positions in the text
  // House numbers: digits with a slash are definitive
  // ("2512/2a", "853/12"). Standalone digits before
  // comma are only accepted if preceded by a word that
  // is NOT a legal section term (Article, Section, §).
  // This prevents "Article 14," or "bod 5," from
  // being misclassified as addresses.
  const houseNumRe =
    /\b\d{1,4}\/\d+[a-zA-Z]?\b/g;
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

    // Skip whitespace before the number
    while (
      scanPos >= 0 &&
      fullText[scanPos] === " "
    ) {
      scanPos--;
    }

    if (scanPos < 0) {
      continue;
    }

    // Collect words backwards until we hit:
    // - a non-letter character (except space)
    // - a newline
    // - start of text
    // - a lowercase-only word (not a street name)
    let streetStart = scanPos + 1;
    let wordCount = 0;
    const MAX_WORDS = 5;

    while (scanPos >= 0 && wordCount < MAX_WORDS) {
      // Find end of current word
      const wordEnd = scanPos + 1;

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
      const word = fullText.slice(wordStart, wordEnd);

      if (word.length === 0) {
        break;
      }

      // Word must start with uppercase (street name)
      // OR be a known preposition (nad, pod, u, na)
      const isUpper = UPPER_WORD_RE.test(
        word[0] ?? "",
      );
      const isPrep =
        /^(?:nad|pod|u|na|ve|ke|za|při|do|od)$/i.test(
          word,
        );

      if (!isUpper && !isPrep) {
        break;
      }

      streetStart = wordStart;
      wordCount++;

      // Skip whitespace before this word
      while (
        scanPos >= 0 &&
        fullText[scanPos] === " "
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

  return results;
};

// ── Orphan street lines in header zone ──────────────

const ORPHAN_STREET_RE =
  /^\s*(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)*\s+\d{1,4}[a-zA-Z]?)\s*$/gmu;

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
