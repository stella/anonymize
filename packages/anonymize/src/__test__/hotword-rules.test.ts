import {
  describe,
  expect,
  it,
  beforeAll,
} from "bun:test";
import {
  applyHotwordRules,
  initHotwordRules,
} from "../filters/hotword-rules";
import type { Entity } from "../types";

const makeEntity = (
  start: number,
  end: number,
  label: string,
  score = 0.6,
): Entity => ({
  start,
  end,
  label,
  text: "x".repeat(end - start),
  score,
  source: "ner",
});

beforeAll(async () => {
  await initHotwordRules();
});

describe("hotword rules", () => {
  it("boosts birth number near 'rodné číslo'", () => {
    // "rodné číslo: 123456/7890"
    //  ^0         ^14    ^22
    const text = "rodné číslo: 123456/7890";
    const entity = makeEntity(
      13,
      24,
      "czech birth number",
      0.5,
    );
    const result = applyHotwordRules([entity], text);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeGreaterThan(0.5);
    expect(result[0].label).toBe(
      "czech birth number",
    );
  });

  it(
    "reclassifies date to 'date of birth' " +
      "near 'narozen'",
    () => {
      const text =
        "narozen dne 12.03.1990 v Praze";
      // "narozen" ends at 7, date starts at 12
      const entity = makeEntity(12, 22, "date", 0.7);
      const result = applyHotwordRules([entity], text);
      expect(result).toHaveLength(1);
      expect(result[0].label).toBe("date of birth");
      expect(result[0].score).toBeGreaterThan(0.7);
    },
  );

  it("penalizes date near 'článek'", () => {
    const text = "článek 3 ze dne 15.01.2024";
    // "článek" ends at 7, date starts at 16
    const entity = makeEntity(16, 26, "date", 0.6);
    const result = applyHotwordRules([entity], text);
    expect(result).toHaveLength(1);
    // Distance is 9 chars, proximityAfter is 10,
    // so the penalty applies with slight decay.
    expect(result[0].score).toBeLessThan(0.6);
  });

  it("leaves entity unchanged with no nearby hotwords", () => {
    const text =
      "Lorem ipsum dolor sit amet, " +
      "consectetur adipiscing elit. " +
      "Nullam euismod, nisl eget aliquam " +
      "ultricies. 12.03.1990 nisi.";
    const entity = makeEntity(
      93,
      103,
      "date",
      0.65,
    );
    const result = applyHotwordRules([entity], text);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.65);
    expect(result[0].label).toBe("date");
  });

  it("applies distance decay: closer hotword gives stronger boost", () => {
    // Two texts: one with hotword right next to
    // entity, one further away.
    const closeText = "tel. 123456789";
    const farText =
      "tel. " + " ".repeat(50) + "123456789";

    const closeEntity = makeEntity(
      5,
      14,
      "phone number",
      0.5,
    );
    const farEntity = makeEntity(
      55,
      64,
      "phone number",
      0.5,
    );

    const closeResult = applyHotwordRules(
      [closeEntity],
      closeText,
    );
    const farResult = applyHotwordRules(
      [farEntity],
      farText,
    );

    expect(closeResult[0].score).toBeGreaterThan(
      farResult[0].score,
    );
  });

  it("keeps strongest adjustment from multiple matching rules", () => {
    // Both "článek" (penalty) and "narozen" near date.
    // "narozen" gives +0.15 reclassify, "článek"
    // gives -0.3. The stronger magnitude wins.
    const text =
      "narozen článek dne 12.03.1990";
    // "článek" ends at 15, entity at 19..29
    // "narozen" ends at 7, entity at 19..29
    const entity = makeEntity(19, 29, "date", 0.7);
    const result = applyHotwordRules([entity], text);
    expect(result).toHaveLength(1);
    // The penalty (-0.3) has greater magnitude than
    // the boost (+0.15), so penalty wins.
    expect(result[0].score).toBeLessThan(0.7);
  });

  it("matches hotword before entity within proximityBefore", () => {
    // Address rule: proximityBefore=80
    const padding = " ".repeat(70);
    const text = `adresa${padding}Praha 1`;
    const entity = makeEntity(
      76,
      83,
      "address",
      0.5,
    );
    const result = applyHotwordRules([entity], text);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeGreaterThan(0.5);
  });

  it("does NOT match hotword after entity beyond proximityAfter", () => {
    // Person role rule: proximityAfter=30
    const padding = " ".repeat(50);
    const text = `Jan Novák${padding}jednatel`;
    const entity = makeEntity(0, 9, "person", 0.5);
    const result = applyHotwordRules([entity], text);
    expect(result).toHaveLength(1);
    // Hotword "jednatel" is 50 chars after entity,
    // beyond proximityAfter=30.
    expect(result[0].score).toBe(0.5);
  });

  it("returns entities unchanged when rules list is empty", async () => {
    // Since we loaded real rules in beforeAll, we
    // test the guard path: when no hotword hits exist
    // in the text, entities pass through unchanged.
    const text = "zzzzz 12345";
    const entity = makeEntity(6, 11, "date", 0.6);
    const result = applyHotwordRules([entity], text);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.6);
  });

  it("clamps score to [0, 1]", () => {
    // Entity already at 0.95, boost of 0.25 should
    // clamp to 1.0.
    const text = "rodné číslo: 123456/7890";
    const entity = makeEntity(
      13,
      24,
      "czech birth number",
      0.95,
    );
    const result = applyHotwordRules([entity], text);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeLessThanOrEqual(1);
  });

  it("clamps score to 0 on heavy penalty", () => {
    // Entity at 0.1, penalty of -0.3.
    const text = "článek 12.03.2024";
    const entity = makeEntity(8, 17, "date", 0.1);
    const result = applyHotwordRules([entity], text);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeGreaterThanOrEqual(0);
  });
});
