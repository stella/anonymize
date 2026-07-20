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

describe("DOCX runtime surface parity", () => {
  test("Node exposes every document-profile surface", () => {
    const expected = CAPABILITY_SURFACES.filter(
      ({ profile }) =>
        profile === "document" &&
        CAPABILITY_PARITY_PROFILES[profile].includes("node"),
    );

    for (const { id } of expected) {
      expect(typeof nodeDocumentSurface[id]).toBe("function");
    }
  });
});
