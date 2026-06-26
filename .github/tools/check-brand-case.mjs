import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const DISALLOWED = ["S", "tella"].join("");
const EXPECTED = DISALLOWED.toLowerCase();
const IGNORED_PATHS = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
const IGNORED_PREFIXES = [
  ".ai/",
  ".agents/",
  ".claude/",
  ".github/assets/",
  "packages/data/dictionaries/",
  "packages/*/dist/",
  "packages/anonymize/wasm/dist/",
  "target/",
];

const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean)
  .filter((file) => !isIgnored(file));

let hasFailure = false;

for (const file of trackedFiles) {
  const content = readFileSync(file);
  if (content.includes(0)) {
    continue;
  }

  const text = content.toString("utf8");
  let index = text.indexOf(DISALLOWED);
  while (index !== -1) {
    const { line, column } = lineColumnFor(text, index);
    console.error(
      `${file}:${line}:${column} uses disallowed brand casing; use "${EXPECTED}"`,
    );
    hasFailure = true;
    index = text.indexOf(DISALLOWED, index + DISALLOWED.length);
  }
}

if (hasFailure) {
  process.exit(1);
}

function isIgnored(file) {
  if (IGNORED_PATHS.has(file)) {
    return true;
  }
  return IGNORED_PREFIXES.some((pattern) => {
    if (!pattern.includes("*")) {
      return file.startsWith(pattern);
    }
    const [prefix, suffix] = pattern.split("*");
    return file.startsWith(prefix) && file.includes(suffix);
  });
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
