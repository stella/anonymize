import { describe, expect, test } from "bun:test";

import { createPipelineContext, redactText, runPipeline } from "../../legacy";
import type { Dictionaries, Entity } from "../../types";
import {
  assertEntityInvariants,
  assertRedactionInvariants,
  assertSensitiveValuesRemoved,
} from "../assert-invariants";
import { contractTestConfig } from "../contract-config";
import { loadTestDictionaries } from "../load-dictionaries";

type ExpectedEntity = {
  label: string;
  text: string;
};

type EdgeFixture = {
  name: string;
  text: string;
  mustDetect?: readonly ExpectedEntity[];
  mustNotDetect?: readonly ExpectedEntity[];
  mustRedact?: readonly string[];
  mustPreserve?: readonly string[];
};

const FIXTURES: readonly EdgeFixture[] = [
  {
    name: "czech punctuation and address boundaries",
    text:
      'Smlouva uzavřená mezi "Žižkovská energie, a.s." a Janem Novákem.\n' +
      "Kontaktní e-mail: jan.novak@example.cz.\n" +
      "Adresa: Na Příkopě 12, 110 00 Praha 1.",
    mustDetect: [
      { label: "organization", text: "Žižkovská energie, a.s." },
      { label: "person", text: "Janem Novákem" },
      { label: "email address", text: "jan.novak@example.cz" },
      { label: "address", text: "Na Příkopě 12, 110 00 Praha 1" },
    ],
    mustRedact: [
      "Žižkovská energie, a.s.",
      "Janem Novákem",
      "jan.novak@example.cz",
      "Na Příkopě 12, 110 00 Praha 1",
    ],
  },
  {
    name: "line-wrapped legal form keeps the full organization",
    text:
      "The confirmations include transactions between the Company and " +
      "Goldman Sachs & Co.\nLLC. No broker is entitled to any fee.",
    mustDetect: [{ label: "organization", text: "Goldman Sachs & Co. LLC" }],
    mustNotDetect: [
      { label: "person", text: "Goldman" },
      { label: "person", text: "Goldman Sachs" },
    ],
    mustRedact: ["Goldman Sachs & Co."],
  },
  {
    name: "all-caps heading does not become an organization",
    text: "THIS AMENDMENT NO. 1 TO AMENDED AND RESTATED EMPLOYMENT AGREEMENT",
    mustNotDetect: [
      {
        label: "organization",
        text: "THIS AMENDMENT NO. 1 TO AMENDED AND RESTATED EMPLOYMENT AGREEMENT",
      },
    ],
    mustPreserve: ["AMENDED AND RESTATED EMPLOYMENT AGREEMENT"],
  },
  {
    name: "court-register section markers are not identifiers",
    text:
      "zapsaná v OR vedeném u Krajského soudu v Brně, oddíl C, " +
      "vložka 30549 a pod spisovou značkou Pr 5968",
    mustDetect: [
      { label: "organization", text: "Krajského soudu v Brně" },
      { label: "registration number", text: "oddíl C, vložka 30549" },
      { label: "registration number", text: "Pr 5968" },
    ],
    mustNotDetect: [{ label: "registration number", text: "C" }],
    mustRedact: ["Krajského soudu v Brně", "30549", "Pr 5968"],
  },
  {
    name: "compact json redacts values without damaging structure",
    text:
      '{"email":"ada@example.test","timestamp":"2026-06-19T10:30:00Z",' +
      '"path":"C:\\\\\\\\Users\\\\\\\\Public\\\\\\\\report.txt"}',
    mustDetect: [{ label: "email address", text: "ada@example.test" }],
    mustRedact: ["ada@example.test"],
    mustPreserve: [
      '"timestamp":"2026-06-19T10:30:00Z"',
      '"path":"C:\\\\\\\\Users\\\\\\\\Public\\\\\\\\report.txt"',
    ],
  },
  {
    name: "technical identifiers stay visible without PII context",
    text:
      "Trace 550e8400-e29b-41d4-a716-446655440000 at " +
      "2026-06-19T10:30:00Z on fe80::1 and path " +
      "C:\\\\modules\\\\jobs\\\\Task.",
    mustPreserve: [
      "550e8400-e29b-41d4-a716-446655440000",
      "2026-06-19T10:30:00Z",
      "fe80::1",
      "C:\\\\modules\\\\jobs\\\\Task",
    ],
  },
];

let dictionaries: Dictionaries | null = null;
const getDictionaries = async (): Promise<Dictionaries> => {
  dictionaries ??= await loadTestDictionaries();
  return dictionaries;
};

const hasEntity = (entities: readonly Entity[], expected: ExpectedEntity) =>
  entities.some(
    (entity) =>
      entity.label === expected.label && entity.text === expected.text,
  );

describe("contract edge fixtures", () => {
  for (const fixture of FIXTURES) {
    test(
      fixture.name,
      async () => {
        const context = createPipelineContext();
        const entities = await runPipeline({
          fullText: fixture.text,
          config: {
            ...contractTestConfig("contract-edge-fixtures-test"),
            dictionaries: await getDictionaries(),
          },
          gazetteerEntries: [],
          context,
        });

        assertEntityInvariants(fixture.text, entities);
        for (const expected of fixture.mustDetect ?? []) {
          expect(hasEntity(entities, expected)).toBe(true);
        }
        for (const expected of fixture.mustNotDetect ?? []) {
          expect(hasEntity(entities, expected)).toBe(false);
        }

        const result = redactText(fixture.text, entities, undefined, context);
        assertRedactionInvariants(entities, result);
        assertSensitiveValuesRemoved(
          result.redactedText,
          fixture.mustRedact ?? [],
        );
        for (const value of fixture.mustPreserve ?? []) {
          expect(result.redactedText).toContain(value);
        }
      },
      20_000,
    );
  }
});
