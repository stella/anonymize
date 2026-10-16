import { expect, test } from "bun:test";

import { parseEvalHtmlArgs } from "./eval-html-args";

test("output requires a value before any document processing", () => {
  for (const prefix of [[], ["input.txt"], ["--watch", "input.txt"]]) {
    for (const suffix of [[], [""], ["", "another.txt"]]) {
      expect(() =>
        parseEvalHtmlArgs([...prefix, "--output", ...suffix]),
      ).toThrow("--output requires a non-empty path");
    }
  }
});

test("default output and ordered input paths are preserved", () => {
  expect(parseEvalHtmlArgs([])).toEqual({
    outputPath: "/tmp/eval-report.html",
    watchMode: false,
    inputs: [],
  });
  expect(parseEvalHtmlArgs(["one.txt", "two.txt"])).toEqual({
    outputPath: "/tmp/eval-report.html",
    watchMode: false,
    inputs: ["one.txt", "two.txt"],
  });
});

test("watch aliases and every nonempty output value retain their behavior", () => {
  for (const watch of ["--watch", "-w"]) {
    for (const output of ["report.html", "a report.html", "--watch"]) {
      expect(
        parseEvalHtmlArgs(["one.txt", watch, "--output", output, "two.txt"]),
      ).toEqual({
        outputPath: output,
        watchMode: true,
        inputs: ["one.txt", "two.txt"],
      });
    }
  }
  expect(
    parseEvalHtmlArgs([
      "--output",
      "first.html",
      "input.txt",
      "--output",
      "last.html",
    ]).outputPath,
  ).toBe("last.html");
});
