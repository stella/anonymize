import { describe, expect, test } from "bun:test";

import type { VerdictsFile, VerdictSpan } from "../types";
import { judgedVerdictsByKey, validateVerdicts } from "../verdicts";

const TEXT = "Jane Doe works at Acme Corp in Prague.";

const span = (overrides: Partial<VerdictSpan>): VerdictSpan => ({
  start: 0,
  end: 8,
  value: "Jane Doe",
  label: "person",
  verdict: "tp",
  ...overrides,
});

const file = (spans: VerdictSpan[]): VerdictsFile => ({
  docId: "acc-1:ex10.htm",
  sha256: "abc123",
  spans,
});

describe("validateVerdicts", () => {
  test("accepts spans that quote the document verbatim", () => {
    const verdicts = file([
      span({}),
      span({
        start: 18,
        end: 27,
        value: "Acme Corp",
        label: "organization",
        verdict: "fn",
      }),
    ]);
    expect(validateVerdicts({ verdicts, text: TEXT })).toEqual([]);
  });

  test("flags value mismatches without leaking the span or document text", () => {
    const issues = validateVerdicts({
      verdicts: file([span({ value: "Jane Roe" })]),
      text: TEXT,
    });
    expect(issues).toHaveLength(1);
    const { message } = issues[0] ?? { message: "" };
    expect(message).toContain("value mismatch");
    // Case-law verdict text is sensitive: the message reports lengths and
    // hashes, never the verbatim span value or document slice.
    expect(message).not.toContain("Jane Roe");
    expect(message).not.toContain("Jane Doe");
  });

  test("flags out-of-range and inverted offsets", () => {
    const issues = validateVerdicts({
      verdicts: file([
        span({ start: -1 }),
        span({ start: 8, end: 8, value: "" }),
        span({ end: TEXT.length + 1 }),
      ]),
      text: TEXT,
    });
    expect(issues.map((issue) => issue.spanIndex)).toEqual([0, 1, 2]);
  });

  test("flags unknown verdict values", () => {
    // SAFETY: intentionally malformed input for the validator.
    const bad = span({ verdict: "maybe" as VerdictSpan["verdict"] });
    const issues = validateVerdicts({ verdicts: file([bad]), text: TEXT });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('unknown verdict "maybe"');
  });
});

describe("judgedVerdictsByKey", () => {
  test("keys verdicts by offsets and label", () => {
    const byKey = judgedVerdictsByKey(
      file([
        span({}),
        span({
          start: 18,
          end: 27,
          value: "Acme Corp",
          label: "organization",
          verdict: "fn",
        }),
      ]),
    );
    expect(byKey.get("0:8:person")?.verdict).toBe("tp");
    expect(byKey.get("18:27:organization")?.verdict).toBe("fn");
    expect(byKey.get("18:27:organization")?.value).toBe("Acme Corp");
    expect(byKey.has("0:8:organization")).toBe(false);
  });

  test("handles missing verdict files", () => {
    expect(judgedVerdictsByKey(null).size).toBe(0);
  });
});
