import { createRequire } from "node:module";

import type { GroundTruthDocument } from "../ground-truth";
import {
  type Adapter,
  type NativePrediction,
  runTwoPassInProcess,
} from "./types";

const require = createRequire(import.meta.url);

const REDACT_PII_VERSION = "3.4.0";
const REDACT_PII_VENDOR_PATH = `../../vendor/redact-pii/${REDACT_PII_VERSION}`;

/**
 * redact-pii is a redaction library: `SyncRedactor` returns masked text, not
 * spans. To score it we reproduce its detection with span offsets by running
 * its own detectors over the original text:
 *
 *   - the exported regexp built-ins (`simple-regexp-patterns`) via `matchAll`;
 *   - the `NameRedactor` logic, whose internal regexes are not exported, so the
 *     two-phase algorithm below mirrors redact-pii@3.4.0's `NameRedactor`
 *     (lib/built-ins/NameRedactor.js) and loads the same well-known-names.json.
 *
 * Running each detector on the original text (rather than sequentially on
 * already-masked text) can only yield a superset of what redaction would emit,
 * so this is a generous, faithful representation of redact-pii's recall.
 */

type SimpleRegexpPatterns = Record<string, RegExp>;

type Detector = (text: string) => NativePrediction[];

const buildNameDetector = (wellKnownNames: readonly string[]): Detector => {
  // Mirrors NameRedactor.js internals (not exported by the package).
  const greetingRegex = /(^|\.\s+)(dear|hi|hello|greetings|hey|hey there)/gi;
  const closingRegex =
    /(thx|thanks|thank you|regards|best|[a-z]+ly|[a-z]+ regards|all the best|happy [a-z]+ing|take care|have a [a-z]+ (weekend|night|day))/gi;
  const greetingOrClosing = new RegExp(
    `(((${greetingRegex.source})|(${closingRegex.source}\\s*[,.!]*))[\\s-]*)`,
    "gi",
  );
  const genericName = new RegExp(
    "( ?(([A-Z][a-z]+)|([A-Z]\\.)))+([,.]|[,.]?$)",
    "gm",
  );
  const wellKnownNamesRegex = new RegExp(
    `\\b(\\s*)(\\s*(${wellKnownNames.join("|")}))+\\b`,
    "gim",
  );

  return (text: string): NativePrediction[] => {
    const spans: NativePrediction[] = [];

    // Phase 1: a capitalised name immediately after a greeting/closing.
    greetingOrClosing.lastIndex = 0;
    let greeting = greetingOrClosing.exec(text);
    while (greeting !== null) {
      genericName.lastIndex = greetingOrClosing.lastIndex;
      const nameMatch = genericName.exec(text);
      if (
        nameMatch !== null &&
        nameMatch.index === greetingOrClosing.lastIndex
      ) {
        const suffix = nameMatch[5] ?? "";
        const start = nameMatch.index;
        const end = start + nameMatch[0].length - suffix.length;
        spans.push({
          start,
          end,
          label: "names",
          text: text.slice(start, end),
        });
      }
      greeting = greetingOrClosing.exec(text);
    }

    // Phase 2: runs of well-known first/last names. Group 1 is leading
    // whitespace redact-pii preserves, so the span starts after it.
    wellKnownNamesRegex.lastIndex = 0;
    let known = wellKnownNamesRegex.exec(text);
    while (known !== null) {
      const lead = known[1] ?? "";
      const start = known.index + lead.length;
      const end = known.index + known[0].length;
      if (end > start) {
        spans.push({
          start,
          end,
          label: "names",
          text: text.slice(start, end),
        });
      }
      if (wellKnownNamesRegex.lastIndex === known.index) {
        wellKnownNamesRegex.lastIndex += 1; // guard against zero-width matches
      }
      known = wellKnownNamesRegex.exec(text);
    }

    return spans;
  };
};

/** Drop a span fully covered by another span with the same label. */
const dropContained = (spans: NativePrediction[]): NativePrediction[] => {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: NativePrediction[] = [];
  for (const span of sorted) {
    const covered = kept.some(
      (other) =>
        other.label === span.label &&
        other.start <= span.start &&
        other.end >= span.end,
    );
    if (!covered) {
      kept.push(span);
    }
  }
  return kept;
};

const buildDetector = (): Detector => {
  const patterns = require(
    `${REDACT_PII_VENDOR_PATH}/simple-regexp-patterns.cjs`,
  ) as SimpleRegexpPatterns;
  const wellKnownNames = require(
    `${REDACT_PII_VENDOR_PATH}/well-known-names.json`,
  ) as string[];

  // Precompile every built-in regexp with a global flag once, at build time,
  // rather than per document. Non-RegExp exports (a future version could add a
  // helper function to this module) are skipped: they carry no `source`/`flags`
  // and are not detectors we can run.
  const compiled: { label: string; regex: RegExp }[] = [];
  for (const [label, pattern] of Object.entries(patterns)) {
    if (!(pattern instanceof RegExp)) {
      continue;
    }
    compiled.push({
      label,
      regex: new RegExp(
        pattern.source,
        pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
      ),
    });
  }

  const detectNames = buildNameDetector(wellKnownNames);

  return (text: string): NativePrediction[] => {
    const spans: NativePrediction[] = [];
    // Faithful SyncRedactor emulation: detectors run sequentially and each
    // masks its matches before the next runs, so a later broad rule (digits)
    // never re-matches inside an earlier redaction (credit card, phone).
    // Emulate by masking matched ranges in a working copy between detectors;
    // masking preserves length, so recorded offsets stay in original space.
    let working = text;
    const maskRange = (start: number, end: number): void => {
      working =
        working.slice(0, start) +
        "\u0000".repeat(end - start) +
        working.slice(end);
    };
    for (const { label, regex } of compiled) {
      for (const match of working.matchAll(regex)) {
        if (match.index === undefined) {
          continue;
        }
        const value = match[0];
        if (value.length === 0) {
          continue;
        }
        spans.push({
          start: match.index,
          end: match.index + value.length,
          label,
          text: text.slice(match.index, match.index + value.length),
        });
        maskRange(match.index, match.index + value.length);
      }
    }
    for (const span of detectNames(working)) {
      spans.push({ ...span, text: text.slice(span.start, span.end) });
    }
    return dropContained(spans);
  };
};

export const createRedactPiiAdapter = (): Adapter => ({
  name: "redact-pii",
  version: REDACT_PII_VERSION,
  run: async (docs: readonly GroundTruthDocument[]) => {
    // Init boundary (fairness, symmetric with the other adapters): loading
    // redact-pii's built-in pattern list and well-known-names corpus, and
    // compiling the regexes (the well-known-names regex alternation is large),
    // is redact-pii's one-time setup, so it is timed as init rather than
    // hidden at module load.
    const initStart = performance.now();
    const detect = buildDetector();
    const initSeconds = (performance.now() - initStart) / 1000;
    return runTwoPassInProcess(docs, detect, initSeconds);
  },
});
