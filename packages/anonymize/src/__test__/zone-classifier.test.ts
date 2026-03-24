import { describe, expect, it, beforeAll } from "bun:test";
import {
  classifyZones,
  applyZoneAdjustments,
  initZoneClassifier,
  ZONE_SCORE_ADJUSTMENTS,
} from "../filters/zone-classifier";
import type { ZoneSpan } from "../filters/zone-classifier";
import type { Entity } from "../types";

const makeEntity = (
  start: number,
  end: number,
  score: number,
): Entity => ({
  start,
  end,
  label: "person",
  text: "Test",
  score,
  source: "ner",
});

beforeAll(async () => {
  await initZoneClassifier();
});

describe("classifyZones", () => {
  it("returns empty for empty text", () => {
    expect(classifyZones("")).toEqual([]);
  });

  it("detects header zone before first section", () => {
    const text = [
      "Smluvní strany:",
      "Prodávající: Jan Novák",
      "",
      "Článek 1",
      "Předmět smlouvy",
      "Toto je tělo smlouvy.",
    ].join("\n");

    const zones = classifyZones(text);
    const header = zones.find(
      (z) => z.zone === "header",
    );
    expect(header).toBeDefined();
    // Header ends at the line containing "Článek 1"
    expect(
      text.slice(header!.end).startsWith("Článek"),
    ).toBe(true);
  });

  it("detects English section heading", () => {
    const text = [
      "PARTIES:",
      "Buyer: Acme Corp",
      "",
      "Article 1",
      "This is the body.",
    ].join("\n");

    const zones = classifyZones(text);
    const header = zones.find(
      (z) => z.zone === "header",
    );
    expect(header).toBeDefined();
    expect(header!.start).toBe(0);
  });

  it("detects all-caps English section heading", () => {
    const text = [
      "PARTIES:",
      "Buyer: Acme Corp",
      "",
      "ARTICLE 1",
      "This is the body.",
    ].join("\n");

    const zones = classifyZones(text);
    const header = zones.find(
      (z) => z.zone === "header",
    );
    expect(header).toBeDefined();
    expect(header!.start).toBe(0);
    expect(
      text.slice(header!.end).startsWith("ARTICLE"),
    ).toBe(true);
  });

  it("detects German section heading", () => {
    const text = [
      "Vertragsparteien:",
      "",
      "§ 1 Gegenstand",
      "Dies ist der Vertrag.",
    ].join("\n");

    const zones = classifyZones(text);
    const header = zones.find(
      (z) => z.zone === "header",
    );
    expect(header).toBeDefined();
  });

  it("detects signature zone", () => {
    const text = [
      "1. Předmět smlouvy",
      "Tělo smlouvy.",
      "",
      "V Praze dne 1.1.2024",
      "Jan Novák",
    ].join("\n");

    const zones = classifyZones(text);
    const sig = zones.find(
      (z) => z.zone === "signature",
    );
    expect(sig).toBeDefined();
    expect(sig!.end).toBe(text.length);
  });

  it("detects table zone from tab characters", () => {
    const text = [
      "1. Přehled",
      "Jméno\tAdresa\tIČO",
      "Jan\tPraha\t12345678",
      "Pokračování textu.",
    ].join("\n");

    const zones = classifyZones(text);
    const table = zones.find(
      (z) => z.zone === "table",
    );
    expect(table).toBeDefined();
  });

  it("classifies remaining text as body", () => {
    const text = [
      "Smluvní strany:",
      "",
      "Článek 1",
      "Předmět smlouvy",
      "Toto je tělo smlouvy.",
    ].join("\n");

    const zones = classifyZones(text);
    const body = zones.find(
      (z) => z.zone === "body",
    );
    expect(body).toBeDefined();
  });

  it("zones cover entire text without gaps", () => {
    const text = [
      "Strany:",
      "Prodávající: Jan Novák",
      "",
      "Článek 1",
      "Tělo smlouvy.",
      "Další odstavec.",
      "",
      "V Praze dne 1.1.2024",
      "Podpis",
    ].join("\n");

    const zones = classifyZones(text);
    const sorted = zones.toSorted(
      (a, b) => a.start - b.start,
    );
    expect(sorted[0]!.start).toBe(0);
    expect(sorted[sorted.length - 1]!.end).toBe(
      text.length,
    );

    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.start).toBe(
        sorted[i - 1]!.end,
      );
    }
  });

  it("zones cover entire text with table zone", () => {
    const text = [
      "Strany:",
      "Prodávající: Jan Novák",
      "",
      "Článek 1",
      "Jméno\tAdresa\tIČO",
      "Jan\tPraha\t12345678",
      "Další odstavec.",
      "",
      "V Praze dne 1.1.2024",
      "Podpis",
    ].join("\n");

    const zones = classifyZones(text);
    const sorted = zones.toSorted(
      (a, b) => a.start - b.start,
    );
    expect(sorted[0]!.start).toBe(0);
    expect(sorted[sorted.length - 1]!.end).toBe(
      text.length,
    );
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.start).toBe(
        sorted[i - 1]!.end,
      );
    }
    expect(
      sorted.some((z) => z.zone === "table"),
    ).toBe(true);
  });

  it("handles signing clause before section heading", () => {
    // Degenerate layout: signing date on first line,
    // section heading later. Should not produce
    // overlapping zones.
    const text = [
      "V Praze dne 1.1.2024",
      "Jan Novák",
      "",
      "Článek 1",
      "Tělo smlouvy.",
    ].join("\n");

    const zones = classifyZones(text);
    const sorted = zones.toSorted(
      (a, b) => a.start - b.start,
    );
    // No overlapping zones
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.start).toBeGreaterThanOrEqual(
        sorted[i - 1]!.end,
      );
    }
  });

  it("does not match signing clause mid-sentence", () => {
    const text = [
      "1. Předmět smlouvy",
      "Společnost se sídlem V Praze zastoupená.",
      "Další text smlouvy.",
    ].join("\n");

    const zones = classifyZones(text);
    const sig = zones.find(
      (z) => z.zone === "signature",
    );
    // Mid-sentence "V Praze" should not trigger
    // signature zone detection.
    expect(sig).toBeUndefined();
  });

  it("handles text with no header or signature", () => {
    const text = "Just some plain text.";
    const zones = classifyZones(text);
    expect(zones.length).toBeGreaterThan(0);
    expect(
      zones.every((z) => z.zone === "body"),
    ).toBe(true);
  });
});

