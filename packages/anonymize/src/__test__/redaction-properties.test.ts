import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { deanonymise, redactText } from "../redact";
import { mergeAndDedup } from "../pipeline";
import type { Entity } from "../types";
import {
  assertEntityInvariants,
  assertRedactionInvariants,
  assertSensitiveValuesRemoved,
} from "./assert-invariants";

type GeneratedRedactionCase = {
  text: string;
  entities: Entity[];
  sensitiveValues: string[];
};

const PUBLIC_CHARS = [
  " ",
  "\t",
  "\n",
  "\r\n",
  ".",
  ",",
  ";",
  ":",
  "(",
  ")",
  '"',
  "'",
  "“",
  "”",
  " ",
  "a",
  "e",
  "i",
  "o",
  "u",
  "n",
  "r",
  "s",
  "t",
  "č",
  "ř",
  "á",
  "é",
] as const;

const ENTITY_LABELS = [
  "person",
  "organization",
  "email address",
  "phone number",
  "iban",
] as const;

const publicTextArb = fc
  .array(fc.constantFrom(...PUBLIC_CHARS), { maxLength: 32 })
  .map((chars) => chars.join(""));

const entityArb = fc.record({
  label: fc.constantFrom(...ENTITY_LABELS),
  prefix: publicTextArb,
});

const valueFor = (label: string, index: number): string => {
  const suffix = String(index).padStart(2, "0");
  if (label === "organization") return `Acme ${suffix} s.r.o.`;
  if (label === "email address") return `person.${suffix}@example.test`;
  if (label === "phone number") return `+420 777 000 ${suffix}`;
  if (label === "iban") return `CZ65080000001920001453${suffix}`;
  return `Test Person ${suffix}`;
};

const generatedCaseArb: fc.Arbitrary<GeneratedRedactionCase> = fc
  .record({
    entities: fc.array(entityArb, { minLength: 1, maxLength: 8 }),
    tail: publicTextArb,
  })
  .map(({ entities, tail }) => {
    let text = "";
    const generatedEntities: Entity[] = [];
    const sensitiveValues: string[] = [];

    for (const [index, generated] of entities.entries()) {
      text += generated.prefix;
      const value = valueFor(generated.label, index);
      const start = text.length;
      text += value;
      generatedEntities.push({
        start,
        end: start + value.length,
        label: generated.label,
        text: value,
        score: 0.99,
        source: "ner",
      });
      sensitiveValues.push(value);
    }

    text += tail;
    return { text, entities: generatedEntities, sensitiveValues };
  });

const SOURCE_TEXT =
  "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda " +
  "Mu Nu Xi Omicron Pi Rho Sigma Tau Upsilon Phi Chi Psi Omega " +
  "Na Prikope 12 Praha Acme Holdings LLC Jane Smith example@test.invalid";

const spanArb = fc
  .record({
    start: fc.integer({ min: 0, max: SOURCE_TEXT.length - 2 }),
    length: fc.integer({ min: 1, max: 36 }),
    label: fc.constantFrom(...ENTITY_LABELS),
    score: fc.integer({ min: 0, max: 100 }),
  })
  .map(({ start, length, label, score }) => {
    const end = Math.min(SOURCE_TEXT.length, start + length);
    return {
      start,
      end,
      label,
      text: SOURCE_TEXT.slice(start, end),
      score: score / 100,
      source: "ner",
    } satisfies Entity;
  });

describe("redaction properties", () => {
  test("replace redaction removes generated values and round-trips", () => {
    fc.assert(
      fc.property(generatedCaseArb, ({ text, entities, sensitiveValues }) => {
        assertEntityInvariants(text, entities);

        const result = redactText(text, entities);

        assertRedactionInvariants(entities, result);
        assertSensitiveValuesRemoved(result.redactedText, sensitiveValues);
        expect(deanonymise(result.redactedText, result.redactionMap)).toBe(
          text,
        );
      }),
      { numRuns: 100, seed: 20_260_623 },
    );
  });
});

describe("mergeAndDedup properties", () => {
  test("generated spans resolve to valid entities", () => {
    fc.assert(
      fc.property(
        fc.array(spanArb, { maxLength: 40 }),
        fc.array(spanArb, { maxLength: 40 }),
        (left, right) => {
          const merged = mergeAndDedup(left, right);
          assertEntityInvariants(SOURCE_TEXT, merged);
        },
      ),
      { numRuns: 100, seed: 20_260_624 },
    );
  });
});
