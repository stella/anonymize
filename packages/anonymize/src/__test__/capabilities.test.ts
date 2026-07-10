import { describe, expect, test } from "bun:test";

import {
  CAPABILITY_MANIFEST,
  CAPABILITY_MANIFEST_SCHEMA_VERSION,
  CAPABILITY_RUNTIMES,
} from "../capabilities";
import { ENTITY_CAPABILITIES } from "../constants";

describe("capability manifest", () => {
  test("wraps the canonical entity capabilities in a versioned contract", () => {
    expect(CAPABILITY_MANIFEST.schemaVersion).toBe(
      CAPABILITY_MANIFEST_SCHEMA_VERSION,
    );
    expect(CAPABILITY_MANIFEST.entities).toBe(ENTITY_CAPABILITIES);
  });

  test("declares the equivalent native runtime surfaces", () => {
    expect(CAPABILITY_RUNTIMES).toEqual(["node", "python", "wasm"]);
    expect(CAPABILITY_MANIFEST.runtimes).toBe(CAPABILITY_RUNTIMES);
  });

  test("round-trips as deterministic JSON", () => {
    const serialized = JSON.stringify(CAPABILITY_MANIFEST);

    expect(JSON.parse(serialized)).toEqual(CAPABILITY_MANIFEST);
    expect(serialized).not.toContain("generatedAt");
  });
});
