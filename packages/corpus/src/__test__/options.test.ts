import { describe, expect, test } from "bun:test";

import { dateRangeOptions, positiveIntegerOption } from "../options";

describe("positiveIntegerOption", () => {
  test("uses the fallback when the option is absent", () => {
    expect(
      positiveIntegerOption({ name: "limit", value: undefined, fallback: 25 }),
    ).toBe(25);
  });

  test("accepts positive integers", () => {
    expect(
      positiveIntegerOption({ name: "pages", value: "3", fallback: 1 }),
    ).toBe(3);
  });

  test("rejects malformed and non-positive values", () => {
    for (const value of ["nope", "0", "-1", "1.5", "Infinity"]) {
      expect(() =>
        positiveIntegerOption({ name: "limit", value, fallback: 25 }),
      ).toThrow("--limit must be a positive integer");
    }
  });
});

describe("dateRangeOptions", () => {
  test("returns no range when both options are absent", () => {
    expect(
      dateRangeOptions({ startDate: undefined, endDate: undefined }),
    ).toBeUndefined();
  });

  test("accepts an inclusive ISO date range", () => {
    expect(
      dateRangeOptions({ startDate: "2026-07-17", endDate: "2026-07-19" }),
    ).toEqual({ startDate: "2026-07-17", endDate: "2026-07-19" });
  });

  test("accepts a single-day range", () => {
    expect(
      dateRangeOptions({ startDate: "2026-07-17", endDate: "2026-07-17" }),
    ).toEqual({ startDate: "2026-07-17", endDate: "2026-07-17" });
  });

  test("requires both boundaries", () => {
    expect(() =>
      dateRangeOptions({ startDate: "2026-07-17", endDate: undefined }),
    ).toThrow("--start-date and --end-date must be provided together");
    expect(() =>
      dateRangeOptions({ startDate: undefined, endDate: "2026-07-19" }),
    ).toThrow("--start-date and --end-date must be provided together");
  });

  test("rejects malformed and impossible dates", () => {
    expect(() =>
      dateRangeOptions({ startDate: "07/17/2026", endDate: "2026-07-19" }),
    ).toThrow("--start-date must use YYYY-MM-DD");
    expect(() =>
      dateRangeOptions({ startDate: "2026-02-30", endDate: "2026-07-19" }),
    ).toThrow("--start-date must be a valid date");
  });

  test("rejects a descending range", () => {
    expect(() =>
      dateRangeOptions({ startDate: "2026-07-20", endDate: "2026-07-19" }),
    ).toThrow("--start-date must be on or before --end-date");
  });
});
