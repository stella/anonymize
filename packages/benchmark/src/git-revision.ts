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
  /^packages\/benchmark\/results\/blind\/(?:redactionbench\/|meddocan\/)?[^/]+\.(?:json|md)$/u;

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
    .some((path) => path !== "" && !GENERATED_AGGREGATE_REPORT.test(path));
  return relevantUntracked ? `${sha}-dirty` : sha;
};
