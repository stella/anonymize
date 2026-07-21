import { createHash } from "node:crypto";

type ParseVerifiedArtifactOptions<Result> = {
  readonly bytes: Uint8Array;
  readonly expectedSha256: string;
  readonly name: string;
  readonly parse: (bytes: Uint8Array) => Result | Promise<Result>;
};

export const parseVerifiedArtifact = async <Result>({
  bytes,
  expectedSha256,
  name,
  parse,
}: ParseVerifiedArtifactOptions<Result>): Promise<Result> => {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error(`${name} has an invalid pinned SHA-256 digest`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(`${name} checksum mismatch before parsing`);
  }
  return parse(bytes);
};
