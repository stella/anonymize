import { describe, expect, test } from "bun:test";

import { OPERATOR_TYPES } from "../constants";
import type { CanonicalStaticRedactionResult } from "../native";

import {
  createWasmBinding,
  isRawWasmModule,
  RAW_WASM_MODULE_FUNCTION_MEMBERS,
  RAW_WASM_PREPARED_SEARCH_FACTORY_MEMBERS,
  type RawWasmModule,
} from "../wasm-binding";

const unavailable = (): never => {
  throw new Error("not used by this test");
};

const fakeRawModule = (): RawWasmModule => {
  class PreparedSearch {}
  const WasmPreparedSearch = Object.assign(PreparedSearch, {
    fromConfigJsonBytes: unavailable,
    fromPreparedPackageBytes: unavailable,
    fromTrustedPreparedPackageBytes: unavailable,
  });
  return {
    default: async () => ({}),
    normalizeForSearch: (text) => text,
    nativePackageVersion: () => "test",
    externalDetectionLimitsJson: () => "{}",
    convertExternalDetectionBatchJson: () => "[]",
    extractDocxTextJson: () => "{}",
    rewriteDocxTextNative: (document) => ({
      document,
      rewrittenBlockCount: 0,
      appliedReplacementCount: 0,
    }),
    planDocxRestorationJson: () => "{}",
    inspectPdfJson: () => "{}",
    rewritePdfRasterFromDetectionsJson: (document) => ({
      document,
      certificateJson: "{}",
    }),
    prepareStaticSearchPackageBytes: (bytes) => bytes,
    prepareStaticSearchCompressedPackageBytes: (bytes) => bytes,
    assembleStaticSearchConfigJson: (bytes) => bytes,
    assembleStaticSearchPackageBytes: (bytes) => bytes,
    assembleStaticSearchCompressedPackageBytes: (bytes) => bytes,
    WasmPreparedSearch,
  };
};

describe("raw WASM binding invariants", () => {
  test("accepts the complete raw surface", () => {
    expect(isRawWasmModule(fakeRawModule())).toBe(true);
  });

  for (const member of RAW_WASM_MODULE_FUNCTION_MEMBERS) {
    test(`rejects a missing raw export: ${member}`, () => {
      expect(isRawWasmModule({ ...fakeRawModule(), [member]: undefined })).toBe(
        false,
      );
    });
  }

  for (const member of RAW_WASM_PREPARED_SEARCH_FACTORY_MEMBERS) {
    test(`rejects a missing prepared-search factory: ${member}`, () => {
      const raw = fakeRawModule();
      class PreparedSearch {}
      const factory = Object.assign(PreparedSearch, raw.WasmPreparedSearch, {
        [member]: undefined,
      });
      expect(isRawWasmModule({ ...raw, WasmPreparedSearch: factory })).toBe(
        false,
      );
    });
  }

  test("requires the prepared-search export to be a constructor", () => {
    const raw = fakeRawModule();
    expect(
      isRawWasmModule({
        ...raw,
        WasmPreparedSearch: { ...raw.WasmPreparedSearch },
      }),
    ).toBe(false);
  });
});

