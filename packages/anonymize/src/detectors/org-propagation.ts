import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";
import { LEGAL_SUFFIXES } from "../config/legal-forms";
import { isCallerOwnedEntity } from "../util/entity-source";

const TRAILING_SEP = /[,\s]+$/;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const ORG_PROPAGATION_SCORE = 0.9;
// Common determiners that prefix a defined-term shorthand for
// the originating company in mid-document references. After
// declaring `Acme s.r.o.` (or `Acme Corp.`) we treat
// "Společnost Acme", "Společnosti Acme" (Czech declensions),
// "the Company Acme", or "die Gesellschaft Acme" as the same
// organisation and extend the highlighted span to cover them.
// Match is case-insensitive and word-bounded.
const ORG_DETERMINER_RE =
  /(?<![\p{L}\p{N}])(společnost(?:i|í|em|u)?|spolecnost(?:i|em|u)?|the\s+(?:company|corporation|firm)|die\s+(?:gesellschaft|firma)|la\s+(?:société|empresa|sociedad)|el\s+(?:empresa|sociedad))\s+$/iu;

type Seed = {
  baseName: string;
  label: string;
  /** Full entity text the propagated mentions link to. */
  sourceText: string;
};

/**
 * After the main detection pass, collect organization
 * entities with a legal form suffix, strip the suffix
 * to get the base name, and re-scan the full text for
 * bare mentions of that base name. Returns new entities
 * for occurrences not already covered.
 *
 * Propagated mentions are coref aliases: each carries
 * `corefSourceText` linking it to the full seed entity
 * text, so placeholder numbering assigns the bare
 * mention the same placeholder as its source ("Acme"
 * and "Acme Corp." both become [ORGANIZATION_1]).
 */
export const propagateOrgNames = (
  entities: Entity[],
  fullText: string,
): Entity[] => {
  const seedByBase = new Map<string, Seed>();

  for (const e of entities) {
    if (e.label !== "organization") continue;
    if (isCallerOwnedEntity(e)) continue;
    for (const suffix of LEGAL_SUFFIXES) {
      if (e.text.endsWith(suffix)) {
        const base = e.text
          .slice(0, -suffix.length)
          .replace(TRAILING_SEP, "")
          .trim();
        if (base.length >= 3) {
          const existing = seedByBase.get(base);
          if (existing === undefined) {
            seedByBase.set(base, {
              baseName: base,
              label: e.label,
              sourceText: e.text,
            });
          } else if (existing.sourceText !== e.text) {
            // Distinct full forms share this base
            // ("Acme LLC" vs "Acme Corporation").
            // Linking bare mentions to either one would
            // corrupt the redaction key, so link them to
            // the base name itself: all bare mentions
            // still share one placeholder, distinct from
            // both full forms.
            existing.sourceText = base;
          }
        }
        break;
      }
    }
  }

  const seeds = [...seedByBase.values()];
  if (seeds.length === 0) return [];

  // Build a mutable array of already-covered spans
  // for overlap checks. Updated as new entities are
  // emitted to prevent duplicate propagation.
  const covered: [number, number][] = entities.map((e) => [e.start, e.end]);
  const isOverlapping = (start: number, end: number): boolean =>
    covered.some(([cs, ce]) => start < ce && end > cs);

  const results: Entity[] = [];

  for (const seed of seeds) {
    const { baseName, label } = seed;
    let searchFrom = 0;
    while (searchFrom < fullText.length) {
      const idx = fullText.indexOf(baseName, searchFrom);
      if (idx === -1) break;

      const matchEnd = idx + baseName.length;

      // Word boundary: reject if preceded or followed
      // by a letter or digit (prevents substring
      // matches like "ACME" inside "ACME2").
      const prevCh = fullText[idx - 1] ?? "";
      const nextCh = fullText[matchEnd] ?? "";
      if (WORD_CHAR_RE.test(prevCh) || WORD_CHAR_RE.test(nextCh)) {
        searchFrom = idx + 1;
        continue;
      }

      // Extend the span backward to include a Czech / English
      // "Společnost"/"the Company"-style determiner if present.
      // Without this, after `("Společnost Acme")` the
      // propagator would only highlight the bare "Acme" in
      // later mentions like "Společnost Acme" — losing the
      // determiner that's part of the referring phrase.
      let spanStart = idx;
      const lookbackStart = Math.max(0, idx - 40);
      const lookback = fullText.slice(lookbackStart, idx);
      const determinerMatch = ORG_DETERMINER_RE.exec(lookback);
      if (determinerMatch !== null) {
        // The match string may include a leading separator
        // char (the alternation accepts `^` or `[\s ]`) and
        // trailing whitespace; the capture group is the
        // determiner itself, so locate it inside the wider
        // match to skip whatever separators were consumed.
        const determiner = determinerMatch[1] ?? "";
        const offsetInMatch = determinerMatch[0].indexOf(determiner);
        spanStart = lookbackStart + determinerMatch.index + offsetInMatch;
      }

      // Skip if already covered by an existing entity
      // or a previously propagated result.
      if (!isOverlapping(spanStart, matchEnd)) {
        results.push({
          start: spanStart,
          end: matchEnd,
          label,
          text: fullText.slice(spanStart, matchEnd),
          score: ORG_PROPAGATION_SCORE,
          source: DETECTION_SOURCES.COREFERENCE,
          corefSourceText: seed.sourceText,
        });
        covered.push([spanStart, matchEnd]);
      }

      searchFrom = matchEnd;
    }
  }

  return results;
};
