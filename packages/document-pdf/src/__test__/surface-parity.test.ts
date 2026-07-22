import { describe, expect, test } from "bun:test";

import {
  CAPABILITY_PARITY_PROFILES,
  CAPABILITY_SURFACES,
  type CapabilitySurfaceId,
} from "@stll/anonymize/capabilities";

import {
  anonymizePdfRaster,
  inspectPdf,
  rewritePdfRasterFromDetections,
} from "../index";

const nodeSurface: Partial<Record<CapabilitySurfaceId, unknown>> = {
  "document.pdf.inspect": inspectPdf,
  "document.pdf.anonymize-raster": anonymizePdfRaster,
  "document.pdf.rewrite-raster": rewritePdfRasterFromDetections,
};

describe("PDF inspection runtime surface parity", () => {
  test("Node exposes every PDF surface in its parity profiles", () => {
    const expected = CAPABILITY_SURFACES.filter(
      ({ id, profile }) =>
        id.startsWith("document.pdf.") &&
        CAPABILITY_PARITY_PROFILES[profile].includes("node"),
    );

    for (const { id } of expected) {
      expect(typeof nodeSurface[id]).toBe("function");
    }
  });

  test("PDF inspection is a core capability exposed by Node", () => {
    const capability = CAPABILITY_SURFACES.find(
      ({ id }) => id === "document.pdf.inspect",
    );
    expect(capability?.profile).toBe("core");
    expect(CAPABILITY_PARITY_PROFILES.core).toContain("node");
    expect(typeof nodeSurface["document.pdf.inspect"]).toBe("function");
  });

  test("both PDF raster APIs are Node/Python document capabilities", () => {
    const rasterCapabilities = CAPABILITY_SURFACES.filter(
      ({ id }) => id.startsWith("document.pdf.") && id.endsWith("-raster"),
    );
    expect(rasterCapabilities.map(({ id }) => id)).toEqual([
      "document.pdf.anonymize-raster",
      "document.pdf.rewrite-raster",
    ]);
    expect(
      rasterCapabilities.every(({ profile }) => profile === "document"),
    ).toBeTrue();
    expect(CAPABILITY_PARITY_PROFILES.document).toEqual(["node", "python"]);
    expect(typeof nodeSurface["document.pdf.anonymize-raster"]).toBe(
      "function",
    );
    expect(typeof nodeSurface["document.pdf.rewrite-raster"]).toBe("function");
  });
});
