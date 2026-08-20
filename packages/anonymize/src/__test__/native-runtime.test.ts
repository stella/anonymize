import { expect, test } from "bun:test";

import {
  isBunRuntime,
  loadDefaultNativeBinding,
  preloadNativeBinding,
} from "../native-runtime";

test("Bun loads the native binding", async () => {
  expect(isBunRuntime()).toBe(true);
  const binding = await loadDefaultNativeBinding();
  expect(binding.nativePackageVersion()).not.toHaveLength(0);
  await preloadNativeBinding();
});

test("native runtime validates the requested binding version", async () => {
  let failure: unknown;
  try {
    await loadDefaultNativeBinding({
      expectedVersion: "0.0.0-test-mismatch",
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) {
    throw new Error("version mismatch did not produce an Error");
  }
  expect(failure.message).toContain("does not match 0.0.0-test-mismatch");
});
