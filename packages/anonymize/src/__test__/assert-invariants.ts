import { expect } from "bun:test";

import type { RedactionResult } from "../types";

// Structural minimums so the helpers accept both the legacy `Entity` shape
// and the native SDK's `NativePipelineEntity` (wider `label` / `source`)
// without importing either concrete type.
type SpanInvariant = {
  start: number;
  end: number;
  text: string;
  score: number;
};

export const collapseWhitespace = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

export const assertEntityInvariants = (
  fullText: string,
  entities: readonly SpanInvariant[],
): void => {
  let previousStart = 0;

  for (const entity of entities) {
    expect(entity.start).toBeGreaterThanOrEqual(previousStart);
    expect(entity.start).toBeGreaterThanOrEqual(0);
    expect(entity.end).toBeLessThanOrEqual(fullText.length);
    expect(entity.start).toBeLessThan(entity.end);
    expect(collapseWhitespace(fullText.slice(entity.start, entity.end))).toBe(
      collapseWhitespace(entity.text),
    );
    expect(entity.score).toBeGreaterThanOrEqual(0);
    expect(entity.score).toBeLessThanOrEqual(1);

    previousStart = entity.start;
  }
};

export const assertRedactionInvariants = (
  entities: readonly unknown[],
  result: RedactionResult,
): void => {
  expect(result.entityCount).toBeLessThanOrEqual(entities.length);
  expect(typeof result.redactedText).toBe("string");

  for (const [placeholder, original] of result.redactionMap) {
    expect(original.length).toBeGreaterThan(0);
    expect(result.redactedText).toContain(placeholder);
  }
};

export const assertSensitiveValuesRemoved = (
  redactedText: string,
  sensitiveValues: readonly string[],
): void => {
  for (const value of sensitiveValues) {
    if (value.length === 0) continue;
    expect(redactedText).not.toContain(value);
  }
};
