import { describe, expect, test } from "bun:test";

import {
  applyValidations,
  compileValidations,
  expandTriggerGroups,
} from "../triggers";
import type {
  TriggerGroupConfig,
  TriggerValidation,
} from "../../types";

// ── Validation tests ────────────────────────────────

describe("compileValidations + applyValidations", () => {
  test("starts-uppercase rejects lowercase", () => {
    const compiled = compileValidations([
      { type: "starts-uppercase" },
    ]);
    expect(applyValidations("Jan Novák", compiled))
      .toBe(true);
    expect(applyValidations("jan novák", compiled))
      .toBe(false);
    expect(applyValidations("Ředitel", compiled))
      .toBe(true);
    expect(applyValidations("ředitel", compiled))
      .toBe(false);
  });

  test("min-length rejects short text", () => {
    const compiled = compileValidations([
      { type: "min-length", min: 3 },
    ]);
    expect(applyValidations("ab", compiled))
      .toBe(false);
    expect(applyValidations("abc", compiled))
      .toBe(true);
  });

  test("max-length rejects long text", () => {
    const compiled = compileValidations([
      { type: "max-length", max: 5 },
    ]);
    expect(applyValidations("abcde", compiled))
      .toBe(true);
    expect(applyValidations("abcdef", compiled))
      .toBe(false);
  });

  test("no-digits rejects text with digits", () => {
    const compiled = compileValidations([
      { type: "no-digits" },
    ]);
    expect(applyValidations("hello", compiled))
      .toBe(true);
    expect(applyValidations("hello1", compiled))
      .toBe(false);
  });

  test("has-digits requires digits", () => {
    const compiled = compileValidations([
      { type: "has-digits" },
    ]);
    expect(applyValidations("abc123", compiled))
      .toBe(true);
    expect(applyValidations("abc", compiled))
      .toBe(false);
  });

  test("matches-pattern validates datová schránka", () => {
    const compiled = compileValidations([
      {
        type: "matches-pattern",
        pattern: "^[a-z0-9]{7}$",
        flags: "i",
      },
    ]);
    expect(applyValidations("hsaxra8", compiled))
      .toBe(true);
    expect(applyValidations("ABC1234", compiled))
      .toBe(true);
    // Too short
    expect(applyValidations("abc12", compiled))
      .toBe(false);
    // Too long
    expect(applyValidations("abc12345", compiled))
      .toBe(false);
    // Invalid chars
    expect(applyValidations("abc-123", compiled))
      .toBe(false);
  });

  test(
    "multiple validations: all must pass",
    () => {
      const validations: TriggerValidation[] = [
        { type: "starts-uppercase" },
        { type: "min-length", min: 3 },
      ];
      const compiled = compileValidations(validations);
      // Uppercase + long enough → pass
      expect(
        applyValidations("Jan", compiled),
      ).toBe(true);
      // Lowercase → fail (starts-uppercase)
      expect(
        applyValidations("jan", compiled),
      ).toBe(false);
      // Uppercase but too short → fail (min-length)
      expect(
        applyValidations("Ja", compiled),
      ).toBe(false);
    },
  );
});

// ── Extension tests ─────────────────────────────────

describe("expandTriggerGroups", () => {
  test("add-colon generates colon variants", () => {
    const groups: TriggerGroupConfig[] = [
      {
        triggers: ["zastoupen"],
        label: "person",
        strategy: { type: "to-next-comma" },
        extensions: ["add-colon"],
      },
    ];
    const rules = expandTriggerGroups(groups);
    const triggers = rules.map((r) => r.trigger);
    expect(triggers).toContain("zastoupen");
    expect(triggers).toContain("zastoupen:");
    expect(rules.length).toBe(2);
  });

  test(
    "add-trailing-space generates space variants",
    () => {
      const groups: TriggerGroupConfig[] = [
        {
          triggers: ["pan"],
          label: "person",
          strategy: { type: "to-next-comma" },
          extensions: ["add-trailing-space"],
        },
      ];
      const rules = expandTriggerGroups(groups);
      const triggers = rules.map((r) => r.trigger);
      expect(triggers).toContain("pan");
      expect(triggers).toContain("pan ");
    },
  );

  test(
    "add-colon-space generates colon-space variants",
    () => {
      const groups: TriggerGroupConfig[] = [
        {
          triggers: ["oddíl"],
          label: "registration number",
          strategy: {
            type: "n-words",
            count: 1,
          },
          extensions: ["add-colon-space"],
        },
      ];
      const rules = expandTriggerGroups(groups);
      const triggers = rules.map((r) => r.trigger);
      expect(triggers).toContain("oddíl");
      expect(triggers).toContain("oddíl: ");
    },
  );

  test(
    "normalize-spaces generates NBSP variants",
    () => {
      const groups: TriggerGroupConfig[] = [
        {
          triggers: ["datová schránka"],
          label: "registration number",
          strategy: {
            type: "n-words",
            count: 1,
          },
          extensions: ["normalize-spaces"],
        },
      ];
      const rules = expandTriggerGroups(groups);
      const triggers = rules.map((r) => r.trigger);
      expect(triggers).toContain("datová schránka");
      expect(triggers).toContain(
        "datová\u00A0schránka",
      );
    },
  );

  test(
    "normalize-spaces skips single-word triggers",
    () => {
      const groups: TriggerGroupConfig[] = [
        {
          triggers: ["IČO"],
          label: "registration number",
          strategy: { type: "company-id-value" },
          extensions: ["normalize-spaces"],
        },
      ];
      const rules = expandTriggerGroups(groups);
      // No space in "IČO", so no NBSP variant
      expect(rules.length).toBe(1);
    },
  );

  test(
    "multiple extensions combine correctly",
    () => {
      const groups: TriggerGroupConfig[] = [
        {
          triggers: ["oddíl"],
          label: "registration number",
          strategy: {
            type: "n-words",
            count: 1,
          },
          extensions: [
            "add-colon",
            "add-trailing-space",
          ],
        },
      ];
      const rules = expandTriggerGroups(groups);
      const triggers = rules.map((r) => r.trigger);
      expect(triggers).toContain("oddíl");
      expect(triggers).toContain("oddíl:");
      expect(triggers).toContain("oddíl ");
      expect(rules.length).toBe(3);
    },
  );

  test(
    "deduplicates identical trigger strings",
    () => {
      const groups: TriggerGroupConfig[] = [
        {
          // "test:" already in base triggers,
          // add-colon would generate it again
          triggers: ["test", "test:"],
          label: "test",
          strategy: { type: "to-next-comma" },
          extensions: ["add-colon"],
        },
      ];
      const rules = expandTriggerGroups(groups);
      const triggers = rules.map((r) => r.trigger);
      // Set deduplication: "test", "test:", "test::"
      // "test:" appears once (not duplicated)
      const colonCount = triggers.filter(
        (t) => t === "test:",
      ).length;
      expect(colonCount).toBe(1);
    },
  );

  test(
    "validations are shared across expanded rules",
    () => {
      const groups: TriggerGroupConfig[] = [
        {
          triggers: ["zastoupen"],
          label: "person",
          strategy: { type: "to-next-comma" },
          extensions: ["add-colon"],
          validations: [
            { type: "starts-uppercase" },
          ],
        },
      ];
      const rules = expandTriggerGroups(groups);
      // Both "zastoupen" and "zastoupen:" share
      // the same compiled validations
      expect(rules.length).toBe(2);
      for (const rule of rules) {
        expect(rule.validations.length).toBe(1);
        expect(rule.validations[0]?.type)
          .toBe("starts-uppercase");
      }
    },
  );
});
