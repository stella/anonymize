import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  lstat,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const SESSION_ARCHIVE_KEY_BYTES = 32;
export const SESSION_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024 + 57;
export const SESSION_ARCHIVE_MAX_COUNT = 256;
export const SESSION_ARCHIVE_TOTAL_MAX_BYTES = 256 * 1024 * 1024;

const ARCHIVE_NAME = /^[a-f0-9]{64}\.stlasess$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const STAGING_NAME =
  /^[a-f0-9]{64}\.stlasess\.tmp\.[0-9a-f]{8}-[0-9a-f-]{27}$/u;
const READ_CHUNK_BYTES = 64 * 1024;
const LOCK_FILE_NAME = ".stella-session.lock";

export const DURABLE_SESSION_FAULT_POINTS = {
  beforeDirectoryFsync: "before-directory-fsync",
  beforeRename: "before-rename",
  beforeStagingFsync: "before-staging-fsync",
  beforeStagingWrite: "before-staging-write",
} as const;

export type DurableSessionFaultPoint =
  (typeof DURABLE_SESSION_FAULT_POINTS)[keyof typeof DURABLE_SESSION_FAULT_POINTS];

type FileIdentity = {
  dev: number;
  ino: number;
};

type DirectoryIdentity = FileIdentity & {
  path: string;
};

type SessionInventory = {
  archiveCount: number;
  totalBytes: number;
};

const sameFile = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const assertOwner = (uid: number, label: string): void => {
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
};

const assertPrivateMode = (mode: number, label: string): void => {
  if ((mode & 0o077) !== 0) {
    throw new Error(`${label} must not grant group or other permissions`);
  }
};

const assertPosixDurabilitySupport = (): void => {
  if (
    (process.platform !== "darwin" && process.platform !== "linux") ||
    typeof process.getuid !== "function" ||
    typeof fsConstants.O_NOFOLLOW !== "number" ||
    fsConstants.O_NOFOLLOW === 0 ||
    typeof fsConstants.O_DIRECTORY !== "number" ||
    fsConstants.O_DIRECTORY === 0
  ) {
    throw new Error(
      "Encrypted durable MCP sessions require supported POSIX owner, nofollow, directory-fsync, and advisory-lock semantics on macOS or Linux",
    );
  }
};

const acquireDirectoryLock = async (
  directoryPath: string,
): Promise<FileHandle> => {
  const path = join(directoryPath, LOCK_FILE_NAME);
  const handle = await open(
    path,
    fsConstants.O_RDWR |
      fsConstants.O_CREAT |
      fsConstants.O_NOFOLLOW |
      fsConstants.O_NONBLOCK,
    0o600,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error("MCP session lock must be a regular file");
    }
    assertOwner(metadata.uid, "MCP session lock");
    assertPrivateMode(metadata.mode, "MCP session lock");
    // Loaded lazily because Bun is used as a repository test/build tool but
    // cannot safely load this Node native addon. The shipped MCP runtime is
    // Node; Node integration tests exercise this path.
    const { tryLock } = await import("fs-native-extensions");
    if (!tryLock(handle.fd)) {
      throw new Error(
        "MCP session directory is already locked by another server",
      );
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
};

const canonicalAbsolutePath = async (
  path: string,
  label: string,
): Promise<string> => {
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const normalized = resolve(path);
  const canonical = await realpath(normalized);
  if (canonical !== normalized) {
    throw new Error(`${label} must not contain symbolic links`);
  }
  return canonical;
};

const readHandleBounded = async (
  handle: Pick<Awaited<ReturnType<typeof open>>, "read">,
  maximumBytes: number,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const remaining = maximumBytes - total;
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining + 1));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total);
    }
    total += bytesRead;
    if (total > maximumBytes) {
      throw new Error("Encrypted session archive exceeds the byte limit");
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
};

