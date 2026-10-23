import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";

import { parseNativePreparedSearchConfig } from "../native-config-codec";
import { isRecord } from "../native-json-codec";
import * as results from "../native-result-codec";
import { nativeConfigFixture } from "./fixtures/native-config-codec";

type Cases = {
  [Name in keyof typeof results]: {
    decode: (typeof results)[Name];
    fixture: ReturnType<(typeof results)[Name]>;
  };
};

const cases = {
  parseCanonicalStaticRedactionResult: {
    decode: results.parseCanonicalStaticRedactionResult,
    fixture: {
      resolved_entities: [
        {
          start: 0,
          end: 1,
          label: "person",
          text: "x",
          score: 1,
          source: "regex",
          source_detail: "example",
          provider_id: null,
          detection_id: null,
        },
      ],
      redaction: {
        redacted_text: "[person]",
        redaction_map: [{ placeholder: "[person]", original: "x" }],
        operator_map: [{ placeholder: "[person]", operator: "replace" }],
        entity_count: 1,
      },
    },
  },
  parseCanonicalSessionMetadata: {
    decode: results.parseCanonicalSessionMetadata,
    fixture: {
      session_id: "session",
      created_at_epoch_seconds: 1,
      expires_at_epoch_seconds: null,
      mapping_count: 1,
      status: "active",
    },
  },
  parseCanonicalSessionDeletionSummary: {
    decode: results.parseCanonicalSessionDeletionSummary,
    fixture: { session_id: "session", deleted_mapping_count: 1 },
  },
  parseCanonicalSessionRedactionPlanResult: {
    decode: results.parseCanonicalSessionRedactionPlanResult,
    fixture: [
      {
        replacements: [{ start: 0, end: 1, replacement: "[person]" }],
        entity_count: 1,
        caller_entity_count: 0,
      },
    ],
  },
  parseExternalDetections: {
    decode: results.parseExternalDetections,
    fixture: [
      {
        start: 0,
        end: 1,
        label: "person",
        score: 1,
        provider_id: "example",
        detection_id: "1",
      },
    ],
  },
} satisfies Cases;

const leafPaths = (value: unknown, path: string[] = []): string[][] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry: unknown, index: number) =>
      leafPaths(entry, [...path, String(index)]),
    );
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, entry]) =>
      leafPaths(entry, [...path, key]),
    );
  }
  return [path];
};

const replaceAt = (value: unknown, path: string[]): unknown => {
  const [head, ...rest] = path;
  if (head === undefined) return { invalid: [] };
  if (Array.isArray(value)) {
    return value.map((entry: unknown, index: number) =>
      String(index) === head ? replaceAt(entry, rest) : entry,
    );
  }
  if (!isRecord(value))
    throw new Error("Mutation path must follow the fixture shape");
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === head ? replaceAt(entry, rest) : entry,
    ]),
  );
};

