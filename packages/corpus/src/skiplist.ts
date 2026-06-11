import { SKIPLIST_PATH } from "./paths";
import type { SkipEntry, SkipList } from "./types";

export const loadSkipList = async (): Promise<SkipList> => {
  const file = Bun.file(SKIPLIST_PATH);
  if (!(await file.exists())) {
    return { entries: [] };
  }
  // SAFETY: the skip list is only written by saveSkipList below.
  return (await file.json()) as SkipList;
};

/** Entries sorted by id so skip-list diffs stay reviewable. */
export const saveSkipList = async (skipList: SkipList): Promise<void> => {
  const sorted: SkipList = {
    entries: [...skipList.entries].sort((a, b) => a.id.localeCompare(b.id)),
  };
  await Bun.write(SKIPLIST_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
};

export type SkipMergeResult = {
  skipList: SkipList;
  added: SkipEntry[];
};

/** Merge new skip entries, ignoring ids already recorded. */
export const mergeSkipEntries = (
  skipList: SkipList,
  entries: readonly SkipEntry[],
): SkipMergeResult => {
  const known = new Set(skipList.entries.map((entry) => entry.id));
  const added: SkipEntry[] = [];
  for (const entry of entries) {
    if (known.has(entry.id)) {
      continue;
    }
    known.add(entry.id);
    added.push(entry);
  }
  return {
    skipList: { entries: [...skipList.entries, ...added] },
    added,
  };
};
