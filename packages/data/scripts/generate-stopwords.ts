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
  "bg", "cs", "da", "de", "el", "en", "es", "et",
  "fi", "fr", "ga", "hr", "hu", "it", "lt", "lv",
  "nl", "pl", "pt", "ro", "sk", "sl", "sv",
] as const;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(
  __dirname,
  "..",
  "config",
  "stopwords.json",
);

// ── Collect and deduplicate ─────────────────────────

const allWords = new Set<string>();
const stats: { lang: string; count: number }[] = [];

for (const lang of EU_LANGUAGES) {
  const words = STOPWORDS_DATA[lang];
  if (!words) {
    console.warn(`  WARN: no data for "${lang}"`);
    continue;
  }

  let added = 0;
  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower.length > 0) {
      allWords.add(lower);
      added++;
    }
  }

  stats.push({ lang, count: added });
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
