import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import rootPackage from "../../package.json";

const packagePaths = rootPackage.workspaces.flatMap((pattern) => [
  ...new Bun.Glob(`${pattern}/package.json`).scanSync(),
]);

test("diagnostic parity covers every checked workspace configuration", async () => {
  const projects = [];
  for (const path of packagePaths) {
    const packageJson = await Bun.file(path).json();
    const typecheck = packageJson.scripts?.typecheck;
    if (typecheck === undefined) continue;
    for (const command of typecheck.split(" && ")) {
      const match = /^bun check --no-pretty --all --project=(\S+)$/.exec(
        command,
      );
      const project = match?.at(1);
      if (project === undefined)
        throw new Error(`Unrecognized typecheck command: ${command}`);
      projects.push(join(dirname(path), project));
    }
  }
  expect(projects.length).toBeGreaterThan(0);
  expect(rootPackage.scripts["check:typecheck-parity"]).toBe(
    [
      "bun test ./.github/tools/typecheck-policy.test.ts && stll-typecheck-parity",
      ...projects
        .toSorted((left, right) => left.localeCompare(right))
        .map((project) => `--project ${project}`),
    ].join(" "),
  );
});
