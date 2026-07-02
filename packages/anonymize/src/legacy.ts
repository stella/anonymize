/* Internal parity entry point for the pre-native TypeScript pipeline.
 * Do not export this from package.json. Product runtimes should use the
 * Rust-native SDK exposed by index.ts and native-node.ts.
 */

import { TextSearch } from "@stll/text-search";

import { initTextSearch } from "./search-engine";

initTextSearch(TextSearch);

export * from "./index-shared";
