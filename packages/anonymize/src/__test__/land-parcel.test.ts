import { describe, expect, test } from "bun:test";

import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";

const TRIGGERS_ONLY_CONFIG: PipelineConfig = {
  threshold: 0.5,
  enableTriggerPhrases: true,
  enableRegex: false,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["land parcel"],
  workspaceId: "test",
};

const detect = (fullText: string): Promise<NativePipelineEntity[]> =>
  detectNative(TRIGGERS_ONLY_CONFIG, fullText);

const findParcels = (
  entities: NativePipelineEntity[],
): NativePipelineEntity[] => entities.filter((e) => e.label === "land parcel");

// ── Czech patterns ─────────────────────────────────

describe("Czech land parcel triggers", () => {
  test("parc. č. captures parcel number", async () => {
    const entities = await detect("parc. č. 852/2");
    const parcels = findParcels(entities);
    expect(parcels.length).toBe(1);
    // Boundary consistency may extend the span
    // into the preceding punctuation; the value
    // portion must still contain the number.
    expect(parcels[0]?.text).toContain("852/2");
  });

  test.each([
    ["st. 452", "452"],
    ["st. 452/12", "452/12"],
  ] as const)("%s captures a building parcel", async (text, expected) => {
    const parcels = findParcels(await detect(text));

    expect(parcels).toEqual([
      expect.objectContaining({
        text: expected,
      }),
    ]);
  });

  test("stops a building parcel before trailing punctuation", async () => {
    const parcels = findParcels(await detect("st. 452, k.ú. Dobříš"));

    expect(parcels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "452",
        }),
      ]),
    );
  });

  test("k.ú. captures cadastral territory", async () => {
    const entities = await detect("k.ú. Dobříš, okres Příbram");
    const parcels = findParcels(entities);
    expect(parcels.length).toBe(1);
    expect(parcels[0]?.text).toBe("Dobříš");
  });

  test("LV č. captures ownership sheet", async () => {
    const entities = await detect("LV č. 154");
    const parcels = findParcels(entities);
    expect(parcels.length).toBe(1);
    expect(parcels[0]?.text).toContain("154");
  });

  test("list vlastnictví č. captures sheet number", async () => {
    const entities = await detect("list vlastnictví č. 229");
    const parcels = findParcels(entities);
    expect(parcels.length).toBe(1);
    expect(parcels[0]?.text).toContain("229");
  });

  test("compound: parcela + k.ú. yields two entities", async () => {
    const text =
      "parcela č. 2389 v k.ú. " +
      "Lipnice nad Sázavou, " +
      "okres Havlíčkův Brod";
    const entities = await detect(text);
    const parcels = findParcels(entities);
    expect(parcels.length).toBe(2);
  });
});

// ── German patterns ────────────────────────────────

describe("German land parcel triggers", () => {
  test("Flurstück Nr. captures parcel number", async () => {
    const entities = await detect("Flurstück Nr. 1234");
    const parcels = findParcels(entities);
    expect(parcels.length).toBe(1);
    expect(parcels[0]?.text).toContain("1234");
  });

  test("Gemarkung captures cadastral district", async () => {
    const entities = await detect("Gemarkung München, Flur 12");
    const parcels = findParcels(entities);
    expect(parcels.length).toBeGreaterThanOrEqual(1);
    const gemarkung = parcels.find((p) => p.text === "München");
    expect(gemarkung).toBeDefined();
  });
});

// ── False positives ────────────────────────────────

describe("land parcel false positive rejection", () => {
  test("LV alone without č. is not caught", async () => {
    const entities = await detect("LV je důležitý dokument");
    const parcels = findParcels(entities);
    expect(parcels.length).toBe(0);
  });

  test("parc. č. with non-numeric value is rejected", async () => {
    const entities = await detect("parc. č. abc");
    const parcels = findParcels(entities);
    expect(parcels.length).toBe(0);
  });

  test("ambiguous st. abbreviation requires a numeric parcel", async () => {
    const parcels = findParcels(await detect("st. budova"));

    expect(parcels).toEqual([]);
  });
});
