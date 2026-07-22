import { describe, expect, test } from "bun:test";

import {
  CAPABILITY_PARITY_PROFILES,
  CAPABILITY_SURFACES,
  type CapabilitySurfaceId,
} from "@stll/anonymize/capabilities";

import {
  anonymizeDocx,
  extractDocxText,
  restoreDocxText,
  rewriteDocxText,
} from "../index";

const nodeDocumentSurface: Partial<Record<CapabilitySurfaceId, unknown>> = {
  "document.docx.extract": extractDocxText,
  "document.docx.rewrite": rewriteDocxText,
  "document.docx.anonymize": anonymizeDocx,
  "document.docx.restore": restoreDocxText,
};
const DOCX_SURFACE_PREFIX = "document.docx.";

describe("DOCX runtime surface parity", () => {
  test("Node exposes every DOCX surface in its parity profiles", () => {
    const expected = CAPABILITY_SURFACES.filter(
      ({ id, profile }) =>
        id.startsWith(DOCX_SURFACE_PREFIX) &&
        profile === "document" &&
        CAPABILITY_PARITY_PROFILES[profile].includes("node"),
    );

    for (const { id } of expected) {
      expect(typeof nodeDocumentSurface[id]).toBe("function");
    }
  });
});
