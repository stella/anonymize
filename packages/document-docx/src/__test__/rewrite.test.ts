import { describe, expect, test } from "bun:test";
import { strToU8, unzipSync, zipSync } from "fflate";

import {
  DocxRewriteError,
  extractDocxText,
  rewriteDocxText,
  type DocxBlockRewrite,
} from "../index";

const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const WORD_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const DOCUMENT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

const docx = (body: string): Uint8Array =>
  zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${DOCUMENT_CONTENT_TYPE}"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${body}</w:body></w:document>`,
    ),
    "word/media/image.bin": new Uint8Array([0, 1, 2, 3, 255]),
  });

const rewriteForFirstBlock = (
  archive: Uint8Array,
  replacements: DocxBlockRewrite["replacements"],
  expectedText?: string,
): DocxBlockRewrite => {
  const block = extractDocxText(archive).blocks.at(0);
  if (block === undefined) {
    throw new Error("test fixture must contain a text block");
  }
  return {
    location: block.location,
    expectedText: expectedText ?? block.text,
    replacements,
  };
};

describe("rewriteDocxText", () => {
  test("rewrites spans across runs while preserving untouched package content", () => {
    const archive = docx(
      [
        "<w:p>",
        "<w:r><w:t>Contact </w:t></w:r>",
        "<w:r><w:t>A&amp;lice</w:t></w:r>",
        '<w:r><w:t xml:space="preserve"> now</w:t></w:r>',
        "</w:p>",
      ].join(""),
    );
    const result = rewriteDocxText(archive, [
      rewriteForFirstBlock(archive, [
        { start: 8, end: 18, replacement: "[PERSON_1]" },
      ]),
    ]);

    expect(result.rewrittenBlockCount).toBe(1);
    expect(result.appliedReplacementCount).toBe(1);
    expect(extractDocxText(result.document).blocks.at(0)?.text).toBe(
      "Contact [PERSON_1]",
    );
    const entries = unzipSync(result.document);
    expect(entries["word/media/image.bin"]).toEqual(
      new Uint8Array([0, 1, 2, 3, 255]),
    );
    const xml = new TextDecoder().decode(entries["word/document.xml"]);
    expect(xml).toContain("<w:r><w:t>Contact </w:t></w:r>");
    expect(xml).toContain("<w:r><w:t>[PERSON_1]</w:t></w:r>");
    expect(xml).toContain('<w:r><w:t xml:space="preserve"></w:t></w:r>');
  });

  test("escapes replacement text and preserves significant boundary spaces", () => {
    const archive = docx("<w:p><w:r><w:t>Alice</w:t ></w:r></w:p>");
    const replacement = " <redacted>& ";
    const result = rewriteDocxText(archive, [
      rewriteForFirstBlock(archive, [{ start: 0, end: 5, replacement }]),
    ]);
    expect(extractDocxText(result.document).blocks.at(0)?.text).toBe(
      replacement,
    );
    const entries = unzipSync(result.document);
    const xml = new TextDecoder().decode(entries["word/document.xml"]);
    expect(xml).toContain(
      '<w:t xml:space="preserve"> &lt;redacted&gt;&amp; </w:t >',
    );
  });

  test("rejects stale, overlapping, and structurally unsupported rewrites", () => {
    const archive = docx(
      "<w:p><w:r><w:t>Alice</w:t><w:tab/><w:t>Smith</w:t></w:r></w:p>",
    );
    expect(() =>
      rewriteDocxText(archive, [
        rewriteForFirstBlock(
          archive,
          [{ start: 0, end: 5, replacement: "[PERSON_1]" }],
          "Different",
        ),
      ]),
    ).toThrow("no longer matches");
    expect(() =>
      rewriteDocxText(archive, [
        rewriteForFirstBlock(archive, [
          { start: 0, end: 5, replacement: "first" },
          { start: 4, end: 7, replacement: "second" },
        ]),
      ]),
    ).toThrow("must not overlap");
    expect(() =>
      rewriteDocxText(archive, [
        rewriteForFirstBlock(archive, [
          { start: 0, end: 11, replacement: "[PERSON_1]" },
        ]),
      ]),
    ).toThrow("contiguous non-revision text segments");
  });

  test("rejects replacement inside tracked revision content", () => {
    const archive = docx(
      '<w:p><w:ins w:id="1"><w:r><w:t>Alice</w:t></w:r></w:ins></w:p>',
    );
    expect(() =>
      rewriteDocxText(archive, [
        rewriteForFirstBlock(archive, [
          { start: 0, end: 5, replacement: "[PERSON_1]" },
        ]),
      ]),
    ).toThrow(DocxRewriteError);
  });

  test("rejects offsets that split a UTF-16 surrogate pair", () => {
    const archive = docx("<w:p><w:r><w:t>😀 Alice</w:t></w:r></w:p>");
    expect(() =>
      rewriteDocxText(archive, [
        rewriteForFirstBlock(archive, [{ start: 1, end: 2, replacement: "x" }]),
      ]),
    ).toThrow("UTF-16 boundaries");
  });

  test("returns an exact archive copy for an empty rewrite plan", () => {
    const archive = docx("<w:p><w:r><w:t>Alice</w:t></w:r></w:p>");
    const result = rewriteDocxText(archive, []);
    expect(result.document).not.toBe(archive);
    expect(result.document).toEqual(archive);
    expect(result).toMatchObject({
      rewrittenBlockCount: 0,
      appliedReplacementCount: 0,
    });
  });

  test("refuses to silently invalidate a package digital signature", () => {
    const archive = docx("<w:p><w:r><w:t>Alice</w:t></w:r></w:p>");
    const entries = unzipSync(archive);
    const signedArchive = zipSync({
      ...entries,
      "_XmlSignatures/sig1.xml": strToU8("<Signature/>"),
    });
    expect(() =>
      rewriteDocxText(signedArchive, [
        rewriteForFirstBlock(signedArchive, [
          { start: 0, end: 5, replacement: "[PERSON_1]" },
        ]),
      ]),
    ).toThrow("must be re-signed");
  });
});
