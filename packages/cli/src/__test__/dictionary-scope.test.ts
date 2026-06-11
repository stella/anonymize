import { describe, expect, test } from "bun:test";

import type { Dictionaries } from "@stll/anonymize";

import { UsageError } from "../args";
import { filterDictionaries } from "../dictionary-scope";
import { shouldPromptForScope } from "../main";
import type { CliOptions } from "../args";

const FULL = {
  firstNames: { cs: ["Jan"], de: ["Hans"] },
  surnames: { cs: ["Novák"], de: ["Müller"] },
  denyList: {
    "banks/cz": ["Test Bank"],
    "banks/de": ["Probebank"],
    "names/first/cs": ["Jan"],
    "names/first/de": ["Hans"],
    "names/global": ["Jan", "Hans"],
  },
  denyListMeta: {
    "banks/cz": { label: "organization", category: "Financial", country: "CZ" },
    "banks/de": { label: "organization", category: "Financial", country: "DE" },
    "names/first/cs": { label: "person", category: "Names", country: null },
    "names/first/de": { label: "person", category: "Names", country: null },
    "names/global": { label: "person", category: "Names", country: null },
  },
  citiesByCountry: { CZ: ["Praha"], DE: ["Berlin"] },
} satisfies Dictionaries;

describe("filterDictionaries", () => {
  test("no scope keeps everything", () => {
    const result = filterDictionaries(FULL, {});
    expect(Object.keys(result.denyList).toSorted()).toEqual(
      Object.keys(FULL.denyList).toSorted(),
    );
    expect(result.citiesByCountry).toEqual(FULL.citiesByCountry);
  });

  test("countries scope drops other countries but keeps global", () => {
    const result = filterDictionaries(FULL, { countries: ["CZ"] });
    expect(result.denyList["banks/cz"]).toBeDefined();
    expect(result.denyList["banks/de"]).toBeUndefined();
    expect(result.denyList["names/global"]).toBeDefined();
    expect(Object.keys(result.citiesByCountry ?? {})).toEqual(["CZ"]);
  });

  test("languages scope drops other name dictionaries", () => {
    const result = filterDictionaries(FULL, { languages: ["cs"] });
    expect(Object.keys(result.firstNames)).toEqual(["cs"]);
    expect(result.denyList["names/first/de"]).toBeUndefined();
    expect(result.denyList["names/first/cs"]).toBeDefined();
    // Non-name dictionaries are unaffected by languages.
    expect(result.denyList["banks/de"]).toBeDefined();
  });

  test("unknown language fails fast with available list", () => {
    expect(() => filterDictionaries(FULL, { languages: ["xx"] })).toThrow(
      UsageError,
    );
  });
});

const opts = (overrides: Partial<CliOptions>): CliOptions => ({
  files: ["a.txt"],
  mode: "replace",
  threshold: 0.3,
  redactString: "[REDACTED]",
  json: false,
  quiet: false,
  help: false,
  version: false,
  ...overrides,
});

const TTY = { stdinIsTTY: true, stderrIsTTY: true };

describe("shouldPromptForScope", () => {
  test("prompts for interactive file runs without scope", () => {
    expect(shouldPromptForScope(opts({}), TTY)).toBe(true);
  });

  test.each([
    ["countries given", opts({ countries: ["CZ"] }), TTY],
    ["languages given", opts({ languages: ["cs"] }), TTY],
    ["quiet", opts({ quiet: true }), TTY],
    ["stdin input", opts({ files: [] }), TTY],
    ["piped stdin", opts({}), { stdinIsTTY: false, stderrIsTTY: true }],
    ["piped stderr", opts({}), { stdinIsTTY: true, stderrIsTTY: false }],
  ] as const)("never prompts when %s", (_name, options, tty) => {
    expect(shouldPromptForScope(options, tty)).toBe(false);
  });
});
