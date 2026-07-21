import { describe, expect, test } from "bun:test";

import {
  CAPABILITY_PARITY_PROFILES,
  CAPABILITY_SURFACES,
  type CapabilitySurfaceId,
} from "@stll/anonymize/capabilities";

import {
  PDF_DECOMPRESSED_MAX_BYTES,
  PDF_DOCUMENT_MAX_BYTES,
  PDF_MAX_GLYPHS,
  PDF_MAX_OBJECT_DEPTH,
  PDF_MAX_OBJECT_NODES,
  PDF_MAX_OBJECTS,
  PDF_MAX_OBSERVATION_JSON_BYTES,
  PDF_MAX_OBSERVATION_TEXT_UTF8_BYTES,
  PDF_MAX_PAGES,
  PDF_MAX_PAGE_TEXT_UTF8_BYTES,
  inspectPdf,
} from "../index";

const nodeSurface: Partial<Record<CapabilitySurfaceId, unknown>> = {
  "document.pdf.inspect": inspectPdf,
};

describe("PDF inspection runtime surface parity", () => {
  test("Node exposes every PDF document profile surface", () => {
    const expected = CAPABILITY_SURFACES.filter(
      ({ profile }) =>
        profile === "pdf-document" &&
        CAPABILITY_PARITY_PROFILES[profile].includes("node"),
    );
    for (const { id } of expected) {
      expect(typeof nodeSurface[id]).toBe("function");
    }
  });

  test("Node exports every bounded PDF limit", () => {
    expect({
      PDF_DECOMPRESSED_MAX_BYTES,
      PDF_DOCUMENT_MAX_BYTES,
      PDF_MAX_GLYPHS,
      PDF_MAX_OBJECT_DEPTH,
      PDF_MAX_OBJECT_NODES,
      PDF_MAX_OBJECTS,
      PDF_MAX_OBSERVATION_JSON_BYTES,
      PDF_MAX_OBSERVATION_TEXT_UTF8_BYTES,
      PDF_MAX_PAGES,
      PDF_MAX_PAGE_TEXT_UTF8_BYTES,
    }).toEqual({
      PDF_DECOMPRESSED_MAX_BYTES: 128 * 1024 * 1024,
      PDF_DOCUMENT_MAX_BYTES: 64 * 1024 * 1024,
      PDF_MAX_GLYPHS: 5_000_000,
      PDF_MAX_OBJECT_DEPTH: 128,
      PDF_MAX_OBJECT_NODES: 1_000_000,
      PDF_MAX_OBJECTS: 200_000,
      PDF_MAX_OBSERVATION_JSON_BYTES: 256 * 1024 * 1024,
      PDF_MAX_OBSERVATION_TEXT_UTF8_BYTES: 64 * 1024 * 1024,
      PDF_MAX_PAGES: 10_000,
      PDF_MAX_PAGE_TEXT_UTF8_BYTES: 16 * 1024 * 1024,
    });
  });
});
