import { expect, test } from "bun:test";

import { isLegalFormsEnabled } from "../types";

test("legal-form detection stays enabled for legacy callers omitting the flag", () => {
  expect(isLegalFormsEnabled({})).toBe(true);
  expect(isLegalFormsEnabled({ enableLegalForms: true })).toBe(true);
  expect(isLegalFormsEnabled({ enableLegalForms: false })).toBe(false);
});