const readKey = async (path: string): Promise<Uint8Array> => {
  const canonical = await canonicalAbsolutePath(path, "MCP session key file");
  const linkedMetadata = await lstat(canonical);
  if (!linkedMetadata.isFile() || linkedMetadata.isSymbolicLink()) {
    throw new Error("MCP session key file must be a regular file");
  }
  assertOwner(linkedMetadata.uid, "MCP session key file");
  assertPrivateMode(linkedMetadata.mode, "MCP session key file");
  if (linkedMetadata.size !== SESSION_ARCHIVE_KEY_BYTES) {
    throw new Error(
      `MCP session key file must contain exactly ${SESSION_ARCHIVE_KEY_BYTES} raw bytes`,
    );
  }
  const handle = await open(
    canonical,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  let keyBuffer: Buffer | undefined;
  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      !sameFile(linkedMetadata, openedMetadata) ||
      openedMetadata.size !== SESSION_ARCHIVE_KEY_BYTES
    ) {
      throw new Error("MCP session key file changed while it was validated");
    }
    keyBuffer = Buffer.alloc(SESSION_ARCHIVE_KEY_BYTES + 1);
    let keyLength = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        keyBuffer,
        keyLength,
        keyBuffer.byteLength - keyLength,
        null,
      );
      if (bytesRead === 0 || keyLength + bytesRead === keyBuffer.byteLength) {
        keyLength += bytesRead;
        break;
      }
      keyLength += bytesRead;
    }
    if (keyLength !== SESSION_ARCHIVE_KEY_BYTES) {
      keyBuffer.fill(0);
      throw new Error(
        `MCP session key file must contain exactly ${SESSION_ARCHIVE_KEY_BYTES} raw bytes`,
      );
    }
    const currentMetadata = await stat(canonical);
    if (!sameFile(openedMetadata, currentMetadata)) {
      keyBuffer.fill(0);
      throw new Error("MCP session key file changed while it was read");
    }
    const key = new Uint8Array(SESSION_ARCHIVE_KEY_BYTES);
    key.set(keyBuffer.subarray(0, SESSION_ARCHIVE_KEY_BYTES));
    keyBuffer.fill(0);
    return key;
  } finally {
    keyBuffer?.fill(0);
    await handle.close();
  }
};

const archiveName = (sessionId: string): string =>
  `${createHash("sha256").update(sessionId, "utf8").digest("hex")}.stlasess`;

const assertSessionId = (sessionId: string): void => {
  if (!SESSION_ID.test(sessionId)) {
    throw new Error("MCP session ID is invalid");
  }
};

export type DurableSessionStoreOptions = {
  faultInjector?: (point: DurableSessionFaultPoint) => Promise<void> | void;
  keyFile: string;
  sessionDirectory: string;
};

export type StoredSessionArchive = {
  bytes: Uint8Array;
};

export type EncryptableSession = {
  toEncryptedArchiveAt(
    key: Uint8Array,
    observedAtEpochSeconds: number,
  ): Uint8Array;
};

export type EncryptedSessionRestorer<Session> = {
  restoreEncryptedRedactionSession(options: {
    archive: Uint8Array;
    expectedSessionId: string;
    key: Uint8Array;
    observedAtEpochSeconds: number;
  }): Session;
};

export type RestoreStoredSessionOptions<Session> = {
  archive: Uint8Array;
  expectedSessionId: string;
  observedAtEpochSeconds: number;
  restorer: EncryptedSessionRestorer<Session>;
};

export class DurableSessionStore {
  #closePromise: Promise<void> | undefined;
  readonly #directory: DirectoryIdentity;
  readonly #faultInjector:
    | ((point: DurableSessionFaultPoint) => Promise<void> | void)
    | undefined;
  readonly #key: Uint8Array;
  readonly #lockHandle: FileHandle;
  #mutationTail: Promise<void> = Promise.resolve();
  #state: "closed" | "closing" | "open" = "open";

  private constructor(
    directory: DirectoryIdentity,
    key: Uint8Array,
    lockHandle: FileHandle,
    faultInjector?: (point: DurableSessionFaultPoint) => Promise<void> | void,
  ) {
    this.#directory = directory;
    this.#key = key;
    this.#lockHandle = lockHandle;
    this.#faultInjector = faultInjector;
  }

  static async create({
    keyFile,
    sessionDirectory,
    faultInjector,
  }: DurableSessionStoreOptions): Promise<DurableSessionStore> {
    assertPosixDurabilitySupport();
    const directoryPath = await canonicalAbsolutePath(
      sessionDirectory,
      "MCP session directory",
    );
    const metadata = await lstat(directoryPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("MCP session directory must be a directory");
    }
    assertOwner(metadata.uid, "MCP session directory");
    assertPrivateMode(metadata.mode, "MCP session directory");
    const key = await readKey(keyFile);
    let lockHandle: FileHandle | undefined;
    try {
      lockHandle = await acquireDirectoryLock(directoryPath);
      const store = new DurableSessionStore(
        { dev: metadata.dev, ino: metadata.ino, path: directoryPath },
        key,
        lockHandle,
        faultInjector,
      );
      await store.#validateInventory({ removeStagingFiles: true });
      await store.#syncDirectory();
      return store;
    } catch (error) {
      key.fill(0);
      await lockHandle?.close().catch(() => undefined);
      throw error;
    }
  }

