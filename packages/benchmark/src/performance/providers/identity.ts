import { createHash } from "node:crypto";

export type ProviderEntity = {
  readonly start: number;
  readonly end: number;
  readonly label: string;
};

export const assertProviderEntities = (
  entities: readonly ProviderEntity[],
  inputCharacters: number,
): void => {
  for (const [index, { start, end, label }] of entities.entries()) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > inputCharacters
    ) {
      throw new Error(`provider entity ${index} has an invalid span`);
    }
    if (typeof label !== "string" || label === "") {
      throw new Error(`provider entity ${index} has an invalid label`);
    }
  }
};

export const outputIdentity = (
  entities: readonly ProviderEntity[],
): {
  readonly count: number;
  readonly digest: string;
  readonly labelCounts: Readonly<Record<string, number>>;
} => {
  const hash = createHash("sha256");
  const labelCounts: Record<string, number> = {};
  for (const { start, end, label } of entities) {
    hash.update(`${start}\0${end}\0${label}\n`);
    labelCounts[label] = (labelCounts[label] ?? 0) + 1;
  }
  return {
    count: entities.length,
    digest: hash.digest("hex"),
    labelCounts: Object.fromEntries(
      Object.entries(labelCounts).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
};
