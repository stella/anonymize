import { describe, expect, test } from "bun:test";

import {
  buildPlaceholderMap,
  deanonymise,
  exportRedactionKey,
  redactText,
} from "../redact";
import type { Entity } from "../types";

/** Build a detected entity for the first occurrence of `value`. */
const at = (fullText: string, label: string, value: string): Entity => {
  const start = fullText.indexOf(value);
  if (start < 0) {
    throw new Error(`fixture bug: "${value}" not found in test text`);
  }
  return {
    start,
    end: start + value.length,
    label,
    text: value,
    score: 0.99,
    source: "ner",
  };
};

describe("redactText / deanonymise round-trip", () => {
  test("replace operator restores the original text exactly", () => {
    const text = "Contact Alice Smith at alice@example.com or Bob Jones.";
    const entities = [
      at(text, "person", "Alice Smith"),
      at(text, "email address", "alice@example.com"),
      at(text, "person", "Bob Jones"),
    ];

    const result = redactText(text, entities);

    expect(result.redactedText).not.toContain("Alice Smith");
    expect(result.redactedText).not.toContain("alice@example.com");
    expect(result.redactedText).toContain("[PERSON_1]");
    expect(result.redactedText).toContain("[PERSON_2]");
    expect(result.redactedText).toContain("[EMAIL_ADDRESS_1]");

    const restored = deanonymise(result.redactedText, result.redactionMap);
    expect(restored).toBe(text);
  });

  test("repeated occurrences of the same value share one placeholder", () => {
    const value = "Alice Smith";
    const text = `${value} called. Later, ${value} left.`;
    const first = text.indexOf(value);
    const second = text.indexOf(value, first + 1);
    const entities: Entity[] = [first, second].map((start) => ({
      start,
      end: start + value.length,
      label: "person",
      text: value,
      score: 0.99,
      source: "ner",
    }));

    const result = redactText(text, entities);
    expect(result.redactedText).toBe(text.replaceAll(value, "[PERSON_1]"));
    expect(deanonymise(result.redactedText, result.redactionMap)).toBe(text);
  });

  test("case/format variants normalize to a single placeholder", () => {
    const text = "Mail Alice@Example.com and alice@example.com.";
    const entities = [
      at(text, "email address", "Alice@Example.com"),
      at(text, "email address", "alice@example.com"),
    ];

    const result = redactText(text, entities);
    expect(result.redactionMap.size).toBe(1);
    expect([...result.redactionMap.keys()]).toEqual(["[EMAIL_ADDRESS_1]"]);
  });

  test("literal placeholder-like source text is not deanonymised", () => {
    const text = "Keep [PERSON_1]; Alice Smith signs.";
    const entities = [at(text, "person", "Alice Smith")];

    const result = redactText(text, entities);

    expect(result.redactedText).toBe("Keep [PERSON_1]; [PERSON_2] signs.");
    expect([...result.redactionMap.keys()]).toEqual(["[PERSON_2]"]);
    expect(deanonymise(result.redactedText, result.redactionMap)).toBe(text);
  });

  test("literal placeholders inside extra brackets are reserved", () => {
    const text = "Keep [[PERSON_1]]; Alice Smith signs.";
    const entities = [at(text, "person", "Alice Smith")];

    const result = redactText(text, entities);

    expect(result.redactedText).toBe("Keep [[PERSON_1]]; [PERSON_2] signs.");
    expect([...result.redactionMap.keys()]).toEqual(["[PERSON_2]"]);
    expect(deanonymise(result.redactedText, result.redactionMap)).toBe(text);
  });

  test("repeated values share the first non-colliding placeholder", () => {
    const value = "Alice Smith";
    const text = `Existing [PERSON_1]. ${value} called. ${value} signed.`;
    const first = text.indexOf(value);
    const second = text.indexOf(value, first + 1);
    const entities: Entity[] = [first, second].map((start) => ({
      start,
      end: start + value.length,
      label: "person",
      text: value,
      score: 0.99,
      source: "ner",
    }));

    const result = redactText(text, entities);

    expect(result.redactedText).toBe(
      "Existing [PERSON_1]. [PERSON_2] called. [PERSON_2] signed.",
    );
    expect(result.redactionMap.get("[PERSON_2]")).toBe(value);
    expect(deanonymise(result.redactedText, result.redactionMap)).toBe(text);
  });
});

