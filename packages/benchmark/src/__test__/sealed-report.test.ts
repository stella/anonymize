import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  assertSealedAggregateReport,
  renderSealedAggregateMarkdown,
  SEALED_AGGREGATE_REPORT_SCHEMA_VERSION,
  type SealedAggregateReport,
  serializeSealedAggregateReport,
} from "../sealed-report";
import { parseVerifiedArtifact } from "../verified-artifact";
import { runSealedBoundary } from "../sealed-boundary";

const report = (): SealedAggregateReport => ({
  schemaVersion: SEALED_AGGREGATE_REPORT_SCHEMA_VERSION,
  createdAt: "2026-07-21T00:00:00.000Z",
  gitSha: "0123456",
  runtime: "Bun test",
  policy: "evaluation-only",
  corpus: {
    id: "tab-echr",
    source: "https://example.invalid/public-corpus",
    version: "pinned-version",
    file: "test.json",
    sha256: "a".repeat(64),
    license: "MIT",
    split: "test",
    documentCount: 127,
    selection: { type: "full-test-split" },
  },
  libraries: [
    {
      name: "stella",
      version: "test",
      status: "ok",
      elapsedSeconds: 1,
      metrics: {
        type: "tab-independent-annotator-span-redaction",
        documents: 127,
        directMentions: 10,
        quasiMentions: 20,
        directMentionRecall: 0.9,
        quasiMentionRecall: 0.8,
        allMentionRecall: 0.85,
        entityRecall: 0.75,
        characterPrecision: 0.7,
        characterRecall: 0.8,
        predictedSpans: 30,
      },
    },
  ],
});

describe("sealed aggregate report contract", () => {
  test("serializes one explicit aggregate-only schema", () => {
    const serialized = serializeSealedAggregateReport(report());
    const parsed: unknown = JSON.parse(serialized);
    expect(() => assertSealedAggregateReport(parsed)).not.toThrow();
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("serialized report must be an object");
    }
    expect(Object.keys(parsed)).toEqual([
      "schemaVersion",
      "createdAt",
      "gitSha",
      "runtime",
      "policy",
      "corpus",
      "libraries",
    ]);
    expect(renderSealedAggregateMarkdown(report())).toContain(
      "contains no source text, examples, categories, predictions, or per-document results",
    );
  });

  test("renders one value for every TAB table column", () => {
    const rows = renderSealedAggregateMarkdown(report())
      .split("\n")
      .filter((line) => line.startsWith("| "));
    expect(rows).toHaveLength(3);
    expect(rows.map((line) => line.split("|").slice(1, -1).length)).toEqual([
      9, 9, 9,
    ]);
  });

  test("rejects text, examples, predictions, and per-document fields at every report boundary", () => {
    const base = report();
    expect(() =>
      assertSealedAggregateReport({ ...base, text: "forbidden" }),
    ).toThrow("forbidden field text");
    expect(() =>
      assertSealedAggregateReport({
        ...base,
        libraries: [
          { ...base.libraries[0], predictions: [{ start: 0, end: 1 }] },
        ],
      }),
    ).toThrow("forbidden field predictions");
    const first = base.libraries.at(0);
    if (first?.status !== "ok")
      throw new Error("test report must be available");
    expect(() =>
      assertSealedAggregateReport({
        ...base,
        libraries: [
          {
            ...first,
            metrics: { ...first.metrics, perDocument: [] },
          },
        ],
      }),
    ).toThrow("forbidden field perDocument");
    expect(() =>
      assertSealedAggregateReport({
        ...base,
        corpus: { ...base.corpus, id: "meddocan" },
      }),
    ).toThrow("metrics do not match the corpus");
  });
});

describe("sealed artifact boundary", () => {
  test("does not invoke a parser until the pinned digest matches", async () => {
    const bytes = new TextEncoder().encode("public synthetic artifact");
    let parserCalls = 0;
    const parse = (): number => {
      parserCalls += 1;
      return parserCalls;
    };
    let mismatch: unknown;
    try {
      await parseVerifiedArtifact({
        bytes,
        expectedSha256: "0".repeat(64),
        name: "test artifact",
        parse,
      });
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch).toBeInstanceOf(Error);
    expect(String(mismatch)).toContain("checksum mismatch before parsing");
    expect(parserCalls).toBe(0);

    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const parsed = await parseVerifiedArtifact({
      bytes,
      expectedSha256,
      name: "test artifact",
      parse,
    });
    expect(parsed).toBe(1);
    expect(parserCalls).toBe(1);
  });

  test("suppresses corpus and adapter failure details", async () => {
    let failure: unknown;
    try {
      await runSealedBoundary("sealed test operation", () =>
        Promise.reject(
          new Error("forbidden document identifier and prediction"),
        ),
      );
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toBe(
      "Error: sealed test operation failed; sealed details suppressed",
    );
  });
});
