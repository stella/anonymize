/* Dictionary loader for the standalone binary. Reads one
 * gzipped JSON blob embedded at compile time (see
 * scripts/embed-data.ts) instead of importing
 * @stll/anonymize-data, so the bundle carries ~2 MB of
 * compressed data instead of ~9 MB of JSON modules. */
import type { Dictionaries } from "@stll/anonymize";

import embeddedDictionariesPath from "../.embedded/dictionaries.json.gz" with { type: "file" };

import type { DictionaryScope } from "./dictionary-scope";
import { filterDictionaries } from "./dictionary-scope";

/** Load and scope the embedded dictionary blob. */
export const loadEmbeddedDictionaries = async (
  scope: DictionaryScope,
): Promise<Dictionaries> => {
  const bytes = await Bun.file(embeddedDictionariesPath).arrayBuffer();
  const json = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(bytes)));
  return filterDictionaries(JSON.parse(json) as Dictionaries, scope);
};