describe("operator behavior", () => {
  test("redact operator is irreversible: no redaction-map entry", () => {
    const text = "Contact Alice Smith at alice@example.com.";
    const entities = [
      at(text, "person", "Alice Smith"),
      at(text, "email address", "alice@example.com"),
    ];

    const result = redactText(text, entities, {
      operators: { person: "redact" },
      redactString: "[GONE]",
    });

    expect(result.redactedText).toContain("[GONE]");
    expect(result.redactedText).not.toContain("Alice Smith");
    // Person was redacted (irreversible) — not in the reversible map.
    expect(result.redactionMap.has("[PERSON_1]")).toBe(false);
    // Email still uses the default replace operator (reversible).
    expect(result.redactionMap.has("[EMAIL_ADDRESS_1]")).toBe(true);
  });

  test("keep operator preserves text without a reversible mapping", () => {
    const text = "Contact Alice Smith at alice@example.com.";
    const entities = [
      at(text, "person", "Alice Smith"),
      at(text, "email address", "alice@example.com"),
    ];

    const result = redactText(text, entities, {
      operators: { person: "keep" },
      redactString: "[REDACTED]",
    });

    expect(result.redactedText).toBe(
      "Contact Alice Smith at [EMAIL_ADDRESS_1].",
    );
    expect(result.entityCount).toBe(2);
    expect(result.redactionMap.has("[PERSON_1]")).toBe(false);
    expect(result.operatorMap.get("[PERSON_1]")).toBe("keep");
  });
});

describe("exportRedactionKey", () => {
  test("serializes placeholder -> { original, operator }", () => {
    const text = "Contact Alice Smith.";
    const entities = [at(text, "person", "Alice Smith")];
    const result = redactText(text, entities);

    const parsed = JSON.parse(
      exportRedactionKey(result.redactionMap, result.operatorMap),
    ) as { entries: Record<string, { original: string; operator: string }> };

    expect(parsed.entries["[PERSON_1]"]).toEqual({
      original: "Alice Smith",
      operator: "replace",
    });
  });
});

describe("buildPlaceholderMap", () => {
  test("assigns one placeholder per distinct value, numbered per label", () => {
    const text = "Alice Smith, Bob Jones, and Alice Smith.";
    const value = "Alice Smith";
    const second = text.indexOf("Bob Jones");
    const third = text.indexOf(value, text.indexOf(value) + 1);
    const entities: Entity[] = [
      at(text, "person", value),
      {
        start: second,
        end: second + "Bob Jones".length,
        label: "person",
        text: "Bob Jones",
        score: 0.99,
        source: "ner",
      },
      {
        start: third,
        end: third + value.length,
        label: "person",
        text: value,
        score: 0.99,
        source: "ner",
      },
    ];

    const map = buildPlaceholderMap(entities);
    expect(map.get("person\0Alice Smith")).toBe("[PERSON_1]");
    expect(map.get("person\0Bob Jones")).toBe("[PERSON_2]");
  });

  test("skips placeholders already present in reserved text", () => {
    const text = "[PERSON_1], [PERSON_2], Alice Smith, and Bob Jones.";
    const entities = [
      at(text, "person", "Alice Smith"),
      at(text, "person", "Bob Jones"),
    ];

    const map = buildPlaceholderMap(entities, undefined, {
      reservedText: text,
    });

    expect(map.get("person\0Alice Smith")).toBe("[PERSON_3]");
    expect(map.get("person\0Bob Jones")).toBe("[PERSON_4]");
  });
});
