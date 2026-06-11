import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(60_000);

const CLI = new URL("../cli.ts", import.meta.url).pathname;

// Public, minimal fixture: example.com address and the
// standard IBAN test number.
const SAMPLE =
  "Please contact Jan Novák at jan.novak@example.com. " +
  "Pay to IBAN DE89 3704 0044 0532 0130 00.";

// Scope dictionaries to keep test startup small.
const SCOPE = ["--countries", "CZ,DE", "--languages", "cs,en"];

type RunResult = { out: string; err: string; code: number };

const run = async (args: string[], stdin?: string): Promise<RunResult> => {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
};

test("replaces PII from stdin with placeholders", async () => {
  const { out, code } = await run([...SCOPE, "--quiet"], SAMPLE);
  expect(code).toBe(0);
  expect(out).not.toContain("jan.novak@example.com");
  expect(out).not.toContain("DE89 3704 0044 0532 0130 00");
  expect(out).toContain("[EMAIL_ADDRESS_1]");
  expect(out).toContain("[IBAN_1]");
});

test("redaction key round-trips losslessly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
  const inputPath = join(dir, "input.txt");
  const outputPath = join(dir, "output.txt");
  const keyPath = join(dir, "key.json");
  await writeFile(inputPath, SAMPLE, "utf8");

  const anon = await run([
    ...SCOPE,
    "--quiet",
    "-o",
    outputPath,
    "-k",
    keyPath,
    inputPath,
  ]);
  expect(anon.code).toBe(0);
  const redacted = await readFile(outputPath, "utf8");
  expect(redacted).not.toContain("jan.novak@example.com");

  const restored = await run(["--quiet", "-d", keyPath, outputPath]);
  expect(restored.code).toBe(0);
  expect(restored.out).toBe(SAMPLE);
});

test("redact mode is irreversible and uses the redact string", async () => {
  const { out, code } = await run(
    [...SCOPE, "--quiet", "-m", "redact"],
    SAMPLE,
  );
  expect(code).toBe(0);
  expect(out).toContain("[REDACTED]");
  expect(out).not.toContain("jan.novak@example.com");
  expect(out).not.toContain("[EMAIL_ADDRESS_1]");
});

test("json output carries entities with exact offsets", async () => {
  const { out, code } = await run([...SCOPE, "--quiet", "--json"], SAMPLE);
  expect(code).toBe(0);
  const payload = JSON.parse(out) as {
    entityCount: number;
    entities: { start: number; end: number; text: string }[];
    redactedText: string;
  };
  expect(payload.entityCount).toBeGreaterThan(0);
  for (const entity of payload.entities) {
    expect(SAMPLE.slice(entity.start, entity.end)).toBe(entity.text);
  }
  expect(payload.redactedText).not.toContain("jan.novak@example.com");
});

test("multiple inputs require an output directory", async () => {
  const { code, err } = await run(["a.txt", "b.txt"]);
  expect(code).toBe(2);
  expect(err).toContain("--output");
});

test("unknown flags exit with usage error", async () => {
  const { code, err } = await run(["--nope"], "x");
  expect(code).toBe(2);
  expect(err).toContain("--help");
});

test("refuses to overwrite the input file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
  const inputPath = join(dir, "input.txt");
  await writeFile(inputPath, SAMPLE, "utf8");
  const { code, err } = await run([...SCOPE, "-o", inputPath, inputPath]);
  expect(code).toBe(2);
  expect(err).toContain("refusing to overwrite");
});

test("refuses a key path that collides with the output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
  const inputPath = join(dir, "input.txt");
  const outPath = join(dir, "out.txt");
  await writeFile(inputPath, SAMPLE, "utf8");
  const { code, err } = await run([
    ...SCOPE,
    "-o",
    outPath,
    "-k",
    outPath,
    inputPath,
  ]);
  expect(code).toBe(2);
  expect(err).toContain("collides");
});

test("refuses batch inputs with colliding basenames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
  const a = join(dir, "a");
  const b = join(dir, "b");
  await Bun.write(join(a, "same.txt"), SAMPLE);
  await Bun.write(join(b, "same.txt"), SAMPLE);
  const { code, err } = await run([
    ...SCOPE,
    "-o",
    join(dir, "out"),
    join(a, "same.txt"),
    join(b, "same.txt"),
  ]);
  expect(code).toBe(2);
  expect(err).toContain("collides");
});
