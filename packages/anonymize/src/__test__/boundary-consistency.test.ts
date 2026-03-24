import { describe, expect, test } from "bun:test";

import { enforceBoundaryConsistency } from "../filters/boundary-consistency";
import type { Entity } from "../types";

const makeEntity = (
  label: string,
  start: number,
  end: number,
  text: string,
  score = 0.9,
): Entity => ({
  start,
  end,
  label,
  text,
  score,
  source: "ner",
});

describe("enforceBoundaryConsistency", () => {
  describe("adjacent same-label merging", () => {
    test("merges adjacent person entities", () => {
      const fullText = "Kontaktujte Jan Novák prosím.";
      //                          ^  ^^     ^
      //                         11 14 15   20
      const entities = [
        makeEntity("person", 12, 15, "Jan"),
        makeEntity("person", 16, 21, "Novák"),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.text).toBe("Jan Novák");
      expect(result[0]?.start).toBe(12);
      expect(result[0]?.end).toBe(21);
    });

    test("takes higher score when merging", () => {
      const fullText = "Jan Novák";
      const entities = [
        makeEntity("person", 0, 3, "Jan", 0.8),
        makeEntity("person", 4, 9, "Novák", 0.95),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.score).toBe(0.95);
    });

    test("does not merge different labels", () => {
      const fullText = "Jan Praha";
      const entities = [
        makeEntity("person", 0, 3, "Jan"),
        makeEntity("address", 4, 9, "Praha"),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      expect(result).toHaveLength(2);
    });

    test("does not merge when gap exceeds 3 chars", () => {
      const fullText = "Jan     Novák";
      const entities = [
        makeEntity("person", 0, 3, "Jan"),
        makeEntity("person", 8, 13, "Novák"),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      expect(result).toHaveLength(2);
    });

    test("merges entities separated by comma", () => {
      const fullText = "Novák, Jan";
      const entities = [
        makeEntity("person", 0, 5, "Novák"),
        makeEntity("person", 7, 10, "Jan"),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.text).toBe("Novák, Jan");
    });
  });

  describe("partial-word boundary fixing", () => {
    test("extends entity ending mid-word", () => {
      const fullText = "Kontaktujte Novák prosím.";
      // Entity ends at "Nová" (missing the "k")
      const entities = [
        makeEntity("person", 12, 16, "Nová"),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.text).toBe("Novák");
      expect(result[0]?.end).toBe(17);
    });

    test("extends entity starting mid-word", () => {
      const fullText = "Kontaktujte Novák prosím.";
      // Entity starts at "ová" (missing "N")
      const entities = [
        makeEntity("person", 13, 17, "ovák"),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.text).toBe("Novák");
      expect(result[0]?.start).toBe(12);
    });

    test("does not extend across newline", () => {
      const fullText = "line one\nNovák";
      // Entity starts in "one" and would cross newline
      const entities = [
        makeEntity("person", 5, 14, "one\nNovák"),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      // Should not extend left past the newline boundary
      // The entity start stays at word boundary of "one"
      expect(result[0]?.start).toBe(5);
    });
  });

  describe("nested same-label removal", () => {
    test("removes shorter nested same-label entity", () => {
      const fullText = "Ing. Pavel Novák";
      const entities = [
        makeEntity(
          "person",
          0,
          16,
          "Ing. Pavel Novák",
        ),
        makeEntity("person", 5, 10, "Pavel"),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.text).toBe("Ing. Pavel Novák");
    });

    test("keeps nested entity with different label", () => {
      const fullText = "Ing. Pavel Novák";
      const entities = [
        makeEntity(
          "person",
          0,
          16,
          "Ing. Pavel Novák",
        ),
        makeEntity("organization", 5, 10, "Pavel"),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      expect(result).toHaveLength(2);
    });

    test("keeps two non-overlapping same-label", () => {
      const fullText = "Jan Novák a Pavel Svoboda";
      const entities = [
        makeEntity("person", 0, 9, "Jan Novák"),
        makeEntity("person", 12, 25, "Pavel Svoboda"),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      expect(result).toHaveLength(2);
    });
  });
});
