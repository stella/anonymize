import { createHash } from "node:crypto";

export type ProviderInputIdentity = {
  readonly inputBytes: number;
  readonly inputCharacters: number;
  readonly inputSha256: string;
};

export const computeProviderInputIdentity = (
  inputText: string,
): ProviderInputIdentity => ({
  inputBytes: new TextEncoder().encode(inputText).length,
  inputCharacters: inputText.length,
  inputSha256: createHash("sha256").update(inputText, "utf8").digest("hex"),
});

export const assertProviderInputIdentity = (
  expected: ProviderInputIdentity,
  inputText: string,
): ProviderInputIdentity => {
  const actual = computeProviderInputIdentity(inputText);
  if (
    expected.inputBytes !== actual.inputBytes ||
    expected.inputCharacters !== actual.inputCharacters ||
    expected.inputSha256 !== actual.inputSha256
  ) {
    throw new Error("provider worker received mismatched input identity");
  }
  return actual;
};
