import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { SERVER_HELP, parseServerArguments, runMcpLifecycle } from "../server";

describe("MCP server arguments", () => {
  test("keeps sessions in memory unless both durable paths are explicit", () => {
    expect(parseServerArguments(["--root", "/workspace"])).toEqual({
      help: false,
      roots: ["/workspace"],
    });
    expect(
      parseServerArguments([
        "--root",
        "/workspace",
        "--session-dir",
        "/sessions",
        "--key-file",
        "/key",
        "--session-ttl-seconds",
        "3600",
      ]),
    ).toEqual({
      help: false,
      keyFile: "/key",
      roots: ["/workspace"],
      sessionDirectory: "/sessions",
      sessionTtlSeconds: 3600,
    });
    expect(() =>
      parseServerArguments([
        "--root",
        "/workspace",
        "--session-dir",
        "/sessions",
      ]),
    ).toThrow("must be supplied together");
    expect(() => parseServerArguments(["--root=/workspace"])).toThrow(
      "Unsupported MCP argument",
    );
    expect(() =>
      parseServerArguments([
        "--root",
        "/workspace",
        "--session-ttl-seconds",
        "3600",
      ]),
    ).toThrow("requires durable session paths");
    for (const ttl of ["0", "59", "31536001", "1.5", "-1"]) {
      expect(() =>
        parseServerArguments([
          "--root",
          "/workspace",
          "--session-dir",
          "/sessions",
          "--key-file",
          "/key",
          "--session-ttl-seconds",
          ttl,
        ]),
      ).toThrow();
    }
  });

  test("documents the raw key format and prints help without roots", () => {
    expect(parseServerArguments(["--help"])).toEqual({
      help: true,
      roots: [],
    });
    expect(SERVER_HELP).toContain("exact 32-byte raw archive key");
    expect(SERVER_HELP).toContain("default: 604800");
  });

  test("serializes signal and transport shutdown while connect is in flight", async () => {
    const signals = new EventEmitter();
    const events: string[] = [];
    let finishConnect: (() => void) | undefined;
    let transportClose: (() => void) | undefined;
    const lifecycle = runMcpLifecycle({
      closeServer: async () => {
        events.push("server-close");
        transportClose?.();
      },
      closeService: async () => {
        events.push("service-close");
      },
      connect: async () => {
        events.push("connect-start");
        await new Promise<void>((resolvePromise) => {
          finishConnect = resolvePromise;
        });
        events.push("connect-finish");
      },
      onTransportClose: (listener) => {
        transportClose = listener;
      },
      signalSource: signals,
    });
    await Promise.resolve();
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    expect(events).toEqual(["connect-start"]);
    finishConnect?.();
    await lifecycle;
    expect(events).toEqual([
      "connect-start",
      "connect-finish",
      "server-close",
      "service-close",
    ]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  test("closes the service once when the transport closes", async () => {
    const signals = new EventEmitter();
    let transportClose: (() => void) | undefined;
    let serverCloseCount = 0;
    let serviceCloseCount = 0;
    const lifecycle = runMcpLifecycle({
      closeServer: async () => {
        serverCloseCount += 1;
      },
      closeService: async () => {
        serviceCloseCount += 1;
      },
      connect: async () => undefined,
      onTransportClose: (listener) => {
        transportClose = listener;
      },
      signalSource: signals,
    });
    await Promise.resolve();
    transportClose?.();
    transportClose?.();
    await lifecycle;
    expect(serverCloseCount).toBe(1);
    expect(serviceCloseCount).toBe(1);
  });
});
