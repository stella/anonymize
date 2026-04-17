/* Native entry point — loads TextSearch from
 * @stll/text-search and re-exports the full API. */

import { TextSearch } from "@stll/text-search";

import { initTextSearch } from "./search-engine";

initTextSearch(TextSearch);

export * from "./index-shared";
