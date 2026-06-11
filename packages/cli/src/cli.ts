#!/usr/bin/env node
/* npm-distributed entry point — backs the CLI with the
 * native engine (@stll/text-search napi bindings). */
import * as anonymize from "@stll/anonymize";

import { runCli } from "./main";

await runCli(anonymize);
