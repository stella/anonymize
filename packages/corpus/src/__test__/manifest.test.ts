import { describe, expect, test } from "bun:test";

import { mergeManifestEntries } from "../manifest";
import type { ManifestEntry } from "../types";

const entry = (id: string): ManifestEntry => ({
  id,
  source: "edgar",
  url: `https://www.sec.gov/Archives/edgar/data/1/${id}`,
  query: "employment agreement",
  language: "en",
  sha256: `sha-${id}`,
  fetchedAt: "2026-06-11T00:00:00.000Z",
});

describe("mergeManifestEntries", () => {
  test("adds unknown ids and skips known ones", () => {
    const existing = { entries: [entry("a")] };
    const { manifest, added, skipped } = mergeManifestEntries(existing, [
      entry("a"),
      entry("b"),
    ]);
    expect(added.map((e) => e.id)).toEqual(["b"]);
    expect(skipped.map((e) => e.id)).toEqual(["a"]);
    expect(manifest.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  test("dedupes within the incoming batch", () => {
    const { added } = mergeManifestEntries({ entries: [] }, [
      entry("a"),
      entry("a"),
    ]);
    expect(added).toHaveLength(1);
  });

  test("does not mutate the input manifest", () => {
    const existing = { entries: [entry("a")] };
    mergeManifestEntries(existing, [entry("b")]);
    expect(existing.entries).toHaveLength(1);
  });
});