describe("WASM result and byte contracts", () => {
  test("rejects malformed PDF pixel page inputs before calling WASM", () => {
    const raw = fakeRawModule();
    let called = false;
    raw.rewritePdfRasterFromDetectionsJson = (document) => {
      called = true;
      return { document, certificateJson: "{}" };
    };
    const binding = createWasmBinding(raw);
    expect(() =>
      binding.rewritePdfRasterFromDetectionsJson(new Uint8Array(), "{}", [
        new ArrayBuffer(1),
      ] as unknown as Uint8Array[]),
    ).toThrow("pagePixels[0] must be a Uint8Array");
    expect(called).toBe(false);
  });

  test("normalizes every declared operator and rejects unknown values at the raw result boundary", () => {
    const text = "x".repeat(OPERATOR_TYPES.length);
    const result = {
      resolved_entities: OPERATOR_TYPES.map((_operator, index) => ({
        start: index,
        end: index + 1,
        label: "person",
        text: "x",
        score: 1,
        source: "regex",
      })),
      redaction: {
        redacted_text: OPERATOR_TYPES.map((operator) => `<${operator}>`).join(
          "",
        ),
        redaction_map: OPERATOR_TYPES.map((operator) => ({
          placeholder: `<${operator}>`,
          original: "x",
        })),
        operator_map: OPERATOR_TYPES.map((operator) => ({
          placeholder: `<${operator}>`,
          operator,
        })),
        entity_count: OPERATOR_TYPES.length,
      },
    } satisfies CanonicalStaticRedactionResult;
    const preparedForResult = (resultJson: string) => {
      const raw = fakeRawModule();
      raw.WasmPreparedSearch.fromConfigJsonBytes = () => ({
        prepareDiagnosticsJson: () => "{}",
        warmLazyRegex: () => undefined,
        warmLazyRegexDiagnosticsJson: () => "{}",
        createRedactionSession: unavailable,
        createRedactionSessionWithLifecycle: unavailable,
        restoreRedactionSession: unavailable,
        restoreEncryptedRedactionSession: unavailable,
        redactStaticEntitiesJson: () => resultJson,
        redactStaticEntitiesWithCallerDetectionsJson: () => resultJson,
        redactStaticEntitiesWithCallerDetectionsDiagnosticsJson: () => "{}",
        redactStaticEntitiesDiagnosticsJson: () => "{}",
        redactStaticEntitiesSummaryDiagnosticsJson: () => "{}",
        redactStaticEntitiesResultStreamJson: () => resultJson,
        redactStaticEntitiesDiagnosticsStreamJson: () => "{}",
      });
      return createWasmBinding(raw).NativePreparedSearch.fromConfigJsonBytes(
        new Uint8Array(),
      );
    };
    const prepared = preparedForResult(JSON.stringify(result));
    const normalized = prepared.redactStaticEntities(text);
    expect(normalized.redaction.operatorMap).toEqual(
      result.redaction.operator_map,
    );
    expect(
      normalized.redaction.operatorMap.map(({ operator }) => operator),
    ).toEqual([...OPERATOR_TYPES]);
    for (const [
      index,
      { operator },
    ] of result.redaction.operator_map.entries()) {
      const malformed = {
        ...result,
        redaction: {
          ...result.redaction,
          operator_map: result.redaction.operator_map.map((entry, position) =>
            position === index
              ? { placeholder: entry.placeholder, operator: "unknown" }
              : entry,
          ),
        },
      };
      expect(
        () =>
          preparedForResult(JSON.stringify(malformed)).redactStaticEntities(
            text,
          ),
        operator,
      ).toThrow("Invalid native CanonicalStaticRedactionResult");
    }
  });

  test("serializes typed caller detections only at the raw WASM boundary", () => {
    const raw = fakeRawModule();
    let requestJson = "";
    const resultJson = JSON.stringify({
      resolved_entities: [],
      redaction: {
        redacted_text: "text",
        redaction_map: [],
        operator_map: [],
        entity_count: 0,
      },
    });
    raw.WasmPreparedSearch.fromConfigJsonBytes = () => ({
      prepareDiagnosticsJson: () => "{}",
      warmLazyRegex: () => undefined,
      warmLazyRegexDiagnosticsJson: () => "{}",
      createRedactionSession: unavailable,
      createRedactionSessionWithLifecycle: unavailable,
      restoreRedactionSession: unavailable,
      restoreEncryptedRedactionSession: unavailable,
      redactStaticEntitiesJson: () => resultJson,
      redactStaticEntitiesWithCallerDetectionsJson: (
        _fullText,
        callerRequestJson,
      ) => {
        requestJson = callerRequestJson;
        return resultJson;
      },
      redactStaticEntitiesWithCallerDetectionsDiagnosticsJson: () => "{}",
      redactStaticEntitiesDiagnosticsJson: () => "{}",
      redactStaticEntitiesSummaryDiagnosticsJson: () => "{}",
      redactStaticEntitiesResultStreamJson: () => resultJson,
      redactStaticEntitiesDiagnosticsStreamJson: () => "{}",
    });
    const prepared = createWasmBinding(
      raw,
    ).NativePreparedSearch.fromConfigJsonBytes(new Uint8Array());

    const callerRequest = {
      version: 2,
      detections: [
        {
          start: 0,
          end: 4,
          label: "PERSON",
          score: 1,
          provider_id: "test",
          detection_id: "detection-1",
        },
      ],
    };
    const result = JSON.parse(
      prepared.redactStaticEntitiesWithCallerDetectionsJson("text", {
        requestJson: JSON.stringify(callerRequest),
      }),
    );

    expect(result.redaction.redacted_text).toBe("text");
    expect(JSON.parse(requestJson)).toEqual(callerRequest);
  });
});
