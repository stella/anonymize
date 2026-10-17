import assert from "node:assert/strict";
import test from "node:test";

import {
  NATIVE_LIBRARY_FILES,
  assertBuiltCapabilities,
  nativeLibraryName,
  nativeLibcFromReport,
  readNativePackageInput,
} from "./native-script-contracts.mjs";

void test("native build libraries cover supported hosts and reject every other platform", () => {
  // The mapping owns the supported key set; new hosts cannot miss this coverage.
  for (const [platform, filename] of Object.entries(NATIVE_LIBRARY_FILES))
    assert.equal(nativeLibraryName(platform), filename);
  for (const platform of [
    "aix",
    "android",
    "freebsd",
    "haiku",
    "openbsd",
    "sunos",
    "netbsd",
    "cygwin",
    "constructor",
    "toString",
    "__proto__",
    "",
  ])
    assert.throws(
      () => nativeLibraryName(platform),
      /Unsupported native build platform/,
    );
});

void test("report libc detection validates the unknown header before consuming its glibc marker", () => {
  assert.equal(
    nativeLibcFromReport({ header: { glibcVersionRuntime: "2.36" } }),
    "gnu",
  );
  for (const report of [
    undefined,
    null,
    [],
    {},
    { header: null },
    { header: [] },
    { header: {} },
    { header: { glibcVersionRuntime: 2.36 } },
  ])
    assert.equal(nativeLibcFromReport(report), "musl");
});

void test("built capability assertions validate runtime values independently of declaration literals", () => {
  assert.doesNotThrow(() =>
    assertBuiltCapabilities({
      schemaVersion: 2,
      entities: [{ label: "person" }],
    }),
  );
  for (const manifest of [
    undefined,
    null,
    [],
    {},
    { schemaVersion: 1, entities: [{ label: "person" }] },
    { schemaVersion: 2, entities: [] },
    { schemaVersion: 2, entities: {} },
  ])
    assert.throws(
      () => assertBuiltCapabilities(manifest),
      /dist capability manifest/,
    );
});

void test("external package module exports preserve unknown configuration fields after envelope validation", () => {
  const config = {
    workspaceId: "package-input",
    labels: ["person"],
    threshold: 0.3,
  };
  const entries = [{ text: "Example Company", label: "organization" }];
  assert.deepEqual(readNativePackageInput(config), {
    config,
    gazetteerEntries: [],
  });
  const wrapped = readNativePackageInput({ config, gazetteerEntries: entries });
  assert.equal(wrapped.config, config);
  assert.equal(wrapped.gazetteerEntries, entries);
  assert.deepEqual(readNativePackageInput({ config, gazetteerEntries: null }), {
    config,
    gazetteerEntries: [],
  });
  for (const value of [
    undefined,
    null,
    [],
    false,
    "config",
    { config: null },
    { config: [] },
    { config, gazetteerEntries: "entries" },
  ])
    assert.throws(() => readNativePackageInput(value), TypeError);
});
