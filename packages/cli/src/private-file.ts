import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { UsageError } from "./args";

const isNodeError = (
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === code;

/**
 * Create sensitive content at a new path through one descriptor. Failed
 * dependent work leaves an empty mode-000 reservation: pathname cleanup could
 * otherwise unlink a replacement installed by another process.
 */
type PublishNewPrivateFileOptions = {
  target: string;
  content: string | Uint8Array;
  flag: string;
  afterPublish?: (identity: FileIdentity) => Promise<void>;
};

export type FileIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
};

type WriteFileWithoutIdentityCollisionOptions = {
  target: string;
  content: string | Uint8Array;
  targetFlag: string;
  forbiddenFlag: string;
  forbiddenIdentity: FileIdentity;
};

/**
 * Open an output before truncating it, then reject aliases to a protected
 * descriptor. Path replacement after open cannot redirect descriptor writes.
 */
export const writeFileWithoutIdentityCollision = async ({
  target,
  content,
  targetFlag,
  forbiddenFlag,
  forbiddenIdentity,
}: WriteFileWithoutIdentityCollisionOptions): Promise<void> => {
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT);
  try {
    const stats = await handle.stat({ bigint: true });
    if (
      stats.dev === forbiddenIdentity.device &&
      stats.ino === forbiddenIdentity.inode
    ) {
      throw new UsageError(
        `${targetFlag} "${target}" aliases ${forbiddenFlag}`,
      );
    }
    await handle.truncate(0);
    await handle.writeFile(content);
  } finally {
    await handle.close().catch(() => undefined);
  }
};

export const publishNewPrivateFile = async ({
  target,
  content,
  flag,
  afterPublish,
}: PublishNewPrivateFileOptions): Promise<void> => {
  if (process.platform === "win32") {
    throw new UsageError(
      `${flag} is unavailable on Windows because owner-only file ACLs cannot be verified`,
    );
  }

  let handle;
  try {
    handle = await open(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o000,
    );
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new UsageError(
        `${flag} refuses to overwrite existing path "${target}"`,
      );
    }
    throw error;
  }

  let committed = false;
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) {
      throw new Error("private file destination is not a regular file");
    }

    await handle.writeFile(content);
    await handle.sync();
    await handle.chmod(0o600);
    await handle.sync();
    await afterPublish?.({ device: stats.dev, inode: stats.ino });
    committed = true;
  } finally {
    if (!committed) {
      await handle.truncate(0).catch(() => undefined);
      await handle.sync().catch(() => undefined);
      await handle.chmod(0o000).catch(() => undefined);
    }
    await handle.close().catch(() => undefined);
  }
};
