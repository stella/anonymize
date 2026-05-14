import { describe, expect, test } from "bun:test";

import * as fromConstants from "../constants";
import * as fromRoot from "../index";

describe("@stll/anonymize/constants subpath parity", () => {
  test("DEFAULT_ENTITY_LABELS is the same array via either entrypoint", () => {
    expect([...fromConstants.DEFAULT_ENTITY_LABELS]).toEqual([
      ...fromRoot.DEFAULT_ENTITY_LABELS,
    ]);
  });

  test("DETECTION_SOURCES is the same object via either entrypoint", () => {
    expect(fromConstants.DETECTION_SOURCES).toEqual(fromRoot.DETECTION_SOURCES);
  });

  test("DETECTOR_PRIORITY is the same map via either entrypoint", () => {
    expect(fromConstants.DETECTOR_PRIORITY).toEqual(fromRoot.DETECTOR_PRIORITY);
  });

  test("OPERATOR_TYPES is the same array via either entrypoint", () => {
    expect([...fromConstants.OPERATOR_TYPES]).toEqual([
      ...fromRoot.OPERATOR_TYPES,
    ]);
  });
});
