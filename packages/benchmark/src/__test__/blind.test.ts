import { describe, expect, test } from "bun:test";

import type { NativePrediction } from "../adapters/types";
import { parsePiiShieldEntities } from "../blind/pii-shield";
import { scoreBlindCorpus } from "../blind/score";
import { parseTabTestCorpus, selectBlindSample } from "../blind/tab";

const corpus = () => [
  {
    doc_id: "doc-b",
    dataset_type: "test",
    text: "Jane met Acme",
    annotations: {
      annotator1: {
        entity_mentions: [
          {
            entity_type: "PERSON",
            entity_id: "person-1",
            start_offset: 0,
            end_offset: 4,
            span_text: "Jane",
            identifier_type: "DIRECT",
          },
          {
            entity_type: "ORG",
            entity_id: "org-1",
            start_offset: 9,
            end_offset: 13,
            span_text: "Acme",
            identifier_type: "NO_MASK",
          },
        ],
      },
    },
  },
  {
    doc_id: "doc-a",
    dataset_type: "test",
    text: "Paris, 2 May",
    annotations: {
      annotator1: {
        entity_mentions: [
          {
            entity_type: "LOC",
            entity_id: "loc-1",
            start_offset: 0,
            end_offset: 5,
            span_text: "Paris",
            identifier_type: "QUASI",
          },
          {
            entity_type: "DATETIME",
            entity_id: "loc-1",
            start_offset: 7,
            end_offset: 12,
            span_text: "2 May",
            identifier_type: "QUASI",
          },
        ],
      },
    },
  },
];

describe("TAB holdout loading", () => {
  test("accepts only the test split and validates quoted spans", () => {
    const parsed = parseTabTestCorpus(corpus());
    expect(parsed).toHaveLength(2);
    expect(parsed.at(0)?.annotations.at(0)?.mentions.at(0)).toMatchObject({
      start: 0,
      end: 4,
      identifierType: "DIRECT",
    });

    const malformed = corpus();
    malformed[0]!.annotations.annotator1.entity_mentions[0]!.span_text = "John";
    expect(() => parseTabTestCorpus(malformed)).toThrow("stale mention span");
    expect(() => parseTabTestCorpus([null])).toThrow(
      "malformed or non-test document",
    );
    expect(() =>
      parseTabTestCorpus([
        {
          ...corpus()[0],
          annotations: { annotator1: { entity_mentions: [null] } },
        },
      ]),
    ).toThrow("invalid mention");
  });

  test("selects documents deterministically without consulting annotations", () => {
    const parsed = parseTabTestCorpus(corpus());
    expect(selectBlindSample(parsed, 1)).toEqual(selectBlindSample(parsed, 1));
  });
});

describe("PII-Shield output validation", () => {
  test("rejects malformed envelopes and span elements", () => {
    expect(() => parsePiiShieldEntities(null, "Jane", "doc-a")).toThrow(
      "malformed output",
    );
    expect(() =>
      parsePiiShieldEntities({ entities: [null] }, "Jane", "doc-a"),
    ).toThrow("invalid span");
  });
});

describe("blind masking metrics", () => {
  test("requires full mention and whole-entity coverage", () => {
    const documents = parseTabTestCorpus(corpus());
    const predictions = new Map<string, readonly NativePrediction[]>([
      ["doc-b", [{ start: 0, end: 4, label: "PERSON", text: "Jane" }]],
      [
        "doc-a",
        [
          { start: 0, end: 5, label: "LOC", text: "Paris" },
          { start: 7, end: 11, label: "DATE", text: "2 Ma" },
        ],
      ],
    ]);
    const score = scoreBlindCorpus(documents, predictions);
    expect(score.directMentionRecall).toBe(1);
    expect(score.quasiMentionRecall).toBe(0.5);
    expect(score.allMentionRecall).toBeCloseTo(2 / 3);
    expect(score.entityRecall).toBe(0.5);
    expect(score.characterPrecision).toBe(1);
    expect(score.characterRecall).toBeCloseTo(12 / 13);
  });

  test("charges masks over NO_MASK entities to character precision", () => {
    const documents = parseTabTestCorpus(corpus());
    const predictions = new Map<string, readonly NativePrediction[]>([
      [
        "doc-b",
        [
          { start: 0, end: 4, label: "PERSON", text: "Jane" },
          { start: 9, end: 13, label: "ORG", text: "Acme" },
        ],
      ],
    ]);
    expect(scoreBlindCorpus(documents, predictions).characterPrecision).toBe(
      0.5,
    );
  });

  test("scores annotator disagreement independently instead of as a union", () => {
    const documents = parseTabTestCorpus([
      {
        doc_id: "disputed",
        dataset_type: "test",
        text: "Jane",
        annotations: {
          annotator1: {
            entity_mentions: [
              {
                entity_type: "PERSON",
                entity_id: "person-1",
                start_offset: 0,
                end_offset: 4,
                span_text: "Jane",
                identifier_type: "DIRECT",
              },
            ],
          },
          annotator2: {
            entity_mentions: [
              {
                entity_type: "PERSON",
                entity_id: "person-1",
                start_offset: 0,
                end_offset: 4,
                span_text: "Jane",
                identifier_type: "NO_MASK",
              },
            ],
          },
        },
      },
    ]);
    const predictions = new Map<string, readonly NativePrediction[]>([
      ["disputed", [{ start: 0, end: 4, label: "PERSON", text: "Jane" }]],
    ]);
    const score = scoreBlindCorpus(documents, predictions);
    expect(score.directMentionRecall).toBe(1);
    expect(score.characterRecall).toBe(1);
    expect(score.characterPrecision).toBe(0.5);
  });
});
