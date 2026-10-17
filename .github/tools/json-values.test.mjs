import assert from "node:assert/strict";
import test from "node:test";

import {
  parseJsonObject,
  parseNpmPack,
  parseStringList,
} from "./json-values.mjs";

void test("JSON metadata boundaries reject values outside their consumed shapes", () => {
  for (const value of [null, [], "object", 1, true])
    assert.throws(() => parseJsonObject(JSON.stringify(value)), TypeError);
  assert.deepEqual(parseJsonObject('{"private":false}'), { private: false });
  for (const value of [null, {}, ["path", 1], [false], [null]])
    assert.throws(() => parseStringList(JSON.stringify(value)), TypeError);
  assert.deepEqual(parseStringList('["one","two"]'), ["one", "two"]);
  assert.deepEqual(parseStringList("[]"), []);
});

void test("npm pack validates every file and finite nonnegative sizes", () => {
  const valid = {
    files: [{ path: "dist/index.mjs", size: 42 }],
    unpackedSize: 42,
  };
  assert.deepEqual(parseNpmPack(JSON.stringify([valid])), valid);
  for (const first of [
    null,
    {},
    { ...valid, files: null },
    { ...valid, files: [null] },
    { ...valid, files: [{ path: 42, size: 42 }] },
    { ...valid, files: [{ path: "one", size: "42" }] },
    { ...valid, files: [{ path: "one", size: -1 }] },
    { ...valid, unpackedSize: null },
    { ...valid, unpackedSize: -1 },
  ])
    assert.throws(() => parseNpmPack(JSON.stringify([first])), TypeError);
  for (const source of [
    "null",
    "{}",
    "[]",
    "[",
    '[{"files":[],"unpackedSize":1e999}]',
  ])
    assert.throws(() => parseNpmPack(source));
});
