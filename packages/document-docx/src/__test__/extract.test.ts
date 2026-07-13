import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";

import {
  DOCX_ENTRY_MAX_BYTES,
  DOCX_XML_MAX_DEPTH,
  DocxExtractionError,
  extractDocxText,
} from "../index";

const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const WORD_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPE_PREFIX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.";

type PartInput = {
  path: string;
  contentTypeSuffix: string;
  xml: string;
};

const docx = (
  parts: readonly PartInput[],
  relationshipType = `${RELATIONSHIP_NAMESPACE}/officeDocument`,
): Uint8Array => {
  const overrides = parts
    .map(
      ({ contentTypeSuffix, path }) =>
        `<Override PartName="/${path}" ContentType="${CONTENT_TYPE_PREFIX}${contentTypeSuffix}"/>`,
    )
    .join("");
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="${CONTENT_TYPES_NAMESPACE}">${overrides}</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${relationshipType}" Target="word/document.xml"/></Relationships>`,
    ),
    ...Object.fromEntries(parts.map(({ path, xml }) => [path, strToU8(xml)])),
  });
};

const wordDocument = (body: string): string =>
  `<w:document xmlns:w="${WORD_NAMESPACE}" xmlns:r="${RELATIONSHIP_NAMESPACE}"><w:body>${body}</w:body></w:document>`;

