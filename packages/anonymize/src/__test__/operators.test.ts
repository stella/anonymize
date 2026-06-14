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
    expect(op.apply("Alice Smith", "person", "[PERSON_1]", "[REDACTED]")).toBe(
      "[PERSON_1]",
    );
  });

  test("redact is irreversible and emits the redact string", () => {
    const op = OPERATOR_REGISTRY.redact;
    expect(op.reversibility).toBe("irreversible");
    expect(op.apply("Alice Smith", "person", "[PERSON_1]", "[REDACTED]")).toBe(
      "[REDACTED]",
    );
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
