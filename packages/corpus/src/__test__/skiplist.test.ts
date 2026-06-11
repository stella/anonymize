import { describe, expect, test } from "bun:test";

import { mergeSkipEntries } from "../skiplist";
import type { SkipEntry } from "../types";

const skip = (id: string): SkipEntry => ({ id, reason: "size 42 chars" });

describe("mergeSkipEntries", () => {
  test("adds unknown ids and ignores known ones", () => {
    const existing = { entries: [skip("a")] };
    const { skipList, added } = mergeSkipEntries(existing, [
      skip("a"),
      skip("b"),
    ]);
    expect(added.map((e) => e.id)).toEqual(["b"]);
    expect(skipList.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  test("dedupes within the incoming batch", () => {
    const { added } = mergeSkipEntries({ entries: [] }, [skip("a"), skip("a")]);
    expect(added).toHaveLength(1);
  });

  test("does not mutate the input skip list", () => {
    const existing = { entries: [skip("a")] };
    mergeSkipEntries(existing, [skip("b")]);
    expect(existing.entries).toHaveLength(1);
  });
});
