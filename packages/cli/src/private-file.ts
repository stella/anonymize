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
  afterPublish?: () => Promise<void>;
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
    if (!(await handle.stat()).isFile()) {
      throw new Error("private file destination is not a regular file");
    }

    await handle.writeFile(content);
    await handle.sync();
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
  }
};
