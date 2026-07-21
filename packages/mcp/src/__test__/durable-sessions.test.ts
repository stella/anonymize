import { expect } from "expect";
import { afterEach, describe, test } from "node:test";
import { extractDocxText } from "@stll/anonymize-docx";
import { strToU8, zipSync } from "fflate";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DurableSessionStore,
  DURABLE_SESSION_FAULT_POINTS,
  SESSION_ARCHIVE_MAX_BYTES,
  SESSION_ARCHIVE_MAX_COUNT,
  type DurableSessionStoreOptions,
} from "../durable-sessions";
import { LocalAnonymizeService, PathScope } from "../local";

const temporaryDirectories: string[] = [];
const openServices = new Set<LocalAnonymizeService>();
const openStores = new Set<DurableSessionStore>();
const testDirectory = dirname(fileURLToPath(import.meta.url));
const WORD_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const PACKAGE_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "stella-mcp-durable-test-"));
  const canonical = await realpath(directory);
  temporaryDirectories.push(canonical);
  return canonical;
};

const createStorePaths = async (): Promise<{
  keyFile: string;
  root: string;
  sessionDirectory: string;
}> => {
  const root = await temporaryDirectory();
  const sessionDirectory = join(root, "sessions");
  const keyFile = join(root, "session.key");
  await mkdir(sessionDirectory, { mode: 0o700 });
  await writeFile(keyFile, new Uint8Array(32).fill(0x42), { mode: 0o600 });
  return { keyFile, root, sessionDirectory };
};

const createStore = async (
  options: DurableSessionStoreOptions,
): Promise<DurableSessionStore> => {
  const store = await DurableSessionStore.create(options);
  openStores.add(store);
  return store;
};

const createService = async (
  {
    keyFile,
    root,
    sessionDirectory,
  }: Awaited<ReturnType<typeof createStorePaths>>,
  options: {
    durableSessionTtlSeconds?: number;
    nowEpochSeconds?: () => number;
  } = {},
): Promise<LocalAnonymizeService> => {
  const service = new LocalAnonymizeService(await PathScope.create([root]), {
    durableSessions: await createStore({ keyFile, sessionDirectory }),
    ...options,
  });
  openServices.add(service);
  return service;
};

const archivePath = async (
  sessionDirectory: string,
  sessionId: string,
): Promise<string> => {
  const prefix = `${createHash("sha256").update(sessionId, "utf8").digest("hex")}.`;
  const names = (await readdir(sessionDirectory)).filter(
    (name) => name.startsWith(prefix) && name.endsWith(".stlasess"),
  );
  expect(names).toHaveLength(1);
  return join(sessionDirectory, names.at(0) ?? "missing");
};

const externalBatch = (document: Uint8Array) => ({
  version: 1,
  document: {
    sha256: createHash("sha256").update(document).digest("hex"),
  },
  offsetUnit: "unicode-code-point",
  provider: {
    id: "fake-provider",
    name: "Deterministic fake provider",
    version: "1.0.0",
  },
  labelMap: [{ providerLabel: "PER", entityLabel: "person" }],
  detections: [
    {
      id: "fake-person-1",
      start: 1,
      end: 7,
      label: "PER",
      score: 0.99,
    },
  ],
});

const writeDocx = async (path: string, text: string): Promise<void> => {
  await writeFile(
    path,
    zipSync({
      "[Content_Types].xml": strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_NAMESPACE}"><Relationship Id="rId1" Type="${OFFICE_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    }),
  );
};

