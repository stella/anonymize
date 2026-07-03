import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { createPipelineContext, redactText, runPipeline } from "../../legacy";
import type { CustomDenyListEntry, Dictionaries } from "../../types";
import {
  assertEntityInvariants,
  assertRedactionInvariants,
  assertSensitiveValuesRemoved,
} from "../assert-invariants";
import { contractTestConfig } from "../contract-config";
import { loadTestDictionaries } from "../load-dictionaries";

const GENERATED_TEXT_CHARS = [
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
  "b",
  "c",
  "d",
  "e",
  "n",
  "r",
  "s",
  "t",
  "0",
  "1",
  "2",
  "č",
  "ě",
  "ř",
  "á",
  "ü",
] as const;

const CUSTOM_LABELS = ["person", "organization", "address"] as const;

let dictionaries: Dictionaries | null = null;
const getDictionaries = async (): Promise<Dictionaries> => {
  dictionaries ??= await loadTestDictionaries();
  return dictionaries;
};

const generatedTextArb = fc
  .array(fc.constantFrom(...GENERATED_TEXT_CHARS), { maxLength: 280 })
  .map((chars) => chars.join(""));

const customValueFor = (label: string, index: number): string => {
  const suffix = String(index).padStart(2, "0");
  if (label === "organization") return `Fuzz Fixture ${suffix} s.r.o.`;
  if (label === "address") return `Fuzzova ${suffix}, 110 00 Praha`;
  return `Fuzz Person ${suffix}`;
};

const customDenyListCaseArb = fc
  .record({
    labels: fc.array(fc.constantFrom(...CUSTOM_LABELS), {
      minLength: 1,
      maxLength: 5,
    }),
    gaps: fc.array(generatedTextArb, { minLength: 2, maxLength: 6 }),
  })
  .map(({ labels, gaps }) => {
    let text = "";
    const entries: CustomDenyListEntry[] = [];
    const values: string[] = [];

    for (const [index, label] of labels.entries()) {
      text += gaps[index] ?? "";
      if (text.length > 0 && /[\p{L}\p{N}]$/u.test(text)) {
        text += " ";
      }
      const value = customValueFor(label, index);
      text += value;
      text += " ";
      entries.push({ value, label });
      values.push(value);
    }

    text += gaps.at(-1) ?? "";
    return { text, entries, values };
  });

describe("pipeline generated-input invariants", () => {
  test("generated text keeps entity and redaction invariants", async () => {
    const testDictionaries = await getDictionaries();

    await fc.assert(
      fc.asyncProperty(generatedTextArb, async (fullText) => {
        const context = createPipelineContext();
        const entities = await runPipeline({
          fullText,
          config: {
            ...contractTestConfig("pipeline-properties-test"),
            dictionaries: testDictionaries,
          },
          gazetteerEntries: [],
          context,
        });

        assertEntityInvariants(fullText, entities);
        assertRedactionInvariants(
          entities,
          redactText(fullText, entities, undefined, context),
        );
      }),
      { numRuns: 40, seed: 20_260_625 },
    );
  }, 40_000);

  test("caller-owned generated terms are detected and removed", async () => {
    await fc.assert(
      fc.asyncProperty(
        customDenyListCaseArb,
        async ({ text, entries, values }) => {
          const context = createPipelineContext();
          const entities = await runPipeline({
            fullText: text,
            config: {
              ...contractTestConfig("pipeline-custom-deny-list-properties"),
              customDenyList: entries,
              enableRegex: false,
              enableTriggerPhrases: false,
              enableLegalForms: false,
              enableNameCorpus: false,
              enableCoreference: false,
              enableConfidenceBoost: false,
              enableHotwordRules: false,
              enableZoneClassification: false,
            },
            gazetteerEntries: [],
            context,
          });

          assertEntityInvariants(text, entities);
          for (const value of values) {
            expect(entities.some((entity) => entity.text === value)).toBe(true);
          }

          const result = redactText(text, entities, undefined, context);
          assertRedactionInvariants(entities, result);
          assertSensitiveValuesRemoved(result.redactedText, values);
        },
      ),
      { numRuns: 60, seed: 20_260_626 },
    );
  }, 40_000);
});
