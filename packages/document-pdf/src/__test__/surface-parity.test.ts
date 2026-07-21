import { describe, expect, test } from "bun:test";

import {
  CAPABILITY_PARITY_PROFILES,
  CAPABILITY_SURFACES,
  type CapabilitySurfaceId,
} from "@stll/anonymize/capabilities";

import { inspectPdf } from "../index";

const nodeSurface: Partial<Record<CapabilitySurfaceId, unknown>> = {
  "document.pdf.inspect": inspectPdf,
};

describe("PDF inspection runtime surface parity", () => {
  test("PDF inspection is a core capability exposed by Node", () => {
    const capability = CAPABILITY_SURFACES.find(
      ({ id }) => id === "document.pdf.inspect",
    );
    expect(capability?.profile).toBe("core");
    expect(CAPABILITY_PARITY_PROFILES.core).toContain("node");
    expect(typeof nodeSurface["document.pdf.inspect"]).toBe("function");
  });
});
