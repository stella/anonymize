import { expect, test } from "bun:test";

import {
  createPipelineContext,
  getNameCorpusNonWesternNames,
  initNameCorpus,
} from "@stll/anonymize";

test("built runtime can load bundled non-Western name data", async () => {
  const context = createPipelineContext();
  await initNameCorpus(context);
  expect(getNameCorpusNonWesternNames(context).length).toBeGreaterThan(0);
});
