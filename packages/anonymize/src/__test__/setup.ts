// Bind the native TextSearch implementation before any test imports the
// config-building layer (build-unified-search -> search-engine). The prepared
// native-config builders instantiate TextSearch via getTextSearch(), so it must
// be initialised at preload time.
import { TextSearch } from "@stll/text-search";

import { initTextSearch } from "../search-engine";

initTextSearch(TextSearch);
