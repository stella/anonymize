import { describe, expect, test } from "bun:test";
import {
  filterFalsePositives,
  initAddressComponents,
} from "../false-positives";
import type { Entity } from "../../types";

const person = (text: string): Entity => ({
  start: 0,
  end: text.length,
  label: "person",
  text,
  score: 0.9,
  source: "ner",
});

const triggerAddress = (text: string): Entity => ({
  start: 0,
  end: text.length,
  label: "address",
  text,
  score: 0.9,
  source: "trigger",
});

describe("person entities containing digits", () => {
  test("rejects person with digits", () => {
    const result = filterFalsePositives([person("Solution Pack ABL90 Flex")]);
    expect(result).toHaveLength(0);
  });

  test("rejects person with trailing number", () => {
    const result = filterFalsePositives([person("Model X7")]);
    expect(result).toHaveLength(0);
  });

  test("keeps person without digits", () => {
    const result = filterFalsePositives([person("Jan Novák")]);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("Jan Novák");
  });
});

describe("street-type fallback for direct callers", () => {
  test("keeps digitless trigger-sourced address after warm-up", async () => {
    await initAddressComponents();
    const result = filterFalsePositives([triggerAddress("Via Roma")]);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("Via Roma");
  });
});
