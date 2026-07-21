import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";

import type { NativePrediction } from "../adapters/types";
import {
  BENCHMARK_CORPORA,
  validateBenchmarkRegistry,
} from "../suite/registry";
import { parseRedactionBenchRows } from "../suite/redactionbench";
import { scoreRedactionBench } from "../suite/redactionbench-score";
import { parseMeddocanArchive } from "../suite/meddocan";
import { scoreSpanCorpus } from "../suite/span-score";

const rows = () => [
  {
    raw_text: "Jane at Acme",
    spans: [
      { start: 0, end: 4, label: "mandatory" },
      { start: 8, end: 12, label: "contextual" },
    ],
    category: "legal",
    genre: "contract",
    is_synthetic: true,
    original_document_url: null,
  },
];

describe("benchmark suite registry", () => {
  test("keeps development and sealed tasks explicit", () => {
    expect(() => validateBenchmarkRegistry()).not.toThrow();
    expect(
      BENCHMARK_CORPORA.some(
        ({ id, policy }) =>
          id === "tab-echr-development" && policy === "development",
      ),
    ).toBe(true);
    expect(BENCHMARK_CORPORA.some(({ id }) => id === "tab-echr")).toBe(true);
    expect(BENCHMARK_CORPORA.some(({ id }) => id === "meddocan")).toBe(true);
    expect(BENCHMARK_CORPORA.every(({ access }) => access !== undefined)).toBe(
      true,
    );
    expect(
      BENCHMARK_CORPORA.filter(
        ({ runnable, policy }) => runnable && policy === "evaluation-only",
      ).map(({ execution }) => execution?.script),
    ).toEqual(["blind.ts", "redactionbench.ts", "meddocan.ts"]);
  });
});

describe("MEDDOCAN normalization", () => {
  test("loads paired BRAT text and annotations", () => {
    const archive = zipSync({
      "meddocan/test/brat/example.txt": strToU8("María"),
      "meddocan/test/brat/example.ann": strToU8(
        "T1\tNOMBRE_SUJETO_ASISTENCIA 0 5\tMaría\n",
      ),
    });
    expect(parseMeddocanArchive(archive, 1)).toEqual([
      {
        id: "example",
        text: "María",
        spans: [{ label: "NOMBRE_SUJETO_ASISTENCIA", start: 0, end: 5 }],
      },
    ]);
  });
});

describe("span-corpus metrics", () => {
  test("reports zero precision when an adapter masks nothing", () => {
    const score = scoreSpanCorpus(
      [{ id: "doc", text: "Jane", spans: [{ start: 0, end: 4 }] }],
      new Map(),
    );
    expect(score.spanRecall).toBe(0);
    expect(score.characterRecall).toBe(0);
    expect(score.characterPrecision).toBe(0);
  });
});

describe("RedactionBench normalization and interim metrics", () => {
  test("validates half-open mandatory and contextual spans", () => {
    const documents = parseRedactionBenchRows(rows());
    expect(documents.at(0)?.id).toBe("legal/contract");
    expect(documents.at(0)?.spans).toHaveLength(2);
    expect(() =>
      parseRedactionBenchRows([
        { ...rows()[0], spans: [{ start: 0, end: 99, label: "mandatory" }] },
      ]),
    ).toThrow("invalid span");
  });

  test("requires full mandatory spans but accepts contextual masks", () => {
    const documents = parseRedactionBenchRows(rows());
    const predictions = new Map<string, readonly NativePrediction[]>([
      [
        "legal/contract",
        [
          { start: 0, end: 3, label: "person", text: "Jan" },
          { start: 8, end: 12, label: "organization", text: "Acme" },
        ],
      ],
    ]);
    const score = scoreRedactionBench(documents, predictions);
    expect(score.mandatorySpanRecall).toBe(0);
    expect(score.mandatoryCharacterRecall).toBe(0.75);
    expect(score.acceptedCharacterPrecision).toBe(1);
  });
});
