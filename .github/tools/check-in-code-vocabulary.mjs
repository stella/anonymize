// Bans hardcoded natural-language vocabulary in source code. Word lists
// (conjunctions, prepositions, unit designators, stopwords, ...) are
// language data: they must live in per-language data files and reach the
// runtime through the assembler, never as an inline `const WORDS = [...]`.
// See packages/data/config/conjunctions.json for the intended shape.
//
// Heuristic: a flat array literal holding at least THRESHOLD string literals
// that are lowercase natural-language words (letters, marks, hyphen,
// apostrophe) is treated as an in-code vocabulary. Documented exceptions live
// in ALLOWLIST, keyed by the constant/identifier name on the same line.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const THRESHOLD = 6;
const WORD_FRACTION = 0.8;

// Runtime detection/assembly source, where language vocabulary belongs in data
// rather than inline. Generators, benchmarks, CLIs, and tests legitimately list
// codes and identifiers, so they stay out of scope.
const SOURCE_PREFIXES = [
  "crates/anonymize-core/src/",
  "crates/anonymize-adapter-contract/src/",
  "packages/anonymize/src/",
];
const SOURCE_SUFFIXES = [".rs", ".ts", ".mts"];
const IGNORED_SUBSTRINGS = ["/__test__/", "/wasm/", "/dist/"];
const IGNORED_SUFFIXES = [".test.ts", ".test.mts", ".d.ts"];

// Exceptions, keyed by the identifier the array is bound to. Two kinds:
//   - genuinely not language vocabulary (locale codes; morphology forms that
//     are coupled to Rust gate predicates, not a lookup list);
//   - existing debt tracked for migration into packages/data. Do NOT extend the
//     debt set — new vocabulary must go straight to a data file. A source site
//     can also opt out with a `vocab-allow: <reason>` comment on its line.
const ALLOWLIST = new Set([
  // not vocabulary
  "NONWESTERN_LOCALE_KEYS",
  "forms",
  // migration debt (move into packages/data, then delete from here)
  "SUPPLEMENTARY_NAME_EXCLUSIONS",
  "SENTENCE_VERB_INDICATORS_SEED",
  "ADDRESS_STOP_KEYWORDS_SEED",
  "IN_NAME_CONNECTORS",
  "UNIT_DESIGNATORS",
]);

const WORD = /^\p{Ll}[\p{Ll}\p{M}'’-]*$/u;
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"/g;
const FLAT_ARRAY = /\[[^[\]]*\]/gs;
// Identifier bound to the array, read from the enclosing statement: `NAME = [`,
// `NAME: T = &[` (const with type, `=` and array may be on separate lines), or
// a `field: &[` struct position.
const IDENT_ASSIGN = /([A-Za-z_]\w*)\s*(?::[^=]*)?=\s*&?\s*$/s;
const IDENT_FIELD = /([A-Za-z_]\w*)\s*:\s*&?\s*$/s;

const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean)
  .filter(isSource);

let hasFailure = false;

for (const file of trackedFiles) {
  const raw = readFileSync(file, "utf8");
  const text = stripComments(raw);
  for (const match of text.matchAll(FLAT_ARRAY)) {
    const literals = [...match[0].matchAll(STRING_LITERAL)].map((m) =>
      decode(m[0]),
    );
    if (literals.length < THRESHOLD) {
      continue;
    }
    const words = literals.filter((value) => WORD.test(value));
    if (
      words.length < THRESHOLD ||
      words.length / literals.length < WORD_FRACTION
    ) {
      continue;
    }
    // Look back over the enclosing statement (bounded, up to the previous
    // statement/block boundary) for the identifier the array is bound to.
    const window = text.slice(Math.max(0, match.index - 200), match.index);
    const statement = window.split(/[;{}]/).pop() ?? "";
    const ident =
      statement.match(IDENT_ASSIGN)?.[1] ?? statement.match(IDENT_FIELD)?.[1];
    if (ident && ALLOWLIST.has(ident)) {
      continue;
    }
    // Inline opt-out: `vocab-allow` anywhere on the array's line or the one
    // above. `text` positions line up with `raw` (stripping preserves them).
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const prevLineStart = text.lastIndexOf("\n", lineStart - 2) + 1;
    const lineEnd = text.indexOf("\n", match.index);
    const scanEnd = lineEnd === -1 ? raw.length : lineEnd;
    if (raw.slice(prevLineStart, scanEnd).includes("vocab-allow")) {
      continue;
    }
    const { line, column } = lineColumnFor(text, match.index);
    console.error(
      `${file}:${line}:${column} in-code vocabulary${ident ? ` "${ident}"` : ""} ` +
        `(${words.length} words: ${words.slice(0, 4).join(", ")}…); move it to a ` +
        `per-language data file and compose it in the assembler`,
    );
    hasFailure = true;
  }
}

if (hasFailure) {
  console.error(
    "\nHardcoded vocabulary is banned. Put word lists in packages/data and " +
      "thread them through the assembler; see conjunctions.json.",
  );
  process.exit(1);
}

function isSource(file) {
  if (!SOURCE_PREFIXES.some((prefix) => file.startsWith(prefix))) {
    return false;
  }
  if (!SOURCE_SUFFIXES.some((suffix) => file.endsWith(suffix))) {
    return false;
  }
  if (IGNORED_SUFFIXES.some((suffix) => file.endsWith(suffix))) {
    return false;
  }
  return !IGNORED_SUBSTRINGS.some((part) => file.includes(part));
}

function decode(literal) {
  return literal.slice(1, -1).replace(/\\(.)/g, "$1");
}

// Drop line and block comments so words quoted in prose do not trip the check.
// Blank comments to spaces (never delete characters) so every offset in the
// returned text still maps to the same offset in the original source.
function stripComments(text) {
  const blanked = text.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  return blanked
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      return at === -1
        ? line
        : line.slice(0, at) + " ".repeat(line.length - at);
    })
    .join("\n");
}

function lineColumnFor(text, index) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
      continue;
    }
    column += 1;
  }
  return { line, column };
}
