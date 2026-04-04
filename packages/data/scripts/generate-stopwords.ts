/**
 * Generate a unified stopwords list from the stopwords-iso
 * npm package (MIT license, https://github.com/stopwords-iso).
 *
 * Extracts stopwords for all 23 EU official languages
 * available in the dataset (Maltese "mt" is missing from
 * stopwords-iso and is skipped).
 *
 * Output: packages/data/config/stopwords.json
 *   — flat array of unique lowercase strings, sorted.
 *
 * Usage:
 *   bun packages/data/scripts/generate-stopwords.ts
 *
 * Data source: stopwords-iso v1.1.0 (MIT license)
 * To regenerate: run this script after updating the
 * stopwords-iso dependency.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import data from "stopwords-iso/stopwords-iso.json";

const STOPWORDS_DATA = data as Record<string, string[]>;

/**
 * EU official language codes present in stopwords-iso.
 * Maltese ("mt") is not available in the dataset.
 */
const EU_LANGUAGES = [
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fi",
  "fr",
  "ga",
  "hr",
  "hu",
  "it",
  "lt",
  "lv",
  "nl",
  "pl",
  "pt",
  "ro",
  "sk",
  "sl",
  "sv",
] as const;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, "..", "config", "stopwords.json");

// ── Collect and deduplicate ─────────────────────────
// NOTE: The generated file intentionally retains all
// stopwords including those that collide with given
// names (e.g. "ana", "mia", "sara"). Name-based
// filtering is deferred to runtime in deny-list.ts
// via FIRST_NAME_EXCLUSIONS, so the exclusion set
// automatically tracks corpus changes without
// requiring regeneration of this file.

const allWords = new Set<string>();
const stats: { lang: string; count: number }[] = [];

for (const lang of EU_LANGUAGES) {
  const words = STOPWORDS_DATA[lang];
  if (!words) {
    console.warn(`  WARN: no data for "${lang}"`);
    continue;
  }

  for (const word of words) {
    const lower = word.toLowerCase().trim();
    // Skip entries that can never match a capitalised
    // keyword in the pipeline (UPPER_START_RE gate):
    // pure digits, lone symbols, and apostrophe-led
    // contraction fragments like 'll, 'tis, 'twas.
    if (
      lower.length === 0 ||
      /^\d+$/.test(lower) ||
      /^[_]$/.test(lower) ||
      /^['''\u2019]/.test(lower)
    ) {
      continue;
    }
    // U+2206 MATHEMATICAL INCREMENT → U+03B4 Greek
    // lowercase delta. The stopwords-iso "el" locale
    // ships the wrong codepoint; normalise so Greek
    // stopwords actually match real Greek text.
    const normalised = lower.replace(/∆/g, "\u03B4");
    allWords.add(normalised);
  }

  stats.push({ lang, count: words.length });
}

// ── Output ──────────────────────────────────────────

const sorted = [...allWords].sort();
const json = JSON.stringify(sorted, null, 2) + "\n";
writeFileSync(OUTPUT, json);

// ── Stats ───────────────────────────────────────────

console.log("Stopwords per language:");
for (const { lang, count } of stats) {
  console.log(`  ${lang}: ${count}`);
}
console.log(`\nTotal unique: ${sorted.length}`);
console.log(`Written to: ${OUTPUT}`);
