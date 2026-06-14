import { describe, expect, test } from "bun:test";

import { chunkText, chunkTextWithOffsets } from "../util/chunker";

describe("chunkTextWithOffsets", () => {
  test("each chunk sits exactly at its reported offset", () => {
    // Long text with a repeated boilerplate phrase, so a later
    // chunk's content also appears earlier in the document — the
    // exact case that mis-locates an indexOf-based offset search.
    const boiler = "This Agreement is governed by the laws of the State. ";
    const body = boiler.repeat(80); // well over MAX_CHUNK_CHARS

    const chunks = chunkTextWithOffsets(body);
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(body.startsWith(chunk.text, chunk.offset)).toBe(true);
      expect(body.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(
        chunk.text,
      );
    }
  });

  test("chunkText returns the same texts the offset variant carries", () => {
    const body = "Some sentence here. ".repeat(200);
    expect(chunkText(body)).toEqual(
      chunkTextWithOffsets(body).map((chunk) => chunk.text),
    );
  });
});