describe("applyZoneAdjustments", () => {
  it("boosts entity in header zone", () => {
    const zones: ZoneSpan[] = [
      { zone: "header", start: 0, end: 100 },
      { zone: "body", start: 100, end: 500 },
    ];
    const entities = [makeEntity(10, 30, 0.7)];
    const result = applyZoneAdjustments(
      entities,
      zones,
    );
    expect(result[0]!.score).toBe(
      0.7 + ZONE_SCORE_ADJUSTMENTS.header,
    );
  });

  it("boosts entity in signature zone", () => {
    const zones: ZoneSpan[] = [
      { zone: "body", start: 0, end: 400 },
      { zone: "signature", start: 400, end: 500 },
    ];
    const entities = [makeEntity(420, 450, 0.6)];
    const result = applyZoneAdjustments(
      entities,
      zones,
    );
    expect(result[0]!.score).toBe(
      0.6 + ZONE_SCORE_ADJUSTMENTS.signature,
    );
  });

  it("boosts entity in table zone", () => {
    const zones: ZoneSpan[] = [
      { zone: "body", start: 0, end: 200 },
      { zone: "table", start: 200, end: 350 },
      { zone: "body", start: 350, end: 500 },
    ];
    const entities = [makeEntity(220, 250, 0.65)];
    const result = applyZoneAdjustments(
      entities,
      zones,
    );
    expect(result[0]!.score).toBe(
      0.65 + ZONE_SCORE_ADJUSTMENTS.table,
    );
  });

  it("does not modify body entities", () => {
    const zones: ZoneSpan[] = [
      { zone: "body", start: 0, end: 500 },
    ];
    const entities = [makeEntity(100, 120, 0.7)];
    const result = applyZoneAdjustments(
      entities,
      zones,
    );
    expect(result[0]!.score).toBe(0.7);
  });

  it("caps score at 1.0", () => {
    const zones: ZoneSpan[] = [
      { zone: "signature", start: 0, end: 100 },
    ];
    const entities = [makeEntity(10, 30, 0.95)];
    const result = applyZoneAdjustments(
      entities,
      zones,
    );
    expect(result[0]!.score).toBe(1.0);
  });

  it("does not mutate input entities", () => {
    const zones: ZoneSpan[] = [
      { zone: "header", start: 0, end: 100 },
    ];
    const original = makeEntity(10, 30, 0.7);
    const entities = [original];
    applyZoneAdjustments(entities, zones);
    expect(original.score).toBe(0.7);
  });

  it("returns new array for empty zones", () => {
    const entities = [makeEntity(10, 30, 0.7)];
    const result = applyZoneAdjustments(entities, []);
    expect(result).not.toBe(entities);
    expect(result).toEqual(entities);
    // Entities must be spread-copied, not aliased
    expect(result[0]).not.toBe(entities[0]);
  });
});
