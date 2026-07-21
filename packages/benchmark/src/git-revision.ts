const git = (
  cwd: string,
  args: readonly string[],
): { readonly ok: boolean; readonly stdout: Uint8Array } => {
  try {
    const child = Bun.spawnSync(["git", ...args], { cwd });
    return {
      ok: child.success && child.exitCode === 0,
      stdout: child.stdout ?? new Uint8Array(),
    };
  } catch {
    return { ok: false, stdout: new Uint8Array() };
  }
};

const text = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes).trim();

const GENERATED_AGGREGATE_REPORT =
  /^packages\/benchmark\/results\/blind\/(?:(redactionbench|meddocan)\/)?(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.(json|md)$/u;

const generatedAggregateReport = (
  root: string,
  path: string,
  expectedGitSha: string,
): boolean => {
  const match = GENERATED_AGGREGATE_REPORT.exec(path);
  if (match === null) return false;
  const suite = match[1];
  const stamp = match[2];
  if (stamp === undefined) return false;
  const prefix = `packages/benchmark/results/blind/${suite === undefined ? "" : `${suite}/`}${stamp}`;
  try {
    const json = readFileSync(join(root, `${prefix}.json`), "utf8");
    const markdown = readFileSync(join(root, `${prefix}.md`), "utf8");
    const report: unknown = JSON.parse(json);
    assertSealedAggregateReport(report);
    let expectedCorpus: "meddocan" | "redactionbench" | "tab-echr" = "tab-echr";
    if (suite === "redactionbench") expectedCorpus = "redactionbench";
    if (suite === "meddocan") expectedCorpus = "meddocan";
    return (
      report.corpus.id === expectedCorpus &&
      report.gitSha === expectedGitSha &&
      report.createdAt.replace(/[:.]/gu, "-") === stamp &&
      serializeSealedAggregateReport(report) === json &&
      renderSealedAggregateMarkdown(report) === markdown
    );
  } catch {
    return false;
  }
};

/** Ignore only new aggregate artifacts emitted by an earlier sealed phase. */
export const benchmarkGitRevision = (cwd: string = import.meta.dir): string => {
  const rootResult = git(cwd, ["rev-parse", "--show-toplevel"]);
  const shaResult = git(cwd, ["rev-parse", "--short", "HEAD"]);
  if (!rootResult.ok || !shaResult.ok) return "no-git";
  const root = text(rootResult.stdout);
  const sha = text(shaResult.stdout);
  if (root === "" || sha === "") return "no-git";

  const unstaged = git(root, ["diff", "--quiet", "--"]);
  const staged = git(root, ["diff", "--cached", "--quiet", "--"]);
  const untracked = git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (!unstaged.ok || !staged.ok || !untracked.ok) return `${sha}-dirty`;

  const relevantUntracked = new TextDecoder()
    .decode(untracked.stdout)
    .split("\0")
    .some((path) => path !== "" && !generatedAggregateReport(root, path, sha));
  return relevantUntracked ? `${sha}-dirty` : sha;
};
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertSealedAggregateReport,
  renderSealedAggregateMarkdown,
  serializeSealedAggregateReport,
} from "./sealed-report";
