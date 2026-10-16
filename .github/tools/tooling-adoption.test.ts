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
  for (const path of new Bun.Glob("packages/*/tsconfig.json").scanSync()) {
    const tsconfig = await Bun.file(path).json();
    expect(tsconfig.extends).toBe("@stll/typescript-config/library.json");
    expect(Object.keys(tsconfig.compilerOptions ?? {})).toEqual(
      path === "packages/anonymize/tsconfig.json" ? ["lib"] : [],
    );
    const manifest = await Bun.file(
      path.replace("tsconfig.json", "package.json"),
    ).json();
    expect(manifest.devDependencies["@stll/typescript-config"]).toBe("0.8.0");
    expect(
      Bun.resolveSync(
        "@stll/typescript-config/library.json",
        path.replace("tsconfig.json", ""),
      ),
    ).toContain("@stll");
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
  if (!Array.isArray(exclusions) || !exclusions.every((entry: unknown) => typeof entry === "string"))
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
