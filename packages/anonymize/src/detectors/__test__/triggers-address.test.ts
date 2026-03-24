import { describe, expect, test } from "bun:test";

import { runPipeline } from "../../pipeline";
import type { Entity, PipelineConfig } from "../../types";

/**
 * Minimal pipeline config with only trigger phrases
 * enabled. All other detectors are disabled to isolate
 * the address extraction strategy.
 */
const TRIGGERS_ONLY_CONFIG: PipelineConfig = {
  threshold: 0.5,
  enableTriggerPhrases: true,
  enableRegex: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["address"],
  workspaceId: "test",
};

const findAddress = (
  entities: Entity[],
): Entity | undefined =>
  entities.find((e) => e.label === "address");

describe("address trigger strategy", () => {
  test("standard: captures full address with PSC and city", async () => {
    const text =
      "trvale bytem Lipová 42, 110 00 Praha 1, " +
      '(dále jen "Prodávající")';
    const entities = await runPipeline({
      fullText: text,
      config: TRIGGERS_ONLY_CONFIG,
      gazetteerEntries: [],
    });
    const addr = findAddress(entities);
    expect(addr).toBeDefined();
    expect(addr!.text).toBe(
      "Lipová 42, 110 00 Praha 1",
    );
  });

  test("abbreviated street: captures full address", async () => {
    const text =
      "bytem: nábř. Kpt. Jaroše 1000/7, " +
      "170 00 Praha 7";
    const entities = await runPipeline({
      fullText: text,
      config: TRIGGERS_ONLY_CONFIG,
      gazetteerEntries: [],
    });
    const addr = findAddress(entities);
    expect(addr).toBeDefined();
    expect(addr!.text).toBe(
      "nábř. Kpt. Jaroše 1000/7, 170 00 Praha 7",
    );
  });

  test("stops at period (sentence end)", async () => {
    const text = "trvale bytem Lipová 42.";
    const entities = await runPipeline({
      fullText: text,
      config: TRIGGERS_ONLY_CONFIG,
      gazetteerEntries: [],
    });
    const addr = findAddress(entities);
    expect(addr).toBeDefined();
    expect(addr!.text).toBe("Lipová 42");
  });

  test("stops at opening paren", async () => {
    const text =
      "trvale bytem Lipová 42 (přízemí)";
    const entities = await runPipeline({
      fullText: text,
      config: TRIGGERS_ONLY_CONFIG,
      gazetteerEntries: [],
    });
    const addr = findAddress(entities);
    expect(addr).toBeDefined();
    expect(addr!.text).toBe("Lipová 42");
  });

  test("respects max char limit", async () => {
    // Build a long address that exceeds default 120
    // char limit. The strategy should truncate.
    const longStreet =
      "Ulice " + "Nekonečná ".repeat(15) + "42";
    const text =
      `trvale bytem ${longStreet}, 110 00 Praha 1`;
    const entities = await runPipeline({
      fullText: text,
      config: TRIGGERS_ONLY_CONFIG,
      gazetteerEntries: [],
    });
    const addr = findAddress(entities);
    expect(addr).toBeDefined();
    // The extracted text should not exceed ~120 chars
    expect(addr!.text.length).toBeLessThanOrEqual(120);
  });
});
