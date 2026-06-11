#!/usr/bin/env node
/* npm-distributed entry point — backs the CLI with the
 * native engine (@stll/text-search napi bindings) and
 * the @stll/anonymize-data dictionary package. */
import * as anonymize from "@stll/anonymize";

import { loadCliDictionaries } from "./dictionaries";
import { runCli } from "./main";

await runCli({ api: anonymize, loadDictionaries: loadCliDictionaries });
