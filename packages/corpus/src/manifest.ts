import { MANIFEST_PATH } from "./paths";
import type { Manifest, ManifestEntry } from "./types";

export const loadManifest = async (): Promise<Manifest> => {
  const file = Bun.file(MANIFEST_PATH);
  if (!(await file.exists())) {
    return { entries: [] };
  }
  // SAFETY: the manifest is only written by saveManifest below;
  // a malformed file fails loudly downstream (sha mismatch).
  return (await file.json()) as Manifest;
};

/** Entries sorted by id so manifest diffs stay reviewable. */
export const saveManifest = async (manifest: Manifest): Promise<void> => {
  const sorted: Manifest = {
    entries: [...manifest.entries].sort((a, b) => a.id.localeCompare(b.id)),
  };
  await Bun.write(MANIFEST_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
};

export type MergeResult = {
  manifest: Manifest;
  added: ManifestEntry[];
  skipped: ManifestEntry[];
};

/** Merge new entries, skipping ids already in the manifest. */
export const mergeManifestEntries = (
  manifest: Manifest,
  entries: readonly ManifestEntry[],
): MergeResult => {
  const known = new Set(manifest.entries.map((entry) => entry.id));
  const added: ManifestEntry[] = [];
  const skipped: ManifestEntry[] = [];
  for (const entry of entries) {
    if (known.has(entry.id)) {
      skipped.push(entry);
      continue;
    }
    known.add(entry.id);
    added.push(entry);
  }
  return {
    manifest: { entries: [...manifest.entries, ...added] },
    added,
    skipped,
  };
};
