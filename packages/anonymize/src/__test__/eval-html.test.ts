import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("HTML evaluation renders native detections and redacted text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anonymize-eval-html-"));
  try {
    const input = join(directory, "synthetic.txt");
    const output = join(directory, "report.html");
    await Bun.write(input, "sample@example.com");
    const script = fileURLToPath(
      new URL("../../../../eval-html.ts", import.meta.url),
    );
    const child = Bun.spawn(
      [process.execPath, script, input, "--output", output],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("1 docs, 1 entities");
    const html = await Bun.file(output).text();
    expect(html).toContain("email address");
    const redacted = html.match(
      /<h3>Redacted<\/h3>\s*<div class="content">(?<text>[^<]+)<\/div>/u,
    )?.groups?.text;
    expect(redacted).toBeDefined();
    expect(redacted).not.toContain("sample@example.com");
    expect(redacted).toMatch(/\[[^\]]+\]/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
