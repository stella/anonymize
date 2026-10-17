import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  copyPublishedFiles,
  parsePublishedFiles,
} from "./pruned-runtime-files.mjs";

/** @param {string[]} paths */
const packResult = (paths) =>
  JSON.stringify([{ files: paths.map((entry) => ({ path: entry })) }]);

void test("the complete actual npm pack file list is retained without extension filters", () => {
  const files = [
    "package.json",
    "dist/index.mjs",
    "dist/chunk.mjs",
    "native-libc.mjs",
    "future-root",
    "LICENSE",
    "native-pipeline.stlanonpkg",
    "scripts/command.mjs",
  ];
  assert.deepEqual(parsePublishedFiles(packResult(files)), files);
  for (const file of [
    "future.json",
    "new-helper.cjs",
    "nested/no-extension",
    "literal*.mjs",
  ])
    assert.deepEqual(parsePublishedFiles(packResult([...files, file])), [
      ...files,
      file,
    ]);
});

void test("absolute, escaping and ambiguous pack paths are rejected", () => {
  for (const file of [
    "",
    "/absolute",
    "../escape",
    "nested/../../escape",
    "C:/absolute",
    "C:\\absolute",
    "nested\\file",
    "nested//file",
    "./relative",
    "nested/./file",
    "bad\0file",
  ])
    assert.throws(
      () => parsePublishedFiles(packResult(["package.json", file])),
      /Invalid published/,
    );
});

void test("malformed or duplicate pack metadata cannot shrink the fixture silently", () => {
  for (const value of [
    null,
    {},
    [],
    [{ files: [] }],
    [{ files: [null] }],
    [{ files: [{ path: 1 }] }],
    [{ files: "invalid" }],
    [{ files: [] }, { files: [] }],
  ])
    assert.throws(() => parsePublishedFiles(JSON.stringify(value)));
  assert.throws(
    () => parsePublishedFiles(packResult(["package.json", "package.json"])),
    /Duplicate/,
  );
});

void test("all listed regular files are copied byte-for-byte including future roots and nested files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "anonymize-pruned-layout-"));
  try {
    const sourceRoot = path.join(root, "source");
    const targetRoot = path.join(root, "installed");
    const files = [
      "package.json",
      "native-libc.mjs",
      "future-root",
      "dist/chunk.mjs",
      "native-pipeline.stlanonpkg",
    ];
    for (const file of files) {
      const target = path.join(sourceRoot, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `fixture bytes: ${file}\0`);
    }
    copyPublishedFiles({
      sourceRoot,
      targetRoot,
      files: parsePublishedFiles(packResult(files)),
    });
    for (const file of files)
      assert.deepEqual(
        readFileSync(path.join(targetRoot, file)),
        readFileSync(path.join(sourceRoot, file)),
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("symlink files and ancestors cannot escape the copied package", () => {
  const root = mkdtempSync(path.join(tmpdir(), "anonymize-pruned-links-"));
  try {
    const sourceRoot = path.join(root, "source");
    const targetRoot = path.join(root, "installed");
    mkdirSync(sourceRoot);
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "helper.mjs"), "outside fixture");
    symlinkSync(
      path.join(outside, "helper.mjs"),
      path.join(sourceRoot, "helper.mjs"),
    );
    symlinkSync(outside, path.join(sourceRoot, "nested"), "dir");
    for (const file of ["helper.mjs", "nested/helper.mjs"])
      assert.throws(
        () => copyPublishedFiles({ sourceRoot, targetRoot, files: [file] }),
        /without symlinks/,
      );
    assert.throws(
      () => copyPublishedFiles({ sourceRoot, targetRoot, files: ["nested"] }),
      /regular file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
