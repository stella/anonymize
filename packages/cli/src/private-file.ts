import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { UsageError } from "./args";

type FileIdentity = {
  dev: number;
  ino: number;
};

const sameFile = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const isNodeError = (
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === code;

/**
 * Atomically publish sensitive content at a new path. The staged file is
 * private from creation, the destination must not already exist, and inode
 * checks make path replacement during publication fail closed.
 */
type PublishNewPrivateFileOptions = {
  target: string;
  content: string | Uint8Array;
  flag: string;
  afterPublish?: () => Promise<void>;
};

export const publishNewPrivateFile = async ({
  target,
  content,
  flag,
  afterPublish,
}: PublishNewPrivateFileOptions): Promise<void> => {
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.tmp`,
  );
  let published = false;
  let committed = false;
  let stagedIdentity: FileIdentity | undefined;
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );

  try {
    const opened = await handle.stat();
    stagedIdentity = opened;
    const staged = await lstat(temporary);
    if (
      !opened.isFile() ||
      !staged.isFile() ||
      staged.isSymbolicLink() ||
      !sameFile(opened, staged)
    ) {
      throw new Error("private staging file changed while it was being used");
    }

    await handle.writeFile(content);
    await handle.sync();

    const ready = await lstat(temporary);
    if (!ready.isFile() || ready.isSymbolicLink() || !sameFile(opened, ready)) {
      throw new Error("private staging file changed before publication");
    }

    try {
      await link(temporary, target);
      published = true;
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new UsageError(
          `${flag} refuses to overwrite existing path "${target}"`,
        );
      }
      throw error;
    }

    const destination = await lstat(target);
    if (
      !destination.isFile() ||
      destination.isSymbolicLink() ||
      !sameFile(opened, destination)
    ) {
      throw new Error("private file publication was not atomic");
    }

    await handle.chmod(0o600);
    await handle.sync();
    await afterPublish?.();
    committed = true;
  } finally {
    if (!committed) {
      await handle.truncate(0).catch(() => undefined);
      await handle.sync().catch(() => undefined);
      await handle.chmod(0o000).catch(() => undefined);
    }
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);

    if (published && !committed && stagedIdentity !== undefined) {
      const destination = await lstat(target).catch(() => undefined);
      if (destination !== undefined && sameFile(stagedIdentity, destination)) {
        await unlink(target).catch(() => undefined);
      }
    }
  }
};
