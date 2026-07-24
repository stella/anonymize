import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  LocalAnonymizeService,
  PathScope,
  createAnonymizeMcpServer,
} from "./local";
import { DurableSessionStore } from "./durable-sessions";

export const SERVER_HELP = `Usage: stella-anonymize-mcp --root <absolute-directory> [--root <absolute-directory> ...]

Options:
  --root <path>         Allow local input and output paths under this root (repeatable).
  --session-dir <path>  Persist encrypted session archives in this existing private directory.
  --key-file <path>     Read the exact 32-byte raw archive key from this private regular file.
  --pdftoppm <path>     Configure the Poppler executable for PDF tools (default: pdftoppm).
  --tesseract <path>    Configure the Tesseract executable for PDF tools (default: tesseract).
  --help                Print this help.

--session-dir and --key-file must be supplied together. Without both, sessions remain in memory.
`;

export type ServerArguments = {
  help: boolean;
  keyFile?: string;
  roots: string[];
  sessionDirectory?: string;
  pdftoppmPath?: string;
  tesseractPath?: string;
};

type ShutdownSignal = "SIGINT" | "SIGTERM";

type ShutdownSignalSource = {
  off: (signal: ShutdownSignal, listener: () => void) => unknown;
  once: (signal: ShutdownSignal, listener: () => void) => unknown;
};

type McpLifecycleOptions = {
  closeServer: () => Promise<void>;
  closeService: () => Promise<void>;
  connect: () => Promise<void>;
  onTransportClose: (listener: () => void) => void;
  signalSource?: ShutdownSignalSource;
};

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export const runMcpLifecycle = async ({
  closeServer,
  closeService,
  connect,
  onTransportClose,
  signalSource = process,
}: McpLifecycleOptions): Promise<void> => {
  let complete: (() => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  const completion = new Promise<void>((resolvePromise, rejectPromise) => {
    complete = resolvePromise;
    fail = rejectPromise;
  });
  let connectPromise = Promise.resolve();
  let shutdownPromise: Promise<void> | undefined;
  const requestShutdown = (): void => {
    shutdownPromise ??= (async () => {
      await connectPromise.catch(() => undefined);
      try {
        await closeServer();
      } finally {
        await closeService();
      }
    })();
    void shutdownPromise.then(complete, fail);
  };
  onTransportClose(requestShutdown);
  for (const signal of SHUTDOWN_SIGNALS) {
    signalSource.once(signal, requestShutdown);
  }
  connectPromise = Promise.resolve().then(connect);
  try {
    await connectPromise;
    await completion;
  } catch (error) {
    requestShutdown();
    await shutdownPromise?.catch(() => undefined);
    throw error;
  } finally {
    for (const signal of SHUTDOWN_SIGNALS) {
      signalSource.off(signal, requestShutdown);
    }
  }
};

const optionValue = (
  arguments_: readonly string[],
  index: number,
  option: string,
): string => {
  const value = arguments_.at(index + 1);
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a path`);
  }
  return value;
};

export const parseServerArguments = (
  arguments_: readonly string[],
): ServerArguments => {
  const roots: string[] = [];
  let keyFile: string | undefined;
  let pdftoppmPath: string | undefined;
  let sessionDirectory: string | undefined;
  let tesseractPath: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") {
      return { help: true, roots: [] };
    }
    if (argument === "--root") {
      roots.push(optionValue(arguments_, index, "--root"));
      index += 1;
      continue;
    }
    if (argument === "--session-dir") {
      if (sessionDirectory !== undefined) {
        throw new Error("--session-dir may be supplied only once");
      }
      sessionDirectory = optionValue(arguments_, index, "--session-dir");
      index += 1;
      continue;
    }
    if (argument === "--key-file") {
      if (keyFile !== undefined) {
        throw new Error("--key-file may be supplied only once");
      }
      keyFile = optionValue(arguments_, index, "--key-file");
      index += 1;
      continue;
    }
    if (argument === "--pdftoppm") {
      if (pdftoppmPath !== undefined) {
        throw new Error("--pdftoppm may be supplied only once");
      }
      pdftoppmPath = optionValue(arguments_, index, "--pdftoppm");
      index += 1;
      continue;
    }
    if (argument === "--tesseract") {
      if (tesseractPath !== undefined) {
        throw new Error("--tesseract may be supplied only once");
      }
      tesseractPath = optionValue(arguments_, index, "--tesseract");
      index += 1;
      continue;
    }
    throw new Error(`Unsupported MCP argument: ${argument ?? ""}`);
  }
  if ((sessionDirectory === undefined) !== (keyFile === undefined)) {
    throw new Error("--session-dir and --key-file must be supplied together");
  }
  return {
    help: false,
    roots,
    ...(keyFile === undefined ? {} : { keyFile }),
    ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
    ...(pdftoppmPath === undefined ? {} : { pdftoppmPath }),
    ...(tesseractPath === undefined ? {} : { tesseractPath }),
  };
};

export const runServer = async (): Promise<void> => {
  const arguments_ = parseServerArguments(process.argv.slice(2));
  if (arguments_.help) {
    process.stdout.write(SERVER_HELP);
    return;
  }
  const scope = await PathScope.create(arguments_.roots);
  const durableSessions =
    arguments_.keyFile === undefined ||
    arguments_.sessionDirectory === undefined
      ? undefined
      : await DurableSessionStore.create({
          keyFile: arguments_.keyFile,
          sessionDirectory: arguments_.sessionDirectory,
        });
  const service = new LocalAnonymizeService(scope, {
    ...(durableSessions === undefined ? {} : { durableSessions }),
    pdfProvider: {
      ...(arguments_.pdftoppmPath === undefined
        ? {}
        : { pdftoppmPath: arguments_.pdftoppmPath }),
      ...(arguments_.tesseractPath === undefined
        ? {}
        : { tesseractPath: arguments_.tesseractPath }),
    },
  });
  const server = createAnonymizeMcpServer(service);
  const transport = new StdioServerTransport();
  await runMcpLifecycle({
    closeServer: () => server.close(),
    closeService: () => service.close(),
    connect: () => server.connect(transport),
    onTransportClose: (listener) => {
      server.server.onclose = listener;
    },
  });
};
