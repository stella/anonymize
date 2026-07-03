import { expect, test } from "bun:test";

import { getDefaultNativePipeline } from "@stll/anonymize";

test("built runtime can load the default native package", () => {
  const pipeline = getDefaultNativePipeline();
  const result = pipeline.redactText("Signed by Jan Novak in Prague.");
  expect(result.resolvedEntities.length).toBeGreaterThan(0);
});
