import { describe, expect, test } from "bun:test";
import {
  maskDetectedSpans,
  unmaskNerEntities,
} from "../util/entity-masking";
import type { Entity } from "../types";

const entity = (
  start: number,
  end: number,
  label = "person",
  score = 0.95,
  source: Entity["source"] = "trigger",
): Entity => ({
  start,
  end,
  label,
  text: `_`.repeat(end - start),
  score,
  source,
});

const nerEntity = (
  start: number,
  end: number,
  label = "person",
  score = 0.9,
): Entity => ({
  start,
  end,
  label,
  text: `_`.repeat(end - start),
  score,
  source: "ner",
});

describe("maskDetectedSpans", () => {
  test("no entities: identity function", () => {
    const text = "Hello world";
    const result = maskDetectedSpans(text, []);
    expect(result.maskedText).toBe(text);
    const mapped = result.offsetMap(0, 5);
    expect(mapped).toEqual({ start: 0, end: 5 });
  });

  test("single entity replaced with [MASKED]", () => {
    // "Hello Ing. Jan Novák, welcome"
    //  01234567890123456789012345678
    const text = "Hello Ing. Jan Novák, welcome";
    const e = entity(6, 20); // "Ing. Jan Novák"
    const result = maskDetectedSpans(text, [e]);
    expect(result.maskedText).toBe(
      "Hello [MASKED], welcome",
    );
  });

  test("multiple entities: offsets accumulate", () => {
    // "Call Jan Novák at jan@novak.cz today"
    //  positions: J=5, á=12, k=13, ' '=14
    //  j=18, z=29, ' '=30
    const text =
      "Call Jan Novák at jan@novak.cz today";
    const e1 = entity(5, 14); // "Jan Novák" (9 chars)
    const e2 = entity(18, 30); // "jan@novak.cz" (12 chars)
    const result = maskDetectedSpans(text, [e1, e2]);
    expect(result.maskedText).toBe(
      "Call [MASKED] at [MASKED] today",
    );
  });

  test("overlapping entities are merged", () => {
    const text = "aaaBBBBBCCCCCddd";
    // e1 spans [3,8), e2 spans [5,13)
    const e1 = entity(3, 8);
    const e2 = entity(5, 13);
    const result = maskDetectedSpans(text, [e1, e2]);
    // Merged span [3,13) replaced with [MASKED]
    expect(result.maskedText).toBe("aaa[MASKED]ddd");
  });

  test("adjacent entities: no gap issues", () => {
    const text = "AAABBB";
    const e1 = entity(0, 3);
    const e2 = entity(3, 6);
    const result = maskDetectedSpans(text, [e1, e2]);
    expect(result.maskedText).toBe(
      "[MASKED][MASKED]",
    );
  });
});

describe("offsetMap", () => {
  test("NER entity after masked region maps correctly",
    () => {
      // "Hello Ing. Jan Novák, call 123456"
      // Entity [6,20) = "Ing. Jan Novák" (14 chars)
      const text =
        "Hello Ing. Jan Novák, call 123456";
      const e = entity(6, 20);
      const result = maskDetectedSpans(text, [e]);
      // masked: "Hello [MASKED], call 123456"
      // [MASKED] is 8 chars, shift = 14 - 8 = 6
      expect(result.maskedText).toBe(
        "Hello [MASKED], call 123456",
      );
      // "123456" at [21,27) in masked, +6 = [27,33)
      const mapped = result.offsetMap(21, 27);
      expect(mapped).toEqual({ start: 27, end: 33 });
      expect(text.slice(27, 33)).toBe("123456");
    },
  );

  test("NER entity before any masked region", () => {
    const text = "Jan Novák lives at Ostrovní 5";
    const e = entity(19, 29); // "Ostrovní 5"
    const result = maskDetectedSpans(text, [e]);
    // "Jan Novák" is before mask, no shift
    const mapped = result.offsetMap(0, 9);
    expect(mapped).toEqual({ start: 0, end: 9 });
  });

  test("NER entity on masked region returns null",
    () => {
      const text = "Hello Jan Novák world";
      const e = entity(6, 15);
      const result = maskDetectedSpans(text, [e]);
      // [MASKED] is at positions 6..13 in masked text
      const mapped = result.offsetMap(6, 13);
      expect(mapped).toBeNull();
    },
  );

  test("NER entity partially overlapping mask: null",
    () => {
      const text = "Hello Jan Novák world";
      const e = entity(6, 15);
      const result = maskDetectedSpans(text, [e]);
      // Overlaps the mask region
      const mapped = result.offsetMap(4, 10);
      expect(mapped).toBeNull();
    },
  );
});

describe("unmaskNerEntities", () => {
  test("maps NER entities back to original offsets",
    () => {
      // "Ing. Jan Novák lives at Praha 1"
      // Entity [0,14) = "Ing. Jan Novák" (14 chars)
      const text =
        "Ing. Jan Novák lives at Praha 1";
      const ruleEnts = [entity(0, 14)];
      const mask = maskDetectedSpans(text, ruleEnts);
      // masked: "[MASKED] lives at Praha 1"
      // shift = 14 - 8 = 6
      // "Praha 1" at [18,25) in masked => [24,31)
      const rawNer = [nerEntity(18, 25, "address")];
      const result = unmaskNerEntities(
        rawNer,
        mask,
        ruleEnts,
        text,
      );
      expect(result).toHaveLength(1);
      expect(result[0].start).toBe(24);
      expect(result[0].end).toBe(31);
      expect(result[0].text).toBe("Praha 1");
    },
  );

  test("discards NER entity overlapping rule entity",
    () => {
      const text = "Hello Jan Novák world";
      const ruleEnts = [entity(6, 15)];
      const mask = maskDetectedSpans(text, ruleEnts);
      // NER on the masked region itself
      const rawNer = [nerEntity(6, 13)];
      const result = unmaskNerEntities(
        rawNer,
        mask,
        ruleEnts,
        text,
      );
      expect(result).toHaveLength(0);
    },
  );

  test("keeps NER entity with no overlap", () => {
    const text = "Jan Novák born 1990-01-01";
    const ruleEnts = [entity(0, 9)];
    const mask = maskDetectedSpans(text, ruleEnts);
    // masked: "[MASKED] born 1990-01-01"
    //          012345678901234567890123
    // "1990-01-01" at 14..24 in masked
    const rawNer = [nerEntity(14, 24, "date")];
    const result = unmaskNerEntities(
      rawNer,
      mask,
      ruleEnts,
      text,
    );
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("date");
    expect(result[0].text).toBe("1990-01-01");
  });

  test("empty NER entities returns empty", () => {
    const text = "Hello world";
    const ruleEnts = [entity(0, 5)];
    const mask = maskDetectedSpans(text, ruleEnts);
    const result = unmaskNerEntities(
      [],
      mask,
      ruleEnts,
      text,
    );
    expect(result).toHaveLength(0);
  });
});
