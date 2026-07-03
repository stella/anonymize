import type { Dictionaries } from "../types";

/**
 * Stable per-object identity key for an injected {@link Dictionaries} value.
 *
 * Config-derived cache keys (prepared-package key, name-corpus key) must
 * distinguish two configs that differ only by their injected dictionaries.
 * Dictionaries are large mutable objects with no natural identifier, so we
 * assign each distinct object a monotonic id the first time we see it and reuse
 * it thereafter. `undefined`/`null` (no dictionaries) map to a fixed sentinel.
 *
 * Identity, not deep equality: two structurally identical dictionary objects
 * get different keys. That is the desired behavior for caches keyed by the
 * object a caller actually passed; callers that want cache reuse should reuse
 * the same dictionaries object (as production loaders do).
 */
const dictionaryIds = new WeakMap<Dictionaries, number>();
let nextDictionaryId = 0;

export const dictionaryIdentityKey = (
  dictionaries: Dictionaries | null | undefined,
): string => {
  // null is `typeof object` but not a valid WeakMap key, so guard it here
  // alongside undefined before touching the WeakMap.
  if (dictionaries === undefined || dictionaries === null) {
    return "none";
  }
  const existing = dictionaryIds.get(dictionaries);
  if (existing !== undefined) {
    return `dict:${existing}`;
  }
  nextDictionaryId += 1;
  dictionaryIds.set(dictionaries, nextDictionaryId);
  return `dict:${nextDictionaryId}`;
};
