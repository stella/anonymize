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
      //                         12 15 16   21
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

    test("collapses zero-gap entities via expansion + dedup", () => {
      const fullText = "JanNovák";
      const entities = [
        makeEntity("person", 0, 3, "Jan"),
        makeEntity("person", 3, 8, "Novák"),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      // Word boundary expansion makes both cover the
      // full word; deduplication collapses to one.
      expect(result).toHaveLength(1);
      expect(result[0]?.text).toBe("JanNovák");
    });

    test("merges partially overlapping same-label after expansion", () => {
      // After fixPartialWords, two entities may
      // partially overlap. mergeAdjacent must merge.
      const fullText = "the abc def ghi end";
      //                    ^      ^^      ^
      //                    4      11      15
      // "bc de" [5,10] -> expands to "abc def" [4,11]
      // "ef gh" [9,14] -> expands to "def ghi" [8,15]
      // overlap at [8,11]
      const entities = [
        makeEntity(
          "person", 5, 10,
          fullText.slice(5, 10),
        ),
        makeEntity(
          "person", 9, 14,
          fullText.slice(9, 14),
        ),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.start).toBe(4);
      expect(result[0]?.end).toBe(15);
      expect(result[0]?.text).toBe("abc def ghi");
    });

    test("does not merge same-label when gap contains non-whitespace", () => {
      // person "Jan" [0,3], address "x" [4,5],
      // person "Novák" [6,11]. The two person
      // entities should still be checked for
      // merging even though address sits between.
      const fullText = "Jan x Novák";
      const entities = [
        makeEntity("person", 0, 3, "Jan"),
        makeEntity("address", 4, 5, "x"),
        makeEntity("person", 6, 11, "Novák"),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      // Gap between persons is " x " (3 chars) but
      // contains "x" which is not in GAP_PATTERN,
      // so they should NOT merge.
      const persons = result.filter(
        (e) => e.label === "person",
      );
      expect(persons).toHaveLength(2);
    });

    test("does not merge when different-label occupies gap", () => {
      // Two person entities separated by a comma that
      // is itself tagged as punctuation. Merging them
      // would engulf the punctuation entity.
      const fullText = "Novák, Jan";
      const entities = [
        makeEntity("person", 0, 5, "Novák"),
        makeEntity("punctuation", 5, 6, ","),
        makeEntity("person", 7, 10, "Jan"),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      const persons = result.filter(
        (e) => e.label === "person",
      );
      const punct = result.find(
        (e) => e.label === "punctuation",
      );
      expect(persons).toHaveLength(2);
      expect(punct).toBeDefined();
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
      expect(result[0]?.start).toBe(0);
      expect(result[0]?.end).toBe(10);
    });

    test("does not merge entities across newline", () => {
      const fullText = "Jan\nNovák";
      const entities = [
        makeEntity("person", 0, 3, "Jan"),
        makeEntity("person", 4, 9, "Novák"),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      // Gap is "\n" which should NOT be merged
      expect(result).toHaveLength(2);
      expect(result[0]?.text).toBe("Jan");
      expect(result[1]?.text).toBe("Novák");
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

    test("does not extend across newline (LF)", () => {
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

    test("does not extend across newline (CRLF)", () => {
      const fullText = "line one\r\nNovák";
      // Entity that ends mid-word before CRLF
      const entities = [
        makeEntity("person", 5, 7, "on"),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      // Should expand to "one" but not cross \r\n
      expect(result[0]?.text).toBe("one");
      expect(result[0]?.end).toBe(8);
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

    test("deduplicates entities expanded to same span", () => {
      // Two partial entities that both expand to the
      // same word boundary should collapse into one.
      const fullText = "Kontaktujte Novák prosím.";
      const entities = [
        makeEntity("person", 12, 15, "Nov", 0.8),
        makeEntity("person", 14, 17, "vák", 0.9),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.text).toBe("Novák");
      // Higher score survives
      expect(result[0]?.score).toBe(0.9);
    });

    test("does not expand into different-label neighbor", () => {
      // Two touching entities of different labels.
      // Expansion must not cross into the neighbor's
      // span.
      const fullText = "JanPraha";
      // person "Jan" [0,3], address "Praha" [3,8] but
      // the word boundary is at 0 and 8 (single word).
      // Without clamping, both would expand to [0,8].
      const entities = [
        makeEntity("person", 0, 3, "Jan", 0.9),
        makeEntity("address", 3, 8, "Praha", 0.8),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      const person = result.find(
        (e) => e.label === "person",
      );
      const address = result.find(
        (e) => e.label === "address",
      );
      expect(person).toBeDefined();
      expect(address).toBeDefined();
      // No overlap
      expect(person!.end).toBeLessThanOrEqual(
        address!.start,
      );
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

    test("resolves cross-label overlap from gap expansion", () => {
      // Two different-label entities with a gap between
      // them in the same word. Both expand toward the
      // same word boundary, creating an overlap.
      // The higher-score entity keeps its boundary.
      const fullText = "JanXPraha";
      // person [0,3] "Jan", address [4,9] "Praha"
      // Both are partial words in "JanXPraha" (single
      // word boundary at 0 and 9). Clamping uses
      // original positions, so person expands right to
      // address.start=4, address expands left to
      // person.end=3. Result: person [0,4], address
      // [3,9] — overlap at [3,4]. The resolver must
      // trim one so no overlap remains.
      const entities = [
        makeEntity("person", 0, 3, "Jan", 0.9),
        makeEntity("address", 4, 9, "Praha", 0.8),
      ];
      const result = enforceBoundaryConsistency(
        entities,
        fullText,
      );
      const person = result.find(
        (e) => e.label === "person",
      );
      const address = result.find(
        (e) => e.label === "address",
      );
      expect(person).toBeDefined();
      expect(address).toBeDefined();
      // No overlap
      expect(person!.end).toBeLessThanOrEqual(
        address!.start,
      );
    });
  });
});
