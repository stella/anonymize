/**
 * Regression tests for multi-line US notice-block addresses.
 *
 * Real US contract addresses are line-broken, not comma-joined:
 *
 *     ACME Corporation
 *     One American Road
 *     Cleveland, Ohio 44144-2398
 *
 * The address-seed expander previously rejected any cluster whose
 * expanded text contained a newline, which dropped the dominant
 * real-world shape. The newline check now admits clusters that carry
 * independent evidence on both sides of the break (a "street" seed +
 * a "destination" seed); pure single-line evidence is still rejected
 * to avoid pulling in adjacent unrelated lines.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";
import { loadTestDictionaries } from "./load-dictionaries";

const dictionaries = await loadTestDictionaries();

const config: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: true,
  enableDenyList: true,
  enableGazetteer: false,
  enableConfidenceBoost: true,
  enableCoreference: true,
  enableHotwordRules: true,
  enableZoneClassification: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "multi-line-us-address-test",
  dictionaries,
};

const detect = (fullText: string): Promise<NativePipelineEntity[]> =>
  detectNative(config, fullText);

describe("multi-line US notice-block addresses", () => {
  test("street line + 'City, State ZIP+4' line yields a single address span", async () => {
    const text = [
      "If to ACME Corporation:",
      "ACME Corporation",
      "One American Road",
      "Cleveland, Ohio 44144-2398",
      "Attn: General Counsel",
    ].join("\n");
    const entities = await detect(text);
    const address = entities.find(
      (e) =>
        e.label === "address" &&
        e.text.includes("One American Road") &&
        e.text.includes("Cleveland") &&
        e.text.includes("44144-2398"),
    );
    expect(address).toBeDefined();
  });

  test("multi-line address inside a notice block does not swallow the phone line below", async () => {
    const text = [
      "ACME Corp",
      "One American Road",
      "Cleveland, Ohio 44144-2398",
      "Phone: (216) 889-5904",
    ].join("\n");
    const entities = await detect(text);
    const address = entities.find(
      (e) =>
        e.label === "address" &&
        e.text.includes("Cleveland") &&
        e.text.includes("44144-2398"),
    );
    expect(address).toBeDefined();
    expect(address?.text).not.toContain("889-5904");
  });

  test("comma-joined inline addresses (the previously-supported form) still work", async () => {
    const text =
      "Notices shall be delivered to 650 Page Mill Road, Palo Alto, CA 94304-1050.";
    const entities = await detect(text);
    const address = entities.find(
      (e) =>
        e.label === "address" &&
        e.text.includes("Page Mill") &&
        e.text.includes("94304-1050"),
    );
    expect(address).toBeDefined();
  });

  test("a lone street line with no destination on the next line is not tagged as an address", async () => {
    // "One American Road" alone — without a city/zip line directly
    // below — must not produce an address span. The newline-boundary
    // check requires multi-component evidence.
    const text = "One American Road\n\nIs the place where we meet.";
    const entities = await detect(text);
    const spurious = entities.find(
      (e) => e.label === "address" && e.text.includes("One American Road"),
    );
    expect(spurious).toBeUndefined();
  });

  test("inline address followed by an unrelated next line is trimmed, not dropped", async () => {
    // The expansion can walk through a single newline up to its 200-
    // char cap; without a trim, the newline-boundary check would drop
    // the whole span because all street/destination evidence sits
    // above the break.
    const text =
      "Notices shall be delivered to 650 Page Mill Road, Palo Alto, CA 94304-1050.\nPlease review the schedule.";
    const entities = await detect(text);
    const address = entities.find(
      (e) =>
        e.label === "address" &&
        e.text.includes("Page Mill") &&
        e.text.includes("94304-1050"),
    );
    expect(address).toBeDefined();
    expect(address?.text).not.toContain("Please review");
  });

  test("address span does not jump across a paragraph break (double newline)", async () => {
    const text = [
      "First street is One American Road, Cleveland, Ohio 44144-2398.",
      "",
      "Second street is 100 Main Street, Boston, Massachusetts 02101.",
    ].join("\n");
    const entities = await detect(text);
    const addresses = entities.filter((e) => e.label === "address");
    // Each address line should produce its own span, no merged span
    // spanning both paragraphs.
    expect(addresses.length).toBeGreaterThanOrEqual(1);
    for (const a of addresses) {
      const includesFirst = a.text.includes("American Road");
      const includesSecond = a.text.includes("Main Street");
      expect(includesFirst && includesSecond).toBe(false);
    }
  });
});
