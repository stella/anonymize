import { describe, expect, test } from "bun:test";

import { decodeSpans } from "../gliner/decoder";
import { prepareSpans } from "../gliner/processor";

describe("decodeSpans overlap semantics", () => {
  test("keeps adjacent half-open spans (touching is not overlapping)", () => {
    // "AliceBob": word0 = "Alice" [0,5), word1 = "Bob" [5,8).
    // The two spans touch at char 5 but do not overlap, so both
    // entities must survive greedy selection.
    const text = "AliceBob";
    const batchWordsStartIdx = [[0, 5]];
    const batchWordsEndIdx = [[5, 8]];
    const idToClass = { 1: "person" };
    // batchSize=1, inputLength=2 words, maxWidth=1, numEntities=1.
    // modelOutput length = 1*2*1*1 = 2; both logits high.
    const modelOutput = [10, 10];

    const result = decodeSpans(
      1,
      2,
      1,
      1,
      [text],
      [0],
      batchWordsStartIdx,
      batchWordsEndIdx,
      idToClass,
      modelOutput,
      true, // flatNer
      0.5, // threshold
      false, // multiLabel
    );

    const spanTexts = (result[0] ?? []).map((span) => span[0]).toSorted();
    expect(spanTexts).toEqual(["Alice", "Bob"]);
  });
});

describe("prepareSpans mask", () => {
  test("marks spans that overrun the sequence as invalid", () => {
    // 3 tokens, maxWidth 3. A span starting at word i with width j
    // covers words i..i+j and is valid iff i + j < len (3).
    const { spanMasks } = prepareSpans([["a", "b", "c"]], 3);
    const mask = spanMasks[0] ?? [];

    const expected: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expected.push(i + j < 3);
      }
    }

    expect(mask).toEqual(expected);
    // Sanity: at least one span overruns and is masked out.
    expect(mask).toContain(false);
  });
});
