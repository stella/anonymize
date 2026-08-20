import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UsageError } from "../args";
import { publishNewPrivateFile } from "../private-file";

describe("private file publication", () => {
  test("creates a new file with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anonymize-private-file-"));
    const target = join(directory, "key.json");

    await publishNewPrivateFile({
      target,
      content: '{"secret":"value"}',
      flag: "--key",
    });

    expect(await readFile(target, "utf8")).toBe('{"secret":"value"}');
    if (process.platform !== "win32") {
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    }
  });

  test("refuses to overwrite an existing destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anonymize-private-file-"));
    const target = join(directory, "key.json");
    await writeFile(target, "existing", { mode: 0o600 });

    await expect(
      publishNewPrivateFile({
        target,
        content: "replacement",
        flag: "--key",
      }),
    ).rejects.toBeInstanceOf(UsageError);

    expect(await readFile(target, "utf8")).toBe("existing");
    expect(await readdir(directory)).toEqual(["key.json"]);
  });

  test("refuses a symlink destination without changing its referent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anonymize-private-file-"));
    const referent = join(directory, "referent.json");
    const target = join(directory, "key.json");
    await writeFile(referent, "existing", { mode: 0o600 });
    await symlink(referent, target);

    await expect(
      publishNewPrivateFile({
        target,
        content: "replacement",
        flag: "--key",
      }),
    ).rejects.toBeInstanceOf(UsageError);

    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readFile(referent, "utf8")).toBe("existing");
    expect((await readdir(directory)).toSorted()).toEqual([
      "key.json",
      "referent.json",
    ]);
  });

  test("allows exactly one concurrent publisher to claim a destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anonymize-private-file-"));
    const target = join(directory, "key.json");
    const contents = ["first", "second"] as const;

    const results = await Promise.allSettled(
      contents.map((content) =>
        publishNewPrivateFile({ target, content, flag: "--key" }),
      ),
    );

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = results.find(({ status }) => status === "rejected");
    if (rejected?.status !== "rejected") {
      throw new Error("expected one publisher to be refused");
    }
    expect(rejected.reason).toBeInstanceOf(UsageError);
    const published = await readFile(target, "utf8");
    expect(published === "first" || published === "second").toBe(true);
    expect(await readdir(directory)).toEqual(["key.json"]);
  });

  test("leaves an inert reservation when the dependent write fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anonymize-private-file-"));
    const target = join(directory, "key.json");

    await expect(
      publishNewPrivateFile({
        target,
        content: "sensitive",
        flag: "--key",
        afterPublish: () => Promise.reject(new Error("output failed")),
      }),
    ).rejects.toThrow("output failed");

    expect((await stat(target)).size).toBe(0);
    if (process.platform !== "win32") {
      expect((await stat(target)).mode & 0o777).toBe(0o000);
    }
    expect(await readdir(directory)).toEqual(["key.json"]);
  });
});
