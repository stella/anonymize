import { describe, expect, test } from "bun:test";

import { runPipeline } from "../pipeline";
import type { Entity, PipelineConfig } from "../types";

const TRIGGERS_ONLY_CONFIG: PipelineConfig = {
  threshold: 0.5,
  enableTriggerPhrases: true,
  enableRegex: false,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["land parcel"],
  workspaceId: "test",
};

const findParcels = (
  entities: Entity[],
): Entity[] =>
  entities.filter((e) => e.label === "land parcel");

// ── Czech patterns ─────────────────────────────────

describe("Czech land parcel triggers", () => {
  test(
    "parc. č. captures parcel number",
    async () => {
      const entities = await runPipeline({
        fullText: "parc. č. 852/2",
        config: TRIGGERS_ONLY_CONFIG,
        gazetteerEntries: [],
      });
      const parcels = findParcels(entities);
      expect(parcels.length).toBe(1);
      // Boundary consistency may extend the span
      // into the preceding punctuation; the value
      // portion must still contain the number.
      expect(parcels[0]?.text).toContain("852/2");
    },
  );

  test(
    "k.ú. captures cadastral territory",
    async () => {
      const entities = await runPipeline({
        fullText:
          "k.ú. Dobříš, okres Příbram",
        config: TRIGGERS_ONLY_CONFIG,
        gazetteerEntries: [],
      });
      const parcels = findParcels(entities);
      expect(parcels.length).toBe(1);
      expect(parcels[0]?.text).toBe("Dobříš");
    },
  );

  test(
    "LV č. captures ownership sheet",
    async () => {
      const entities = await runPipeline({
        fullText: "LV č. 154",
        config: TRIGGERS_ONLY_CONFIG,
        gazetteerEntries: [],
      });
      const parcels = findParcels(entities);
      expect(parcels.length).toBe(1);
      expect(parcels[0]?.text).toContain("154");
    },
  );

  test(
    "list vlastnictví č. captures sheet number",
    async () => {
      const entities = await runPipeline({
        fullText: "list vlastnictví č. 229",
        config: TRIGGERS_ONLY_CONFIG,
        gazetteerEntries: [],
      });
      const parcels = findParcels(entities);
      expect(parcels.length).toBe(1);
      expect(parcels[0]?.text).toContain("229");
    },
  );

  test(
    "compound: parcela + k.ú. yields two entities",
    async () => {
      const text =
        "parcela č. 2389 v k.ú. " +
        "Lipnice nad Sázavou, " +
        "okres Havlíčkův Brod";
      const entities = await runPipeline({
        fullText: text,
        config: TRIGGERS_ONLY_CONFIG,
        gazetteerEntries: [],
      });
      const parcels = findParcels(entities);
      expect(parcels.length).toBe(2);
    },
  );
});

// ── German patterns ────────────────────────────────

describe("German land parcel triggers", () => {
  test(
    "Flurstück Nr. captures parcel number",
    async () => {
      const entities = await runPipeline({
        fullText: "Flurstück Nr. 1234",
        config: TRIGGERS_ONLY_CONFIG,
        gazetteerEntries: [],
      });
      const parcels = findParcels(entities);
      expect(parcels.length).toBe(1);
      expect(parcels[0]?.text).toContain("1234");
    },
  );

  test(
    "Gemarkung captures cadastral district",
    async () => {
      const entities = await runPipeline({
        fullText: "Gemarkung München, Flur 12",
        config: TRIGGERS_ONLY_CONFIG,
        gazetteerEntries: [],
      });
      const parcels = findParcels(entities);
      expect(
        parcels.length,
      ).toBeGreaterThanOrEqual(1);
      const gemarkung = parcels.find(
        (p) => p.text === "München",
      );
      expect(gemarkung).toBeDefined();
    },
  );
});

// ── False positives ────────────────────────────────

describe("land parcel false positive rejection", () => {
  test(
    "LV alone without č. is not caught",
    async () => {
      const entities = await runPipeline({
        fullText: "LV je důležitý dokument",
        config: TRIGGERS_ONLY_CONFIG,
        gazetteerEntries: [],
      });
      const parcels = findParcels(entities);
      expect(parcels.length).toBe(0);
    },
  );

  test(
    "parc. č. with non-numeric value is rejected",
    async () => {
      const entities = await runPipeline({
        fullText: "parc. č. abc",
        config: TRIGGERS_ONLY_CONFIG,
        gazetteerEntries: [],
      });
      const parcels = findParcels(entities);
      expect(parcels.length).toBe(0);
    },
  );
});
