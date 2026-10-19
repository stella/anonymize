import { describe, expect, test } from "bun:test";

const loadWorkflow = async (path: string) =>
  Bun.YAML.parse(await Bun.file(path).text());

describe("merge queue workflow contracts", () => {
  test("ci-result depends on every other CI job", async () => {
    const workflow = await loadWorkflow(".github/workflows/ci.yml");
    const jobNames = Object.keys(workflow.jobs);
    const ciResult = workflow.jobs["ci-result"];

    expect(ciResult.if).toBe("always()");
    expect(new Set(ciResult.needs)).toEqual(
      new Set(jobNames.filter((jobName) => jobName !== "ci-result")),
    );
  });

  test("CI and CLA run for merge groups", async () => {
    const ci = await loadWorkflow(".github/workflows/ci.yml");
    const cla = await loadWorkflow(".github/workflows/cla.yml");

    expect(ci.on.merge_group.types).toEqual(["checks_requested"]);
    expect(cla.on.merge_group.types).toEqual(["checks_requested"]);
  });
});
