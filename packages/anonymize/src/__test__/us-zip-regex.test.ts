/**
 * Regression tests for the US ZIP+4 regex. Bare ZIP5
 * (`\d{5}`) is too generic to emit on its own and is
 * intentionally handled by address-seed clustering;
 * the hyphenated ZIP+4 shape is distinctive enough to
 * fire as a standalone address.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { Entity, PipelineConfig } from "../types";
import { loadTestDictionaries } from "./load-dictionaries";

const baseConfig: Omit<PipelineConfig, "dictionaries"> = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: true,
  enableDenyList: true,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: true,
  enableCoreference: true,
  enableHotwordRules: true,
  enableZoneClassification: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "us-zip-regex-test",
};

const detect = async (fullText: string): Promise<Entity[]> => {
  const dictionaries = await loadTestDictionaries();
  const context = createPipelineContext();
  return runPipeline({
    fullText,
    config: { ...baseConfig, dictionaries },
    gazetteerEntries: [],
    context,
  });
};

describe("US ZIP+4 regex", () => {
  test("ZIP+4 inside a US notice address expands to the full address", async () => {
    const text = "650 Page Mill Road, Palo Alto, CA 94304-1050, Attn: Counsel";
    const entities = await detect(text);
    const fullAddress = entities.find(
      (e) =>
        e.label === "address" &&
        e.text.includes("650 Page Mill Road") &&
        e.text.includes("Palo Alto") &&
        e.text.includes("94304-1050"),
    );
    expect(fullAddress).toBeDefined();
  });

  test("bare ZIP5 not absorbed by ZIP+4 lookaround", async () => {
    // The pattern requires a hyphen + four digits; a
    // standalone five-digit number must not match.
    const text = "Order number 94301 was confirmed.";
    const entities = await detect(text);
    const zip = entities.find((e) => e.text.includes("94301"));
    expect(zip).toBeUndefined();
  });

  test("ZIP+4 in mid-sentence prose is captured", async () => {
    const text =
      "Notices shall be delivered to 100 Main St, Springfield, IL 62701-1234 at all times.";
    const entities = await detect(text);
    const address = entities.find(
      (e) =>
        e.label === "address" &&
        e.text.includes("Main St") &&
        e.text.includes("Springfield") &&
        e.text.includes("62701-1234"),
    );
    expect(address).toBeDefined();
  });

  test("ZIP+4 substring inside a longer hyphenated identifier does not match", async () => {
    // `12-34567-8901` and `12345-6789-0` look like ZIP+4
    // if scanned with only `\b` on each side. The
    // lookbehind/lookahead reject adjacent digits and
    // dashes so order/case/account numbers are not
    // redacted as addresses.
    const text =
      "Order number 12-34567-8901 references case 12345-6789-0 for billing.";
    const entities = await detect(text);
    const spurious = entities.find(
      (e) =>
        e.label === "address" &&
        (e.text === "34567-8901" || e.text === "12345-6789"),
    );
    expect(spurious).toBeUndefined();
  });

  test("ZIP+4 substring inside an alphanumeric identifier does not match", async () => {
    const text = "SKU A94304-1050B was shipped to Springfield.";
    const entities = await detect(text);
    const spurious = entities.find(
      (e) => e.label === "address" && e.text.includes("94304-1050"),
    );
    expect(spurious).toBeUndefined();
  });

  test("ZIP+4 with typographic dash separators is captured", async () => {
    // OCR and professional typesetting commonly substitute
    // ASCII hyphen with en-dash (`–`) or non-breaking
    // hyphen (`‑`). The ZIP+4 pattern uses the shared
    // `DASH` class to accept those variants.
    const enDash = "Notices to 100 Main St, Palo Alto, CA 94304–1050.";
    const nbHyphen = "Notices to 100 Main St, Palo Alto, CA 94304‑1050.";
    for (const text of [enDash, nbHyphen]) {
      const entities = await detect(text);
      const zipOrAddress = entities.find(
        (e) => e.label === "address" && /94304.1050/.test(e.text),
      );
      expect(zipOrAddress).toBeDefined();
    }
  });

  test("typographic ZIP+4 participates in address-seed expansion", async () => {
    const text = "100 Main St, Palo Alto, CA 94304–1050";
    const entities = await detect(text);
    const fullAddress = entities.find(
      (e) =>
        e.label === "address" &&
        e.text.includes("Main St") &&
        e.text.includes("Palo Alto") &&
        e.text.includes("94304–1050"),
    );
    expect(fullAddress).toBeDefined();
  });
});
