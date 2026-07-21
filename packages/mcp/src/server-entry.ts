#!/usr/bin/env node

import { runServer } from "./server";

runServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "MCP startup failed";
  process.stderr.write(`stella-anonymize-mcp: ${message}\n`);
  process.exitCode = 1;
});
