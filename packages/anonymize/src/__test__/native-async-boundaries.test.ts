import { expect, test } from "bun:test";

import { readNativePipelinePackageFileAsync } from "../native-node";
import { loadDefaultNativeBinding } from "../native-runtime";

const rejectionOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
};

test("native loader starts immediately and rejects synchronous loader failures", async () => {
  let attempts = 0;
  const loaded = loadDefaultNativeBinding({
    platform: "linux",
    arch: "x64",
    libc: "gnu",
    env: {},
    requireModule: () => {
      attempts += 1;
      throw new Error("synthetic native loader failure");
    },
  });

  expect(attempts).toBeGreaterThan(0);
  expect(loaded).toBeInstanceOf(Promise);
  expect(await rejectionOf(loaded)).toMatchObject({
    message: expect.stringContaining("Unable to load native anonymize binding"),
  });
});

test("asynchronous package reads reject missing paths", async () => {
  const read = readNativePipelinePackageFileAsync(
    `${import.meta.filename}/missing-package`,
  );
  expect(read).toBeInstanceOf(Promise);
  expect(await rejectionOf(read)).toBeInstanceOf(Error);
});
