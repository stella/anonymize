#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  LocalAnonymizeService,
  PathScope,
  createAnonymizeMcpServer,
} from "./local";

const rootsFromArguments = (arguments_: readonly string[]): string[] => {
  const roots: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument?.startsWith("--root=")) {
      roots.push(argument.slice("--root=".length));
      continue;
    }
    if (argument === "--root") {
      const root = arguments_.at(index + 1);
      if (root === undefined) {
        throw new Error("--root requires an absolute directory path");
      }
      roots.push(root);
      index += 1;
      continue;
    }
    throw new Error("Only repeatable --root arguments are supported");
  }
  return roots;
};

const main = async (): Promise<void> => {
  const scope = await PathScope.create(
    rootsFromArguments(process.argv.slice(2)),
  );
  const server = createAnonymizeMcpServer(new LocalAnonymizeService(scope));
  await server.connect(new StdioServerTransport());
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "MCP startup failed";
  process.stderr.write(`stella-anonymize-mcp: ${message}\n`);
  process.exitCode = 1;
});
