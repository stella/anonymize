import { describe, expect, test } from "bun:test";

import {
  DEFAULT_OPERATOR_CONFIG,
  OPERATOR_REGISTRY,
  resolveOperator,
} from "../operators";

describe("OPERATOR_REGISTRY", () => {
  test("replace is reversible and emits the placeholder", () => {
    const op = OPERATOR_REGISTRY.replace;
    expect(op.reversibility).toBe("reversible");
    expect(
      op.apply("Alice Smith", "person", "[PERSON_1]", "[REDACTED]", "replace"),
    ).toBe("[PERSON_1]");
  });

  test("redact is irreversible and emits the redact string", () => {
    const op = OPERATOR_REGISTRY.redact;
    expect(op.reversibility).toBe("irreversible");
    expect(
      op.apply("Alice Smith", "person", "[PERSON_1]", "[REDACTED]", "redact"),
    ).toBe("[REDACTED]");
  });

  test("mask rejects configurations outside the native contract bounds", () => {
    const mask = OPERATOR_REGISTRY.mask;
    const oversizedGrapheme = `a${"\u{301}".repeat(32)}`;

    expect(() =>
      mask.apply("Alice", "person", "[PERSON_1]", "[REDACTED]", {
        type: "mask",
        maskingCharacter: oversizedGrapheme,
        charactersToMask: 2,
        direction: "end",
      }),
    ).toThrow("maskingCharacter must not exceed 64 UTF-8 bytes");
    expect(() =>
      mask.apply("Alice", "person", "[PERSON_1]", "[REDACTED]", {
        type: "mask",
        maskingCharacter: "*",
        charactersToMask: 0x1_0000_0000,
        direction: "start",
      }),
    ).toThrow("charactersToMask must be a positive 32-bit integer");
  });
});

describe("resolveOperator", () => {
  test("defaults to replace for unconfigured labels", () => {
    expect(resolveOperator(DEFAULT_OPERATOR_CONFIG, "person")).toBe("replace");
  });

  test("returns the configured operator, defaulting others to replace", () => {
    const config = {
      operators: { person: "redact" as const },
      redactString: "x",
    };
    expect(resolveOperator(config, "person")).toBe("redact");
    expect(resolveOperator(config, "email address")).toBe("replace");
  });
});