describe("native JSON boundaries", () => {
  for (const [name, { decode, fixture }] of Object.entries(cases)) {
    test(`${name} preserves validated values and rejects every malformed leaf`, () => {
      expect(decode(JSON.stringify(fixture))).toEqual(fixture);
      const paths = leafPaths(fixture);
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(
          () => decode(JSON.stringify(replaceAt(fixture, path))),
          path.join("."),
        ).toThrow(TypeError);
      }
      for (const malformed of ["{", "null", "1", '"text"', "{}"]) {
        expect(() => decode(malformed)).toThrow();
      }
    });
  }

  test("prepared search config validates every nested leaf without changing output", () => {
    expect(
      parseNativePreparedSearchConfig(JSON.stringify(nativeConfigFixture)),
    ).toEqual(nativeConfigFixture);
    const paths = leafPaths(nativeConfigFixture);
    expect(paths.length).toBeGreaterThan(100);
    for (const path of paths) {
      expect(
        () =>
          parseNativePreparedSearchConfig(
            JSON.stringify(replaceAt(nativeConfigFixture, path)),
          ),
        path.join("."),
      ).toThrow(TypeError);
    }
  });

  test("prepared config defaults match the native deserializer", () => {
    const minimal = {
      regex_patterns: [],
      custom_regex_patterns: [],
      literal_patterns: [],
      regex_options: {},
      custom_regex_options: {},
      literal_options: {},
      allowed_labels: [],
      threshold: 0,
      confidence_boost: false,
      slices: {
        regex: { start: 0, end: 0 },
        custom_regex: { start: 0, end: 0 },
        deny_list: { start: 0, end: 0 },
        gazetteer: { start: 0, end: 0 },
        countries: { start: 0, end: 0 },
      },
      regex_meta: [],
      custom_regex_meta: [],
    } satisfies ReturnType<typeof parseNativePreparedSearchConfig>;
    expect(parseNativePreparedSearchConfig(JSON.stringify(minimal))).toEqual(
      minimal,
    );
    const defaults = parseNativePreparedSearchConfig("{}");
    expect(defaults).toEqual({ ...minimal, slices: {} });
    for (const key of Object.keys(defaults)) {
      const malformed = { ...defaults, [key]: null };
      if (
        ["regex_options", "custom_regex_options", "literal_options"].includes(
          key,
        )
      ) {
        expect(
          parseNativePreparedSearchConfig(JSON.stringify(malformed)),
        ).toEqual(defaults);
      } else {
        expect(
          () => parseNativePreparedSearchConfig(JSON.stringify(malformed)),
          key,
        ).toThrow(TypeError);
      }
    }
  });

  test("every native optional lane accepts null across subsets", () => {
    const rust = readFileSync(
      new URL(
        "../../../../crates/anonymize-adapter-contract/src/types.rs",
        import.meta.url,
      ),
      "utf8",
    );
    const optionalFields = (name: string) => {
      const body = rust.split(`pub struct ${name} {`).at(1)?.split("\n}").at(0);
      if (body === undefined) throw new Error(`Missing native struct ${name}`);
      return Array.from(
        body.matchAll(/pub (\w+): Option</gu),
        (match) => match.at(1) ?? "",
      );
    };
    const rootFields = optionalFields("BindingPreparedSearchConfig");
    const sliceFields = optionalFields("BindingPreparedSearchSlices");
    expect(rootFields.length).toBeGreaterThan(15);
    expect(sliceFields).toHaveLength(9);
    fc.assert(
      fc.property(
        fc.subarray(rootFields),
        fc.subarray(sliceFields),
        (rootAbsent, sliceAbsent) => {
          const wire = {
            ...nativeConfigFixture,
            ...Object.fromEntries(rootAbsent.map((key) => [key, null])),
            slices: {
              ...nativeConfigFixture.slices,
              ...Object.fromEntries(sliceAbsent.map((key) => [key, null])),
            },
          };
          const decoded = parseNativePreparedSearchConfig(JSON.stringify(wire));
          for (const key of rootAbsent) {
            expect(Object.hasOwn(decoded, key)).toBe(
              [
                "regex_options",
                "custom_regex_options",
                "literal_options",
              ].includes(key),
            );
          }
          for (const key of sliceAbsent)
            expect(Object.hasOwn(decoded.slices, key)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("closed session status rejects unknown values and accepts every declared state", () => {
    const metadata = cases.parseCanonicalSessionMetadata.fixture;
    for (const status of [
      "active",
      "not_yet_active",
      "expired",
      "deleted",
    ] as const) {
      expect(
        results.parseCanonicalSessionMetadata(
          JSON.stringify({ ...metadata, status }),
        ).status,
      ).toBe(status);
    }
    expect(() =>
      results.parseCanonicalSessionMetadata(
        JSON.stringify({ ...metadata, status: "other" }),
      ),
    ).toThrow(TypeError);
  });
});