afterEach(async () => {
  await Promise.all(
    [...openServices].map((service) => service.close().catch(() => undefined)),
  );
  openServices.clear();
  await Promise.all(
    [...openStores].map((store) => store.close().catch(() => undefined)),
  );
  openStores.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

void describe("durable MCP sessions", () => {
  void test("restores text across server restarts without plaintext archives", async () => {
    const paths = await createStorePaths();
    const input = join(paths.root, "input.txt");
    const anonymized = join(paths.root, "anonymized.txt");
    const restored = join(paths.root, "restored.txt");
    await writeFile(input, "Alice Smith signed.");

    const initial = await createService(paths);
    await initial.anonymizeText({
      inputPath: input,
      outputPath: anonymized,
      sessionId: "durable_text_1",
    });
    const persistedArchive = await archivePath(
      paths.sessionDirectory,
      "durable_text_1",
    );
    const archive = await readFile(persistedArchive);
    expect(archive.toString("utf8")).not.toContain("Alice Smith");
    expect((await stat(persistedArchive)).mode & 0o777).toBe(0o600);

    await initial.close();
    const restarted = await createService(paths);
    await restarted.restoreText({
      inputPath: anonymized,
      outputPath: restored,
      sessionId: "durable_text_1",
    });
    expect(await readFile(restored, "utf8")).toBe("Alice Smith signed.");
    await expect(
      restarted.anonymizeText({
        inputPath: input,
        outputPath: join(paths.root, "language-not-guessed.txt"),
        sessionId: "durable_text_1",
        language: "en",
      }),
    ).rejects.toThrow("full all-language pipeline");
    await restarted.anonymizeText({
      inputPath: input,
      outputPath: join(paths.root, "continued.txt"),
      sessionId: "durable_text_1",
    });
  });

  void test("restores DOCX across server restarts", async () => {
    const paths = await createStorePaths();
    const input = join(paths.root, "input.docx");
    const anonymized = join(paths.root, "anonymized.docx");
    const restored = join(paths.root, "restored.docx");
    await writeDocx(input, "Alice Smith signed.");

    const initial = await createService(paths);
    await initial.anonymizeDocx({
      inputPath: input,
      outputPath: anonymized,
      sessionId: "durable_docx_1",
      allowPartialCoverage: false,
    });
    await initial.close();
    const restarted = await createService(paths);
    await restarted.restoreDocx({
      inputPath: anonymized,
      outputPath: restored,
      sessionId: "durable_docx_1",
      allowPartialCoverage: false,
    });
    expect(extractDocxText(await readFile(restored)).blocks.at(0)?.text).toBe(
      "Alice Smith signed.",
    );
  });

  void test("restores externally detected text across durable restarts", async () => {
    const paths = await createStorePaths();
    const original = "😀XQZ-秘密 and alice@example.com signed.";
    const document = new TextEncoder().encode(original);
    const input = join(paths.root, "external-input.txt");
    const batch = join(paths.root, "external.json");
    const anonymized = join(paths.root, "external-anonymized.txt");
    const restored = join(paths.root, "external-restored.txt");
    await writeFile(input, document);
    await writeFile(batch, JSON.stringify(externalBatch(document)));

    const initial = await createService(paths);
    const result = await initial.anonymizeTextWithExternalDetections({
      inputPath: input,
      detectionBatchPath: batch,
      outputPath: anonymized,
      sessionId: "durable_external_1",
    });
    expect(result).toMatchObject({
      externalDetectionBatchStatus: "accepted",
      externalDetectionCount: 1,
      retainedExternalDetectionCount: 1,
      entityCount: 2,
    });
    await initial.close();

    const restarted = await createService(paths);
    await restarted.restoreText({
      inputPath: anonymized,
      outputPath: restored,
      sessionId: "durable_external_1",
    });
    expect(await readFile(restored, "utf8")).toBe(original);
    await expect(
      restarted.anonymizeTextWithExternalDetections({
        inputPath: input,
        detectionBatchPath: batch,
        outputPath: join(paths.root, "external-language.txt"),
        sessionId: "durable_external_1",
        language: "en",
      }),
    ).rejects.toThrow("The external detection session was rejected.");
  });

  void test("rejects wrong keys and tampered archives without publishing output", async () => {
    const paths = await createStorePaths();
    const input = join(paths.root, "input.txt");
    const anonymized = join(paths.root, "anonymized.txt");
    await writeFile(input, "Alice Smith signed.");
    const initial = await createService(paths);
    await initial.anonymizeText({
      inputPath: input,
      outputPath: anonymized,
      sessionId: "durable_auth_1",
    });
    await initial.close();

    const wrongKey = join(paths.root, "wrong.key");
    await writeFile(wrongKey, new Uint8Array(32).fill(0x24), { mode: 0o600 });
    const wrongKeyOutput = join(paths.root, "wrong-key.txt");
    const wrongKeyService = await createService({
      ...paths,
      keyFile: wrongKey,
    });
    await expect(
      wrongKeyService.restoreText({
        inputPath: anonymized,
        outputPath: wrongKeyOutput,
        sessionId: "durable_auth_1",
      }),
    ).rejects.toThrow("durable session is unavailable");
    await expect(readFile(wrongKeyOutput)).rejects.toThrow();
    await wrongKeyService.close();

    const persistedArchive = await archivePath(
      paths.sessionDirectory,
      "durable_auth_1",
    );
    await copyFile(
      persistedArchive,
      join(
        paths.sessionDirectory,
        `${createHash("sha256").update("different_session_1", "utf8").digest("hex")}.${basename(persistedArchive).split(".").slice(1).join(".")}`,
      ),
    );
    const mismatchedOutput = join(paths.root, "mismatched.txt");
    const mismatchedService = await createService(paths);
    await expect(
      mismatchedService.restoreText({
        inputPath: anonymized,
        outputPath: mismatchedOutput,
        sessionId: "different_session_1",
      }),
    ).rejects.toThrow("durable session is unavailable");
    await expect(readFile(mismatchedOutput)).rejects.toThrow();
    await mismatchedService.close();

    const tampered = await readFile(persistedArchive);
    tampered[tampered.byteLength - 1] ^= 0xff;
    await writeFile(persistedArchive, tampered, { mode: 0o600 });
    const tamperedOutput = join(paths.root, "tampered.txt");
    const tamperedService = await createService(paths);
    await expect(
      tamperedService.restoreText({
        inputPath: anonymized,
        outputPath: tamperedOutput,
        sessionId: "durable_auth_1",
      }),
    ).rejects.toThrow("durable session is unavailable");
    await expect(readFile(tamperedOutput)).rejects.toThrow();
  });

  void test("expires and removes MCP-created sessions across restarts", async () => {
    const paths = await createStorePaths();
    let now = 100;
    const input = join(paths.root, "input.txt");
    const anonymized = join(paths.root, "anonymized.txt");
    await writeFile(input, "Alice Smith signed.");
    const initial = await createService(paths, {
      durableSessionTtlSeconds: 60,
      nowEpochSeconds: () => now,
    });
    await initial.anonymizeText({
      inputPath: input,
      outputPath: anonymized,
      sessionId: "expired_session_1",
    });
    const persistedArchive = await archivePath(
      paths.sessionDirectory,
      "expired_session_1",
    );
    expect(persistedArchive).toContain(".160.stlasess");
    await initial.close();

    now = 160;
    const restarted = await createService(paths, {
      durableSessionTtlSeconds: 60,
      nowEpochSeconds: () => now,
    });
    await expect(
      restarted.restoreText({
        inputPath: anonymized,
        outputPath: join(paths.root, "expired-output.txt"),
        sessionId: "expired_session_1",
      }),
    ).rejects.toThrow("session is unavailable");
    await expect(readFile(persistedArchive)).rejects.toThrow();

    const sameProcessInput = join(paths.root, "same-process-input.txt");
    const sameProcessAnonymized = join(
      paths.root,
      "same-process-anonymized.txt",
    );
    await writeFile(sameProcessInput, "Bob Jones signed.");
    await restarted.anonymizeText({
      inputPath: sameProcessInput,
      outputPath: sameProcessAnonymized,
      sessionId: "same_process_expiry_1",
    });
    const sameProcessArchive = await archivePath(
      paths.sessionDirectory,
      "same_process_expiry_1",
    );
    now = 220;
    await expect(
      restarted.restoreText({
        inputPath: sameProcessAnonymized,
        outputPath: join(paths.root, "same-process-expired-output.txt"),
        sessionId: "same_process_expiry_1",
      }),
    ).rejects.toThrow("session is unavailable");
    await expect(readFile(sameProcessArchive)).rejects.toThrow();
  });

  void test("requires private regular key and directory paths", async () => {
    if (process.platform === "win32") {
      return;
    }
    const paths = await createStorePaths();
    await chmod(paths.keyFile, 0o644);
    await expect(createStore(paths)).rejects.toThrow(
      "group or other permissions",
    );
    await chmod(paths.keyFile, 0o600);
    await chmod(paths.sessionDirectory, 0o755);
    await expect(createStore(paths)).rejects.toThrow(
      "group or other permissions",
    );
    await chmod(paths.sessionDirectory, 0o700);
    const shortKey = join(paths.root, "short.key");
    await writeFile(shortKey, new Uint8Array(31), { mode: 0o600 });
    await expect(createStore({ ...paths, keyFile: shortKey })).rejects.toThrow(
      "exactly 32 raw bytes",
    );
    const linkedKey = join(paths.root, "linked.key");
    await symlink(paths.keyFile, linkedKey);
    await expect(createStore({ ...paths, keyFile: linkedKey })).rejects.toThrow(
      "symbolic links",
    );
  });

  void test("cleans bounded partial writes and rejects excess archives", async () => {
    const paths = await createStorePaths();
    const partial = join(
      paths.sessionDirectory,
      `${"a".repeat(64)}.1000.stlasess.tmp.00000000-0000-0000-0000-000000000000`,
    );
    await writeFile(partial, "partial", { mode: 0o600 });
    const store = await createStore(paths);
    await expect(readFile(partial)).rejects.toThrow();
    await expect(
      store.save({
        sessionId: "oversized_session_1",
        archive: new Uint8Array(SESSION_ARCHIVE_MAX_BYTES + 1),
        expiresAtEpochSeconds: 1_000,
        observedAtEpochSeconds: 100,
      }),
    ).rejects.toThrow("byte limit");
    await store.close();

    for (let index = 0; index <= SESSION_ARCHIVE_MAX_COUNT; index += 1) {
      const name = `${index.toString(16).padStart(64, "0")}.1000.stlasess`;
      await writeFile(join(paths.sessionDirectory, name), "x", { mode: 0o600 });
    }
    await expect(createStore(paths)).rejects.toThrow("must not exceed");
  });

  void test("rejects a session directory replaced after validation", async () => {
    const paths = await createStorePaths();
    const store = await createStore(paths);
    const moved = join(paths.root, "sessions-moved");
    const outside = await temporaryDirectory();
    await rename(paths.sessionDirectory, moved);
    await symlink(outside, paths.sessionDirectory);

    await expect(
      store.save({
        sessionId: "race_session_1",
        archive: new Uint8Array([1]),
        expiresAtEpochSeconds: 1_000,
        observedAtEpochSeconds: 100,
      }),
    ).rejects.toThrow("session directory changed");
    expect(await readdir(outside)).toEqual([]);
  });

  void test("holds one process-lifetime advisory lock and releases it on close", async () => {
    const paths = await createStorePaths();
    const first = await createStore(paths);
    await expect(createStore(paths)).rejects.toThrow("already locked");
    await first.close();
    const second = await createStore(paths);
    await second.close();
  });

  void test("keeps exclusivity when a lock-file-shaped decoy is unlinked and recreated", async () => {
    const paths = await createStorePaths();
    const first = await createStore(paths);
    const decoy = join(paths.sessionDirectory, ".stella-session.lock");
    await writeFile(decoy, "", { mode: 0o600 });
    await unlink(decoy);
    await writeFile(decoy, "", { mode: 0o600 });
    await expect(createStore(paths)).rejects.toThrow("already locked");
    await unlink(decoy);
    await first.close();
  });

  void test("drains an in-flight mutation before releasing the advisory lock", async () => {
    const paths = await createStorePaths();
    let releaseMutation = (): void => undefined;
    const mutationReleased = new Promise<void>((resolvePromise) => {
      releaseMutation = resolvePromise;
    });
    let mutationReached = (): void => undefined;
    const atMutation = new Promise<void>((resolvePromise) => {
      mutationReached = resolvePromise;
    });
    const store = await createStore({
      ...paths,
      faultInjector: async (point) => {
        if (point === DURABLE_SESSION_FAULT_POINTS.beforeStagingWrite) {
          mutationReached();
          await mutationReleased;
        }
      },
    });
    const save = store.save({
      sessionId: "close_race_1",
      archive: new Uint8Array([1]),
      expiresAtEpochSeconds: 1_000,
      observedAtEpochSeconds: 100,
    });
    await atMutation;
    const close = store.close();
    await expect(createStore(paths)).rejects.toThrow("already locked");
    await expect(
      store.save({
        sessionId: "close_race_2",
        archive: new Uint8Array([2]),
        expiresAtEpochSeconds: 1_000,
        observedAtEpochSeconds: 100,
      }),
    ).rejects.toThrow("closing or closed");
    releaseMutation();
    await save;
    await close;
    const next = await createStore(paths);
    await next.close();
  });

  void test("service close drains active work before closing its store", async () => {
    const paths = await createStorePaths();
    let releaseMutation = (): void => undefined;
    const mutationReleased = new Promise<void>((resolvePromise) => {
      releaseMutation = resolvePromise;
    });
    let mutationReached = (): void => undefined;
    const atMutation = new Promise<void>((resolvePromise) => {
      mutationReached = resolvePromise;
    });
    const store = await createStore({
      ...paths,
      faultInjector: async (point) => {
        if (point === DURABLE_SESSION_FAULT_POINTS.beforeStagingWrite) {
          mutationReached();
          await mutationReleased;
        }
      },
    });
    const service = new LocalAnonymizeService(
      await PathScope.create([paths.root]),
      { durableSessions: store },
    );
    const input = join(paths.root, "close-input.txt");
    await writeFile(input, "Alice Smith signed.");
    const operation = service.anonymizeText({
      inputPath: input,
      outputPath: join(paths.root, "close-output.txt"),
      sessionId: "service_close_1",
    });
    await atMutation;
    const close = service.close();
    await expect(
      service.inspectDocx(join(paths.root, "unused.docx")),
    ).rejects.toThrow("closing or closed");
    await expect(createStore(paths)).rejects.toThrow("already locked");
    releaseMutation();
    await operation;
    await close;
    const next = await createStore(paths);
    await next.close();
  });

  void test("rejects a second process and releases the lock after a crash", async () => {
    const paths = await createStorePaths();
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(testDirectory, "..", "..", "test-fixtures", "lock-holder.ts"),
        paths.sessionDirectory,
        paths.keyFile,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise<void>((resolvePromise, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolvePromise());
      child.once("exit", (code) =>
        reject(
          new Error(`Lock holder exited before ready: ${code ?? "signal"}`),
        ),
      );
    });
    await expect(createStore(paths)).rejects.toThrow("already locked");
    child.kill("SIGKILL");
    await new Promise<void>((resolvePromise) =>
      child.once("exit", () => resolvePromise()),
    );
    const recovered = await createStore(paths);
    await recovered.close();
  });

  for (const faultPoint of Object.values(DURABLE_SESSION_FAULT_POINTS)) {
    void test(`preserves the last authenticated archive after ${faultPoint}`, async () => {
      const paths = await createStorePaths();
      let armed = false;
      const store = await createStore({
        ...paths,
        faultInjector: (point) => {
          if (armed && point === faultPoint) {
            throw new Error(`injected ${point}`);
          }
        },
      });
      const service = new LocalAnonymizeService(
        await PathScope.create([paths.root]),
        { durableSessions: store },
      );
      const firstInput = join(paths.root, "fault-first.txt");
      const firstOutput = join(paths.root, "fault-first-output.txt");
      const secondInput = join(paths.root, "fault-second.txt");
      const secondOutput = join(paths.root, "fault-second-output.txt");
      await writeFile(firstInput, "Alice Smith signed.");
      await writeFile(secondInput, "Bob Jones signed.");
      await service.anonymizeText({
        inputPath: firstInput,
        outputPath: firstOutput,
        sessionId: "fault_session_1",
      });

      armed = true;
      await expect(
        service.anonymizeText({
          inputPath: secondInput,
          outputPath: secondOutput,
          sessionId: "fault_session_1",
        }),
      ).rejects.toThrow(`injected ${faultPoint}`);
      await expect(readFile(secondOutput)).rejects.toThrow();
      armed = false;
      await service.close();

      const restarted = await createService(paths);
      const restored = join(paths.root, "fault-restored.txt");
      await restarted.restoreText({
        inputPath: firstOutput,
        outputPath: restored,
        sessionId: "fault_session_1",
      });
      expect(await readFile(restored, "utf8")).toBe("Alice Smith signed.");
    });
  }

  void test("rolls back durable state when output publication is faulted", async () => {
    const paths = await createStorePaths();
    const store = await createStore(paths);
    let faultOutput = false;
    const service = new LocalAnonymizeService(
      await PathScope.create([paths.root]),
      {
        durableSessions: store,
        faults: {
          beforeOutputPublish: () => {
            if (faultOutput) {
              throw new Error("injected output publication failure");
            }
          },
        },
      },
    );
    const firstInput = join(paths.root, "publish-first.txt");
    const firstOutput = join(paths.root, "publish-first-output.txt");
    const secondInput = join(paths.root, "publish-second.txt");
    const secondOutput = join(paths.root, "publish-second-output.txt");
    await writeFile(firstInput, "Alice Smith signed.");
    await writeFile(secondInput, "Bob Jones signed.");
    await service.anonymizeText({
      inputPath: firstInput,
      outputPath: firstOutput,
      sessionId: "publish_fault_1",
    });
    faultOutput = true;
    await expect(
      service.anonymizeText({
        inputPath: secondInput,
        outputPath: secondOutput,
        sessionId: "publish_fault_1",
      }),
    ).rejects.toThrow("injected output publication failure");
    await expect(readFile(secondOutput)).rejects.toThrow();
    await service.close();

    const restarted = await createService(paths);
    const restored = join(paths.root, "publish-restored.txt");
    await restarted.restoreText({
      inputPath: firstOutput,
      outputPath: restored,
      sessionId: "publish_fault_1",
    });
    expect(await readFile(restored, "utf8")).toBe("Alice Smith signed.");
  });

  void test("serializes same-session mutations and rolls durable state back on publication failure", async () => {
    const paths = await createStorePaths();
    const service = await createService(paths);
    const firstInput = join(paths.root, "first.txt");
    const secondInput = join(paths.root, "second.txt");
    const firstOutput = join(paths.root, "first-output.txt");
    const secondOutput = join(paths.root, "second-output.txt");
    await writeFile(firstInput, "Alice Smith signed.");
    await writeFile(secondInput, "Bob Jones signed.");

    const concurrent = await Promise.allSettled([
      service.anonymizeText({
        inputPath: firstInput,
        outputPath: firstOutput,
        sessionId: "serialized_session_1",
      }),
      service.anonymizeText({
        inputPath: secondInput,
        outputPath: secondOutput,
        sessionId: "serialized_session_1",
      }),
    ]);
    expect(
      concurrent.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      concurrent.filter(({ status }) => status === "rejected"),
    ).toHaveLength(1);

    const successfulOutput =
      concurrent.at(0)?.status === "fulfilled" ? firstOutput : secondOutput;
    const original =
      concurrent.at(0)?.status === "fulfilled"
        ? "Alice Smith signed."
        : "Bob Jones signed.";
    const failedOutput = join(paths.root, `${"x".repeat(240)}.txt`);
    await expect(
      service.anonymizeText({
        inputPath: secondInput,
        outputPath: failedOutput,
        sessionId: "serialized_session_1",
      }),
    ).rejects.toThrow();
    await service.close();
    const restarted = await createService(paths);
    const restored = join(paths.root, "serialized-restored.txt");
    await restarted.restoreText({
      inputPath: successfulOutput,
      outputPath: restored,
      sessionId: "serialized_session_1",
    });
    expect(await readFile(restored, "utf8")).toBe(original);
    const predicted = join(paths.root, "predicted.txt");
    const predictedRestore = join(paths.root, "predicted-restored.txt");
    await writeFile(predicted, "[PERSON_serialized%5Fsession%5F1_2]");
    await expect(
      restarted.restoreText({
        inputPath: predicted,
        outputPath: predictedRestore,
        sessionId: "serialized_session_1",
      }),
    ).rejects.toThrow("unknown session placeholder");
  });
});
