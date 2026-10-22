import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { library } from "@stll/oxlint-config";
import {
  portableSafetyPluginSpecifiers,
  portableSafetyRules,
} from "@stll/oxlint-plugin";

import config from "../../oxlint.config";

const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("uses shared library defaults and the complete portable safety pack", async () => {
  expect(config.rules).toMatchObject(portableSafetyRules);
  expect(config.options?.reportUnusedDisableDirectives).toBe("error");
  expect(read("oxlint.config.ts")).not.toContain('"off"');
  expect(config.jsPlugins).toEqual([
    ...(library().jsPlugins ?? []),
    ...portableSafetyPluginSpecifiers,
    "./oxlint.plugin.ts",
  ]);
  // Select the environment of the complete program: shipped Node adapters,
  // Bun benchmark/corpus programs, and runtime-neutral dictionary data.
  const environments = new Map(
    Object.entries({
      "packages/anonymize/tsconfig.json": "node",
      "packages/benchmark/tsconfig.json": "bun",
      "packages/cli/tsconfig.json": "node",
      "packages/corpus/tsconfig.json": "bun",
      "packages/data/tsconfig.json": "library",
      "packages/document-docx/tsconfig.json": "node",
      "packages/document-pdf/tsconfig.json": "node",
      "packages/mcp/tsconfig.json": "node",
    }),
  );
  const projects = [...new Bun.Glob("packages/*/tsconfig.json").scanSync()];
  expect(projects.toSorted()).toEqual([...environments.keys()].toSorted());
  for (const path of projects) {
    const environment = environments.get(path);
    if (environment === undefined)
      throw new Error(`Unclassified program: ${path}`);
    const tsconfig = await Bun.file(path).json();
    const preset = `@stll/typescript-config/${environment}.json`;
    expect(tsconfig.extends).toBe(preset);
    expect(Object.keys(tsconfig.compilerOptions ?? {})).toEqual(
      path === "packages/anonymize/tsconfig.json"
        ? ["customConditions", "lib"]
        : [],
    );
    const manifest = await Bun.file(
      path.replace("tsconfig.json", "package.json"),
    ).json();
    expect(manifest.devDependencies["@stll/typescript-config"]).toBe("0.8.0");
    expect(
      Bun.resolveSync(preset, path.replace("tsconfig.json", "")),
    ).toContain("@stll");
  }
});

test("test and tool programs use the shared Bun environment", async () => {
  for (const path of [
    "packages/anonymize/tsconfig.test.json",
    "packages/cli/tsconfig.test.json",
    "packages/mcp/tsconfig.test.json",
    "packages/document-docx/tsconfig.test.json",
    "packages/document-pdf/tsconfig.test.json",
    "packages/data/__test__/tsconfig.json",
    "packages/data/scripts/tsconfig.json",
    "packages/anonymize/scripts/tsconfig.json",
    "packages/mcp/scripts/tsconfig.json",
    "packages/mcp/test-fixtures/tsconfig.json",
  ]) {
    const tsconfig = await Bun.file(path).json();
    expect(tsconfig.extends).toBe("@stll/typescript-config/bun.json");
    if (path === "packages/anonymize/tsconfig.test.json") {
      expect(tsconfig.compilerOptions).toEqual({
        customConditions: ["@stll/anonymize-source"],
      });
    } else {
      expect(tsconfig.compilerOptions).toBeUndefined();
    }
  }
});

test("declares runtime-only generated cloud setup with Rust checks", () => {
  const toolchain = JSON.parse(read("stll-toolchain.json"));
  expect(toolchain.cloud.install).toBe("bun install --frozen-lockfile");
  const rust = Bun.TOML.parse(read("rust-toolchain.toml"));
  expect(rust.toolchain.components).toEqual(["rustfmt", "clippy"]);
  expect(rust.toolchain.targets).toEqual(["wasm32-unknown-unknown"]);
  const script = read(".agents/cloud-setup.sh");
  expect(script).toContain("Generated");
  expect(script).toContain(read(".node-version").trim());
  expect(script).toContain("install --frozen-lockfile");
  expect(script).not.toContain(".env.cloud");
  const settings = JSON.parse(read(".claude/settings.json"));
  expect(settings.hooks.SessionStart).toHaveLength(1);
});

