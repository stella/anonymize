const inputBytes = Number.parseInt(process.argv.at(2) ?? "", 10);
if (!Number.isSafeInteger(inputBytes) || inputBytes <= 0) {
  throw new Error("worker requires a positive input byte count");
}

process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
const { buildPerformanceInput } = await import("./input");
const input = await buildPerformanceInput(inputBytes);
const initStartedMilliseconds = performance.now();
const { runPerformanceSample } = await import("./sample");
const sample = await runPerformanceSample({
  inputBytes,
  inputText: input.text,
  inputSha256: input.sha256,
  initStartedMilliseconds,
});
process.stdout.write(`${JSON.stringify({ type: "result", sample })}\n`);
