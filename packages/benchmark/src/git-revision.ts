const git = (args: readonly string[]): string => {
  try {
    const child = Bun.spawnSync(["git", ...args], { cwd: import.meta.dir });
    return child.success ? child.stdout.toString().trim() : "";
  } catch {
    return "";
  }
};

export const benchmarkGitRevision = (): string => {
  const sha = git(["rev-parse", "--short", "HEAD"]) || "no-git";
  const trackedChanges = git(["status", "--porcelain", "--untracked-files=no"]);
  return `${sha}${trackedChanges === "" ? "" : "-dirty"}`;
};