test("workspaces importing Node modules declare their own Node types", () => {
  const owners = new Set<string>();
  for (const file of new Bun.Glob(
    "packages/*/{src,scripts}/**/*.{ts,mts,cts,mjs}",
  ).scanSync()) {
    if (!/\b(?:from\s*|import\s*\()\s*["']node:/u.test(read(file))) continue;
    const owner = file.split("/").slice(0, 2).join("/");
    owners.add(owner);
    const manifest = JSON.parse(read(`${owner}/package.json`));
    expect(manifest.devDependencies["@types/node"], owner).toBeDefined();
    expect(
      Bun.resolveSync("@types/node/package.json", `${process.cwd()}/${owner}`),
    ).toContain("@types");
  }
  expect(owners.has("packages/anonymize")).toBe(true);
  expect(owners.has("packages/data")).toBe(true);
});

test("keeps third-party quarantine and exact first-party tooling exemptions", () => {
  const bunfig = Bun.TOML.parse(read("bunfig.toml"));
  expect(bunfig.install.minimumReleaseAge).toBe(432_000);
  expect(bunfig.install.linker).toBe("isolated");
  const exceptions = bunfig.install.minimumReleaseAgeExcludes;
  for (const name of [
    "@stll/oxlint-config",
    "@stll/oxlint-plugin",
    "@stll/typescript-config",
  ]) {
    expect(exceptions).toContain(name);
  }
  expect(
    exceptions.every(
      (name: string) => name.startsWith("@stll/") && !name.includes("*"),
    ),
  ).toBe(true);
});

test("pins the shared quarantine workflows and prunes daily", () => {
  const sharedWorkflowRef = "df2659b7ccaa9cb69e69a99787fd4e2180db5893";
  const policy = read(".github/workflows/quarantine-policy.yml");
  const prune = read(".github/workflows/quarantine-prune.yml");
  expect(policy).toContain(
    `uses: stella/.github/.github/workflows/quarantine-policy.yml@${sharedWorkflowRef}`,
  );
  expect(policy).not.toMatch(/^\s+schedule:/mu);
  expect(prune).toContain(
    `uses: stella/.github/.github/workflows/quarantine-prune.yml@${sharedWorkflowRef}`,
  );
  expect(prune.match(/^\s+- cron: "11 4 \* \* \*"$/gmu)).toHaveLength(1);
  expect(prune.match(/^\s+- cron:/gmu)).toHaveLength(1);
});

test("every first-party quarantine exemption carries an exact UTC annotation", () => {
  const source = read("bunfig.toml");
  const parsed = Bun.TOML.parse(source);
  const entries = Array.from(
    source.matchAll(
      /^\s*"(?<name>@stll\/[^"*]+)"\s*,?\s*#\s*quarantine-excluded-since:\s*(?<timestamp>\S+)\s*$/gm,
    ),
  );
  const names = entries.map((entry) => {
    const name = entry.groups?.name;
    if (name === undefined) throw new Error("Missing exemption package name");
    return name;
  });
  const exclusions: unknown = parsed.install.minimumReleaseAgeExcludes;
  if (
    !Array.isArray(exclusions) ||
    !exclusions.every((entry: unknown) => typeof entry === "string")
  )
    throw new Error("Quarantine exclusions must be package names");
  const compare = (left: string, right: string) => left.localeCompare(right);
  expect(names.toSorted(compare)).toEqual(exclusions.toSorted(compare));
  for (const entry of entries) {
    const timestamp = entry.groups?.timestamp;
    if (timestamp === undefined) throw new Error("Missing exemption timestamp");
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
    expect(Date.parse(timestamp)).toBeLessThanOrEqual(Date.now());
  }
});
