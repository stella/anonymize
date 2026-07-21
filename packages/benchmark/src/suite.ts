import { join } from "node:path";

import { BENCHMARK_CORPORA, validateBenchmarkRegistry } from "./suite/registry";

validateBenchmarkRegistry();

const runnableSealed = BENCHMARK_CORPORA.filter(
  ({ runnable, policy }) => runnable && policy === "evaluation-only",
);
process.stderr.write(
  `running sealed benchmark suite: ${runnableSealed.map(({ id }) => id).join(", ")}\n`,
);

for (const corpus of runnableSealed) {
  const execution = corpus.execution;
  if (execution === undefined) {
    throw new Error(`${corpus.id} has no sealed-suite execution`);
  }
  const { script, args } = execution;
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, script), ...args],
    {
      cwd: join(import.meta.dir, ".."),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${corpus.id} (${script}) failed with exit ${exitCode}`);
  }
}