describe("extractDocxText", () => {
  test("extracts WordprocessingML parts with structural and inline locations", () => {
    const archive = docx([
      {
        path: "word/document.xml",
        contentTypeSuffix: "document.main+xml",
        xml: wordDocument(
          [
            "<w:p>",
            "<w:r><w:t>Hello </w:t></w:r>",
            '<w:hyperlink r:id="rId5" w:anchor="bookmark"><w:r><w:t>Alice</w:t></w:r></w:hyperlink>',
            '<w:ins w:id="1"><w:r><w:t> added</w:t></w:r></w:ins>',
            '<w:del w:id="2"><w:r><w:delText> removed</w:delText></w:r></w:del>',
            '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="w"/><mc:Fallback/></mc:AlternateContent>',
            "<w:r><w:tab/><w:br/></w:r>",
            "</w:p>",
            "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
            "<w:p><w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>Box</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p>",
            '<w:p><w:r><w:instrText>DATE</w:instrText><w:sym w:char="F041"/></w:r></w:p>',
          ].join(""),
        ),
      },
      {
        path: "word/header1.xml",
        contentTypeSuffix: "header+xml",
        xml: `<w:hdr xmlns:w="${WORD_NAMESPACE}"><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>`,
      },
      {
        path: "word/footer1.xml",
        contentTypeSuffix: "footer+xml",
        xml: `<w:ftr xmlns:w="${WORD_NAMESPACE}"><w:p><w:r><w:t>Footer</w:t></w:r></w:p></w:ftr>`,
      },
      {
        path: "word/footnotes.xml",
        contentTypeSuffix: "footnotes+xml",
        xml: `<w:footnotes xmlns:w="${WORD_NAMESPACE}"><w:footnote w:id="1"><w:p><w:r><w:t>Footnote</w:t></w:r></w:p></w:footnote></w:footnotes>`,
      },
      {
        path: "word/glossary/document.xml",
        contentTypeSuffix: "document.glossary+xml",
        xml: `<w:glossaryDocument xmlns:w="${WORD_NAMESPACE}"/>`,
      },
    ]);

    const result = extractDocxText(archive);

    expect(result.contractVersion).toBe(1);
    expect(result.blocks.map(({ text }) => text)).toEqual([
      "Hello Alice added removed\t\n",
      "Cell",
      "",
      "Box",
      "",
      "Header",
      "Footer",
      "Footnote",
    ]);
    expect(result.blocks[1]?.location.type).toBe("table-cell-paragraph");
    expect(result.blocks[3]?.location.type).toBe("text-box-paragraph");

    const firstSegments = result.blocks[0]?.segments ?? [];
    expect(
      firstSegments.find(({ contexts }) =>
        contexts.some((context) => context.type === "hyperlink"),
      ),
    ).toMatchObject({
      start: 6,
      end: 11,
      contexts: [
        {
          type: "hyperlink",
          relationshipId: "rId5",
          anchor: "bookmark",
        },
      ],
    });
    expect(
      firstSegments
        .flatMap(({ contexts }) => contexts)
        .filter((context) => context.type === "revision"),
    ).toEqual([
      { type: "revision", revision: "insertion" },
      { type: "revision", revision: "deletion" },
    ]);
    expect(result.coverage).toMatchObject({
      hyperlinkTextSegmentCount: 1,
      revisionTextSegmentCount: 2,
      unsupportedAlternateContentCount: 1,
      unsupportedFieldInstructionCount: 1,
      unsupportedSymbolCount: 1,
    });
    expect(result.coverage.parts).toContainEqual({
      status: "unsupported",
      path: "word/glossary/document.xml",
      contentType: `${CONTENT_TYPE_PREFIX}document.glossary+xml`,
      reason: "WordprocessingML part type is not extracted",
    });
  });

  test("uses namespace URIs rather than assuming WordprocessingML prefixes", () => {
    const strictNamespace = "http://purl.oclc.org/ooxml/wordprocessingml/main";
    const result = extractDocxText(
      docx([
        {
          path: "word/document.xml",
          contentTypeSuffix: "document.main+xml",
          xml: `<x:document xmlns:x="${strictNamespace}"><x:body><x:p><x:r><x:t>Strict</x:t></x:r></x:p></x:body></x:document>`,
        },
      ]),
    );
    expect(result.blocks.map(({ text }) => text)).toEqual(["Strict"]);
  });

  test("rejects packages without exactly one declared main document", () => {
    expect(() => extractDocxText(zipSync({}))).toThrow(DocxExtractionError);
    expect(() =>
      extractDocxText(
        docx([
          {
            path: "word/header1.xml",
            contentTypeSuffix: "header+xml",
            xml: `<w:hdr xmlns:w="${WORD_NAMESPACE}"/>`,
          },
        ]),
      ),
    ).toThrow("exactly one main document");
  });

  test("rejects a package whose root relationship disagrees with its main part", () => {
    const archive = docx([
      {
        path: "word/alternate.xml",
        contentTypeSuffix: "document.main+xml",
        xml: wordDocument("<w:p><w:r><w:t>Text</w:t></w:r></w:p>"),
      },
    ]);
    expect(() => extractDocxText(archive)).toThrow(
      "relationship and content type do not agree",
    );
  });

  test("requires a standard office-document relationship type", () => {
    const archive = docx(
      [
        {
          path: "word/document.xml",
          contentTypeSuffix: "document.main+xml",
          xml: wordDocument("<w:p/>"),
        },
      ],
      "https://example.invalid/officeDocument",
    );
    expect(() => extractDocxText(archive)).toThrow(
      "exactly one main-document relationship",
    );
  });

  test("rejects document type declarations in package XML", () => {
    const archive = docx([
      {
        path: "word/document.xml",
        contentTypeSuffix: "document.main+xml",
        xml: `<!DOCTYPE document><w:document xmlns:w="${WORD_NAMESPACE}"><w:body/></w:document>`,
      },
    ]);
    expect(() => extractDocxText(archive)).toThrow(
      "must not contain a document type declaration",
    );
  });

  test("rejects XML nesting deep enough to exhaust parser memory", () => {
    const nestedRuns = "<w:r>".repeat(DOCX_XML_MAX_DEPTH);
    const closingRuns = "</w:r>".repeat(DOCX_XML_MAX_DEPTH);
    const archive = docx([
      {
        path: "word/document.xml",
        contentTypeSuffix: "document.main+xml",
        xml: wordDocument(`<w:p>${nestedRuns}${closingRuns}</w:p>`),
      },
    ]);
    expect(() => extractDocxText(archive)).toThrow(
      `must not exceed ${DOCX_XML_MAX_DEPTH} nested elements`,
    );
  });

  test("rejects WordprocessingML text outside a mapped paragraph", () => {
    const archive = docx([
      {
        path: "word/document.xml",
        contentTypeSuffix: "document.main+xml",
        xml: wordDocument("<w:r><w:t>Unmapped</w:t></w:r>"),
      },
    ]);
    expect(() => extractDocxText(archive)).toThrow(
      "text is outside a paragraph",
    );
  });

  test("rejects unsafe entry paths and oversized expanded parts before extraction", () => {
    const unsafe = zipSync({
      "../word/document.xml": strToU8("unsafe"),
    });
    expect(() => extractDocxText(unsafe)).toThrow("unsafe entry path");

    const oversized = zipSync({
      "word/document.xml": new Uint8Array(DOCX_ENTRY_MAX_BYTES + 1),
    });
    expect(() => extractDocxText(oversized)).toThrow(
      `must not exceed ${DOCX_ENTRY_MAX_BYTES} bytes`,
    );
  });
});
