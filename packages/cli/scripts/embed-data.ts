/* Builds the gzipped dictionary blob the standalone
 * binary embeds (see src/dictionaries-embedded.ts).
 * Uses the npm loader so both distribution channels
 * ship byte-identical dictionary data. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadCliDictionaries } from "../src/dictionaries";

const outDir = join(import.meta.dir, "..", ".embedded");
mkdirSync(outDir, { recursive: true });

const dictionaries = await loadCliDictionaries({});
const json = JSON.stringify(dictionaries);
const gz = Bun.gzipSync(Buffer.from(json));
writeFileSync(join(outDir, "dictionaries.json.gz"), gz);

const mb = (n: number): string => (n / 1e6).toFixed(1);
console.log(
  `embed-data: ${mb(json.length)} MB JSON -> ${mb(gz.byteLength)} MB gzip`,
);
