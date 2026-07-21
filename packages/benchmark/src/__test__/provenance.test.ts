import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { benchmarkGitRevision } from "../git-revision";

const temporaryRepositories: string[] = [];

const git = (cwd: string, ...args: string[]): string => {
  const process = Bun.spawnSync(["git", ...args], { cwd });
  if (!process.success || process.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
  return process.stdout.toString().trim();
};

const repository = (): { readonly root: string; readonly sha: string } => {
  const root = mkdtempSync(join(tmpdir(), "anonymize-benchmark-provenance-"));
  temporaryRepositories.push(root);
  mkdirSync(join(root, "packages/benchmark/results/blind/redactionbench"), {
    recursive: true,
  });
  writeFileSync(
    join(root, ".gitignore"),
    "packages/benchmark/.venv-presidio\n",
  );
  writeFileSync(join(root, "source.ts"), "export const value = 1;\n");
  writeFileSync(
    join(
      root,
      "packages/benchmark/results/blind/redactionbench/committed.json",
    ),
    "{}\n",
  );
  git(root, "init", "--quiet");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Benchmark Test",
    "-c",
    "user.email=benchmark@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  return { root, sha: git(root, "rev-parse", "--short", "HEAD") };
};

afterEach(() => {
  for (const root of temporaryRepositories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("benchmark Git provenance", () => {
  test("ignores environments and untracked aggregate phase reports", () => {
    const { root, sha } = repository();
    symlinkSync(root, join(root, "packages/benchmark/.venv-presidio"));
    writeFileSync(
      join(root, "packages/benchmark/results/blind/2026-01-01.json"),
      "{}\n",
    );
    writeFileSync(
      join(
        root,
        "packages/benchmark/results/blind/redactionbench/2026-01-01.md",
      ),
      "aggregate\n",
    );

    expect(benchmarkGitRevision(root)).toBe(sha);
  });

  test("marks every other untracked file dirty", () => {
    const { root, sha } = repository();
    const source = join(root, "packages/benchmark/unreviewed.ts");
    writeFileSync(source, "export {};\n");
    expect(benchmarkGitRevision(root)).toBe(`${sha}-dirty`);
    unlinkSync(source);
    expect(benchmarkGitRevision(root)).toBe(sha);
  });

  test("marks tracked source and aggregate report modifications dirty", () => {
    const { root, sha } = repository();
    writeFileSync(join(root, "source.ts"), "export const value = 2;\n");
    expect(benchmarkGitRevision(root)).toBe(`${sha}-dirty`);
    git(root, "restore", "source.ts");
    writeFileSync(
      join(
        root,
        "packages/benchmark/results/blind/redactionbench/committed.json",
      ),
      '{"changed":true}\n',
    );
    expect(benchmarkGitRevision(root)).toBe(`${sha}-dirty`);
  });

  test("marks staged changes dirty", () => {
    const { root, sha } = repository();
    writeFileSync(join(root, "source.ts"), "export const value = 3;\n");
    git(root, "add", "source.ts");
    expect(benchmarkGitRevision(root)).toBe(`${sha}-dirty`);
  });
});
