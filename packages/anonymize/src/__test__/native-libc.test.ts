import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { detectNativeLibc } from "../../native-libc.mjs";

test.each(["2.17", "2.28", "2.31", "2.35", "2.39", "2.40", "2.41"])(
  "Linux glibc runtime version %s selects GNU",
  (glibcVersionRuntime) => {
    expect(
      detectNativeLibc("linux", () => ({ header: { glibcVersionRuntime } })),
    ).toBe("gnu");
  },
);

test.each([
  { arch: "x64", loader: "/lib/ld-musl-x86_64.so.1" },
  { arch: "arm64", loader: "/lib/ld-musl-aarch64.so.1" },
])(
  "Linux musl diagnostic report %j selects musl without a glibc field",
  ({ arch, loader }) => {
    const report = {
      header: {
        reportVersion: 5,
        event: "JavaScript API",
        trigger: "GetReport",
        nodejsVersion: "v26.10.0",
        arch,
        platform: "linux",
        osName: "Linux",
        osRelease: "6.12.0",
      },
      sharedObjects: [loader],
    };
    expect(detectNativeLibc("linux", () => report)).toBe("musl");
  },
);

test.each(
  [
    undefined,
    null,
    false,
    0,
    "not a report",
    [],
    {},
    { header: undefined },
    { header: null },
    { header: [] },
    { header: "not a header" },
    { header: 0 },
    { header: {} },
    { header: { glibcVersionRuntime: undefined } },
    { header: { glibcVersionRuntime: null } },
    { header: { glibcVersionRuntime: "" } },
    { header: { glibcVersionRuntime: false } },
    { header: { glibcVersionRuntime: 2.35 } },
    { header: { glibcVersionRuntime: ["2.35"] } },
    { header: { glibcVersionRuntime: {} } },
  ].map((report) => ({ report })),
)("Linux report %j cannot establish a glibc runtime", ({ report }) => {
  expect(detectNativeLibc("linux", () => report)).toBe("musl");
});

test("Linux classification reads its report exactly once", () => {
  let reads = 0;
  const detected = detectNativeLibc("linux", () => {
    reads += 1;
    return { header: { glibcVersionRuntime: "2.39" } };
  });
  expect(detected).toBe("gnu");
  expect(reads).toBe(1);
});

test.each(["darwin", "win32", "freebsd", "android", "unknown", ""])(
  "platform %s does not read a Linux report",
  (platform) => {
    let reads = 0;
    expect(
      detectNativeLibc(platform, () => {
        reads += 1;
        throw new Error("a non-Linux target must not read the host report");
      }),
    ).toBeUndefined();
    expect(reads).toBe(0);
  },
);

test("report reader failures propagate the original Error object", () => {
  const failure = new Error("synthetic diagnostic report failure");
  let observed: unknown;
  try {
    detectNativeLibc("linux", () => {
      throw failure;
    });
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(failure);
});

test("a fresh Node process imports the detector without reading a report or loading SDK artifacts", () => {
  const module = new URL("../../native-libc.mjs", import.meta.url);
  const result = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `
    import process from "node:process";
    process.report.getReport = () => { throw new Error("report read during import"); };
    const { detectNativeLibc } = await import(process.argv[1]);
    if (detectNativeLibc("darwin") !== undefined) throw new Error("unexpected non-Linux result");
    let reads = 0;
    process.report.getReport = () => {
      reads += 1;
      return { header: { glibcVersionRuntime: "2.39" } };
    };
    if (detectNativeLibc("linux") !== "gnu" || reads !== 1) {
      throw new Error("default Linux reader must read the Node report exactly once");
    }
  `,
      module.href,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
