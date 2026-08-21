/**
 * Smoke test against the built artifact. The regression suite
 * imports from src, so it cannot see failures that only exist in
 * the bundled output (e.g. an import the bundler could not
 * resolve). This script imports the published entrypoints the way a
 * package consumer does and fails when the native package path is not
 * usable from the built output.
 *
 * Run after `bun run build`: `bun run smoke:dist`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createPipelineContext,
  getDefaultNativePipeline,
  redactDefaultText,
} from "../dist/index.mjs";
import { CAPABILITY_MANIFEST } from "../dist/capabilities.mjs";
import { createNativeAnonymizerFromPackage } from "../dist/native.mjs";
import {
  createNativePipelineFromDefaultPackage,
  createNativePipelineFromPackageFile,
  loadNativeAnonymizeBinding,
} from "../dist/native-node.mjs";

if (typeof globalThis.Bun === "undefined") {
  throw new Error("dist native smoke must run under Bun");
}
if (typeof createNativeAnonymizerFromPackage !== "function") {
  throw new TypeError("dist native entrypoint is missing its package loader");
}
if (typeof loadNativeAnonymizeBinding !== "function") {
  throw new TypeError("dist native-node entrypoint is missing its loader");
}
if (typeof createNativePipelineFromPackageFile !== "function") {
  throw new TypeError("dist native-node entrypoint is missing file loading");
}
if (typeof createNativePipelineFromDefaultPackage !== "function") {
  throw new TypeError(
    "dist native-node entrypoint is missing default package loading",
  );
}
if (typeof getDefaultNativePipeline !== "function") {
  throw new TypeError(
    "dist root entrypoint is missing default pipeline loader",
  );
}
if (typeof redactDefaultText !== "function") {
  throw new TypeError(
    "dist root entrypoint is missing native redaction helper",
  );
}
if (typeof createPipelineContext !== "function") {
  throw new TypeError("dist root entrypoint is missing its pipeline context");
}
if (createPipelineContext().nativePipelinePackage !== null) {
  throw new TypeError("dist pipeline context did not start empty");
}
if (
  CAPABILITY_MANIFEST.schemaVersion !== 2 ||
  CAPABILITY_MANIFEST.entities.length === 0
) {
  throw new TypeError("dist capability manifest is missing or invalid");
}

const binding = loadNativeAnonymizeBinding();
const nativePackageVersion = binding.nativePackageVersion();
if (nativePackageVersion.length === 0) {
  throw new Error("native binding did not report its package version");
}

const nativePipeline = createNativePipelineFromDefaultPackage();
const nativeResult = nativePipeline.redactText(
  "A contract was signed by Jan Novak at Praha on 1. 1. 2025.",
);
if (nativeResult.resolvedEntities.length === 0) {
  throw new Error("default native pipeline package did not detect any entity");
}

const session = nativePipeline.createRedactionSession("smoke_1");
const sessionResult = session.redactText("A contract was signed by Jan Novak.");
if (sessionResult.redaction.redactionMap.size === 0) {
  throw new Error("native redaction session did not retain any mapping");
}
session.redactText("Jan Novak signed the second contract.");
if (session.mappingCount() !== 1) {
  throw new Error("native redaction session did not reuse its mapping");
}
const sessionState = session.toPlaintextJson();
const restoredSession = nativePipeline.restoreRedactionSession(sessionState);
if (restoredSession.sessionId() !== "smoke_1") {
  throw new Error("native redaction session did not restore its identity");
}
const lifecycleSession = nativePipeline.createRedactionSessionWithLifecycle({
  sessionId: "lifecycle_smoke_1",
  createdAtEpochSeconds: 100,
  expiresAtEpochSeconds: 200,
});
lifecycleSession.redactTextAt({
  fullText: "Jan Novak signed.",
  observedAtEpochSeconds: 150,
});
if (lifecycleSession.inspect(200).status !== "expired") {
  throw new Error("native lifecycle session did not expire at its boundary");
}
if (lifecycleSession.delete().deletedMappingCount !== 1) {
  throw new Error("native lifecycle deletion did not report its mapping count");
}
if (lifecycleSession.inspect().status !== "deleted") {
  throw new Error("native lifecycle session did not remain deleted");
}

console.log(
  JSON.stringify({
    event: "dist-smoke",
    javascriptRuntime: `Bun ${globalThis.Bun.version}`,
    nativePackageVersion,
    ok: true,
    nativeEntityCount: nativeResult.resolvedEntities.length,
    sessionMappingCount: session.mappingCount(),
  }),
);

const runStandaloneSmoke = async () => {
  const buildDir = mkdtempSync(path.join(tmpdir(), "anonymize-bun-build-"));
  const runDir = mkdtempSync(path.join(tmpdir(), "anonymize-bun-run-"));

  try {
    const entrypoint = path.join(buildDir, "entry.mjs");
    const executable = path.join(
      buildDir,
      process.platform === "win32" ? "anonymize-smoke.exe" : "anonymize-smoke",
    );
    const distEntrypoint = path.resolve(
      import.meta.dirname,
      "../dist/index.mjs",
    );

    writeFileSync(
      entrypoint,
      `
        import {
          createPipelineContext,
          loadNativeAnonymizeBinding,
        } from ${JSON.stringify(distEntrypoint)};

        const context = createPipelineContext();
        const version = loadNativeAnonymizeBinding().nativePackageVersion();
        if (context.nativePipelinePackage !== null || version.length === 0) {
          throw new Error("standalone native contract failed");
        }
        console.log(version);
      `,
    );

    const standaloneBuild = await Bun.build({
      compile: { outfile: executable },
      entrypoints: [entrypoint],
      target: "bun",
    });
    if (!standaloneBuild.success) {
      throw new Error(
        `standalone compile failed: ${standaloneBuild.logs.join("\n")}`,
      );
    }

    const subprocess = Bun.spawn([executable], {
      cwd: runDir,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`standalone native smoke failed: ${stderr.trim()}`);
    }
    if (stdout.trim() !== nativePackageVersion) {
      throw new Error(
        `standalone native smoke returned ${stdout.trim()}; expected ${nativePackageVersion}`,
      );
    }
    console.log(`Bun standalone native smoke ok: ${stdout.trim()}`);
  } finally {
    rmSync(buildDir, { force: true, recursive: true });
    rmSync(runDir, { force: true, recursive: true });
  }
};

await runStandaloneSmoke();
