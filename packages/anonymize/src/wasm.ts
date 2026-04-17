/* Browser/WASM entry point — loads TextSearch
 * from @stll/text-search-wasm and re-exports
 * the full anonymize API. */

import { TextSearch } from "@stll/text-search-wasm";

import { initTextSearch } from "./search-engine";

initTextSearch(TextSearch);

export * from "./index-shared";