  seal(
    session: EncryptableSession,
    observedAtEpochSeconds: number,
  ): Uint8Array {
    this.#assertOpen();
    return session.toEncryptedArchiveAt(this.#key, observedAtEpochSeconds);
  }

  restore<Session>({
    archive,
    expectedSessionId,
    observedAtEpochSeconds,
    restorer,
  }: RestoreStoredSessionOptions<Session>): Session {
    this.#assertOpen();
    return restorer.restoreEncryptedRedactionSession({
      archive,
      expectedSessionId,
      key: this.#key,
      observedAtEpochSeconds,
    });
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#state = "closing";
    this.#closePromise = (async () => {
      await this.#mutationTail;
      this.#key.fill(0);
      await this.#lockHandle.close();
      this.#state = "closed";
    })();
    return this.#closePromise;
  }

  async load(sessionId: string): Promise<StoredSessionArchive | undefined> {
    this.#assertOpen();
    return this.#withMutation(() => this.#load(sessionId));
  }

  async #load(sessionId: string): Promise<StoredSessionArchive | undefined> {
    assertSessionId(sessionId);
    await this.#validateInventory({ removeStagingFiles: false });
    const path = this.#path(sessionId);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw new Error("Encrypted session archive could not be opened", {
        cause: error,
      });
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new Error("Encrypted session archive must be a regular file");
      }
      assertOwner(metadata.uid, "Encrypted session archive");
      assertPrivateMode(metadata.mode, "Encrypted session archive");
      if (metadata.size > SESSION_ARCHIVE_MAX_BYTES) {
        throw new Error("Encrypted session archive exceeds the byte limit");
      }
      const bytes = await readHandleBounded(handle, SESSION_ARCHIVE_MAX_BYTES);
      await this.#assertDirectory();
      const currentMetadata = await lstat(path);
      if (!currentMetadata.isFile() || !sameFile(metadata, currentMetadata)) {
        throw new Error("Encrypted session archive changed while it was read");
      }
      return { bytes };
    } finally {
      await handle.close();
    }
  }

  async save(sessionId: string, archive: Uint8Array): Promise<void> {
    this.#assertOpen();
    return this.#withMutation(() => this.#save(sessionId, archive));
  }

  async #save(sessionId: string, archive: Uint8Array): Promise<void> {
    assertSessionId(sessionId);
    if (archive.byteLength > SESSION_ARCHIVE_MAX_BYTES) {
      throw new Error("Encrypted session archive exceeds the byte limit");
    }
    const inventory = await this.#validateInventory({
      removeStagingFiles: false,
    });
    await this.#assertDirectory();
    const destination = this.#path(sessionId);
    const temporary = `${destination}.tmp.${randomUUID()}`;
    const handle = await open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isFile()) {
        throw new Error("Encrypted session staging path is not a regular file");
      }
      await this.#inject(DURABLE_SESSION_FAULT_POINTS.beforeStagingWrite);
      await handle.writeFile(archive);
      await this.#inject(DURABLE_SESSION_FAULT_POINTS.beforeStagingFsync);
      await handle.sync();
      const stagedMetadata = await lstat(temporary);
      if (
        !stagedMetadata.isFile() ||
        !sameFile(openedMetadata, stagedMetadata)
      ) {
        throw new Error(
          "Encrypted session staging file changed before publication",
        );
      }
      await this.#assertDirectory();
      const existing = await lstat(destination).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      });
      if (
        existing !== undefined &&
        (!existing.isFile() || existing.isSymbolicLink())
      ) {
        throw new Error("Encrypted session archive path is not a regular file");
      }
      const nextCount =
        inventory.archiveCount + (existing === undefined ? 1 : 0);
      const nextTotalBytes =
        inventory.totalBytes - (existing?.size ?? 0) + archive.byteLength;
      if (nextCount > SESSION_ARCHIVE_MAX_COUNT) {
        throw new Error(
          `MCP session archives must not exceed ${SESSION_ARCHIVE_MAX_COUNT}`,
        );
      }
      if (nextTotalBytes > SESSION_ARCHIVE_TOTAL_MAX_BYTES) {
        throw new Error("MCP session archives exceed the aggregate byte limit");
      }
      await this.#inject(DURABLE_SESSION_FAULT_POINTS.beforeRename);
      await rename(temporary, destination);
      await this.#assertDirectory();
      const published = await lstat(destination);
      if (!published.isFile() || !sameFile(openedMetadata, published)) {
        throw new Error("Encrypted session archive publication was not atomic");
      }
      await this.#syncDirectory();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async delete(sessionId: string): Promise<void> {
    this.#assertOpen();
    return this.#withMutation(() => this.#delete(sessionId));
  }

  async #delete(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    await this.#assertDirectory();
    const path = this.#path(sessionId);
    const metadata = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (metadata === undefined) {
      return;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Encrypted session archive path is not a regular file");
    }
    await unlink(path);
    await this.#syncDirectory();
    await this.#assertDirectory();
  }

  #path(sessionId: string): string {
    return join(this.#directory.path, archiveName(sessionId));
  }

  #assertOpen(): void {
    if (this.#state !== "open") {
      throw new Error("MCP durable session store is closing or closed");
    }
  }

  async #withMutation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#mutationTail;
    let release = (): void => undefined;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.#mutationTail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #assertDirectory(): Promise<void> {
    const canonical = await realpath(this.#directory.path);
    const metadata = await lstat(this.#directory.path);
    if (
      canonical !== this.#directory.path ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !sameFile(this.#directory, metadata)
    ) {
      throw new Error("MCP session directory changed while it was being used");
    }
    assertOwner(metadata.uid, "MCP session directory");
    assertPrivateMode(metadata.mode, "MCP session directory");
  }

  async #syncDirectory(): Promise<void> {
    await this.#inject(DURABLE_SESSION_FAULT_POINTS.beforeDirectoryFsync);
    const handle = await open(
      this.#directory.path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isDirectory() || !sameFile(this.#directory, metadata)) {
        throw new Error("MCP session directory changed before synchronization");
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #inject(point: DurableSessionFaultPoint): Promise<void> {
    await this.#faultInjector?.(point);
  }

  async #validateInventory({
    removeStagingFiles,
  }: {
    removeStagingFiles: boolean;
  }): Promise<SessionInventory> {
    await this.#assertDirectory();
    const entries = await readdir(this.#directory.path, {
      withFileTypes: true,
    });
    let archiveCount = 0;
    let totalBytes = 0;
    for (const entry of entries) {
      const path = join(this.#directory.path, entry.name);
      if (entry.name === LOCK_FILE_NAME) {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error("MCP session directory contains an unsafe lock path");
        }
        assertOwner(metadata.uid, "MCP session lock");
        assertPrivateMode(metadata.mode, "MCP session lock");
        continue;
      }
      if (STAGING_NAME.test(entry.name)) {
        if (!removeStagingFiles) {
          throw new Error("MCP session directory contains a partial archive");
        }
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error(
            "MCP session directory contains an unsafe staging path",
          );
        }
        await unlink(path);
        await this.#syncDirectory();
        continue;
      }
      if (
        !ARCHIVE_NAME.test(entry.name) ||
        !entry.isFile() ||
        entry.isSymbolicLink()
      ) {
        throw new Error("MCP session directory contains an unsupported entry");
      }
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(
          "MCP session directory contains an unsafe archive path",
        );
      }
      assertOwner(metadata.uid, "Encrypted session archive");
      assertPrivateMode(metadata.mode, "Encrypted session archive");
      if (metadata.size > SESSION_ARCHIVE_MAX_BYTES) {
        throw new Error("Encrypted session archive exceeds the byte limit");
      }
      archiveCount += 1;
      totalBytes += metadata.size;
      if (archiveCount > SESSION_ARCHIVE_MAX_COUNT) {
        throw new Error(
          `MCP session archives must not exceed ${SESSION_ARCHIVE_MAX_COUNT}`,
        );
      }
      if (totalBytes > SESSION_ARCHIVE_TOTAL_MAX_BYTES) {
        throw new Error("MCP session archives exceed the aggregate byte limit");
      }
    }
    await this.#assertDirectory();
    return { archiveCount, totalBytes };
  }
}
