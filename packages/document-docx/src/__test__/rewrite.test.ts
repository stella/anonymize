import { describe, expect, test } from "bun:test";
import { strToU8, unzipSync, zipSync } from "fflate";

import {
  DOCX_ENTRY_MAX_BYTES,
  DocxExtractionError,
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

test("preserves extraction errors before rewriting", () => {
  let caught: unknown;
  try {
    rewriteDocxText(strToU8("not a DOCX archive"), []);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DocxExtractionError);
  expect((caught as DocxExtractionError).code).toBe("invalid-archive");
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
    let caught: unknown;
    try {
      rewriteDocxText(archive, [
        rewriteForFirstBlock(archive, [
          { start: -1, end: 2, replacement: "x" },
        ]),
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocxRewriteError);
    expect((caught as DocxRewriteError).code).toBe("invalid-replacement");
    caught = undefined;
    try {
      rewriteDocxText(archive, [
        rewriteForFirstBlock(archive, [
          {
            start: 1n as unknown as number,
            end: 2,
            replacement: "x",
          },
        ]),
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocxRewriteError);
    expect((caught as DocxRewriteError).code).toBe("invalid-replacement");
    caught = undefined;
    const oversizedReplacements = [] as Array<
      DocxBlockRewrite["replacements"][number]
    >;
    oversizedReplacements.length = 1_000_001;
    try {
      rewriteDocxText(archive, [
        rewriteForFirstBlock(archive, oversizedReplacements),
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocxRewriteError);
    expect((caught as DocxRewriteError).code).toBe("rewrite-limit-exceeded");
    const cyclicPlan = rewriteForFirstBlock(archive, [
      { start: 3, end: 8, replacement: "Bob" },
    ]) as DocxBlockRewrite & { unexpected?: unknown };
    cyclicPlan.unexpected = cyclicPlan;
    (
      cyclicPlan.location as DocxBlockRewrite["location"] & {
        toJSON?: () => never;
      }
    ).toJSON = () => {
      throw new Error("caller toJSON must not execute");
    };
    const hookedPlans = [cyclicPlan] as (typeof cyclicPlan)[] & {
      toJSON?: () => never;
    };
    hookedPlans.toJSON = () => {
      throw new Error("caller toJSON must not execute");
    };
    const throwingIterator = () => {
      throw new Error("caller iterator must not execute");
    };
    Object.defineProperty(hookedPlans, Symbol.iterator, {
      value: throwingIterator,
    });
    Object.defineProperty(cyclicPlan.replacements, Symbol.iterator, {
      value: throwingIterator,
    });
    const location = cyclicPlan.location as unknown as Record<string, unknown>;
    Object.defineProperty(location["xmlPath"], Symbol.iterator, {
      value: throwingIterator,
    });
    expect(
      extractDocxText(rewriteDocxText(archive, hookedPlans).document).blocks.at(
        0,
      )?.text,
    ).toBe("😀 Bob");
  });

  test("budgets replacement text by its escaped size, not its raw size", () => {
    // rewritePartXml expands "&" to "&amp;" (5 bytes) before materializing
    // the patched XML, so the budgets must count post-escape bytes: a
    // replacement whose raw size fits comfortably under the entry budget can
    // still materialize far past it once escaped.
    const archive = docx("<w:p><w:r><w:t>Alice</w:t></w:r></w:p>");
    const ampersands = "&".repeat(Math.ceil(DOCX_ENTRY_MAX_BYTES / 5) + 1);
    expect(() =>
      rewriteDocxText(archive, [
        rewriteForFirstBlock(archive, [
          { start: 0, end: 5, replacement: ampersands },
        ]),
      ]),
    ).toThrow(
      `DOCX rewrite replacement text for a single part must not exceed ${DOCX_ENTRY_MAX_BYTES} aggregate escaped UTF-8 bytes`,
    );
  });

  test("budgets the projected full part, including untouched scaffolding", () => {
    // The escaped-node budgets alone miss a part's unchanged markup: a
    // near-limit part plus a modest rewrite of one small node must be
    // rejected before the patched XML is materialized, not after.
    const half = Math.ceil(DOCX_ENTRY_MAX_BYTES / 2) + 1024;
    const scaffolding = "X".repeat(half);
    const archive = docx(
      `<w:p><w:r><w:t>${scaffolding}</w:t></w:r></w:p><w:p><w:r><w:t>Alice</w:t></w:r></w:p>`,
    );
    const block = extractDocxText(archive).blocks.at(1);
    if (block === undefined) {
      throw new Error("test fixture must contain a second block");
    }
    expect(() =>
      rewriteDocxText(archive, [
        {
          location: block.location,
          expectedText: block.text,
          replacements: [{ start: 0, end: 5, replacement: "Y".repeat(half) }],
        },
      ]),
    ).toThrow(
      `Rewritten DOCX parts must not exceed ${DOCX_ENTRY_MAX_BYTES} projected bytes`,
    );
  });

  test("budgets the escaped size of whole updated nodes, not just replacements", () => {
    // A CDATA "&" run costs one byte per character on disk but five once
    // escaped, and rewritePartXml re-escapes the entire updated node value
    // on rebuild. A one-byte replacement into such a node must therefore
    // trip the budget even though the replacement itself is tiny.
    const ampersands = "&".repeat(Math.ceil(DOCX_ENTRY_MAX_BYTES / 5) + 1);
    const archive = docx(
      `<w:p><w:r><w:t><![CDATA[${ampersands}]]></w:t></w:r></w:p>`,
    );
    expect(() =>
      rewriteDocxText(archive, [
        rewriteForFirstBlock(archive, [{ start: 0, end: 1, replacement: "x" }]),
      ]),
    ).toThrow(
      `DOCX rewritten text nodes for a single part must not exceed ${DOCX_ENTRY_MAX_BYTES} escaped UTF-8 bytes`,
    );
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
