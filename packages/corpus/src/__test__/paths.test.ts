import { describe, expect, test } from "bun:test";

import { isValidRunName, rawFileName, runArtifactFileName } from "../paths";

describe("isValidRunName", () => {
  test("rejects path-traversal and separator names", () => {
    for (const name of ["../x", "..", ".", "a/b", "a\\b", "", "foo/../bar"]) {
      expect(isValidRunName(name)).toBe(false);
    }
  });

  test("accepts plain run names", () => {
    for (const name of ["abc123-dirty", "run.2", "no-git", "HEAD_1"]) {
      expect(isValidRunName(name)).toBe(true);
    }
  });
});

describe("rawFileName", () => {
  test("is stable for the same id", () => {
    expect(rawFileName("a:b")).toBe(rawFileName("a:b"));
  });

  test("disambiguates ids that sanitize to the same stem", () => {
    // `a:b` and `a_b` both collapse to the `a_b` stem; the id hash must keep
    // their file names distinct so one never overwrites the other.
    expect(rawFileName("a:b")).not.toBe(rawFileName("a_b"));
  });
});

describe("runArtifactFileName", () => {
  test("keeps same-content documents distinct", () => {
    expect(runArtifactFileName("accession-a", "same-sha")).not.toBe(
      runArtifactFileName("accession-b", "same-sha"),
    );
  });
});
