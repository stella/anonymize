import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";

import {
  DOCX_ENTRY_MAX_BYTES,
  DOCX_XML_MAX_DEPTH,
  DocxExtractionError,
  extractDocxText,
} from "../index";
import { extractDocxTextTypeScriptOracle } from "../extract";

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

    expect(result).toEqual(extractDocxTextTypeScriptOracle(archive));

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
          xml: `<x:document xmlns:x="${strictNamespace}"><x:body><x:p><x:r><x:t><![CDATA[Strict &]]></x:t></x:r></x:p></x:body></x:document>`,
        },
      ]),
    );
    expect(result.blocks.map(({ text }) => text)).toEqual(["Strict &"]);
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

  test("flags a PII-bearing external relationship target as unsupported even without redactable display text", () => {
    // The relationship is never referenced by any <w:hyperlink> in the body
    // (e.g. an icon-only or orphaned hyperlink), so the visible text has no
    // hyperlink context and hyperlinkTextSegmentCount stays 0. Without
    // reading word/_rels/document.xml.rels, coverage would never see the
    // mailto: target and would incorrectly report full coverage.
    const archive = zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${CONTENT_TYPE_PREFIX}document.main+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        wordDocument("<w:p><w:r><w:t>Contact us</w:t></w:r></w:p>"),
      ),
      "word/_rels/document.xml.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId5" Type="${RELATIONSHIP_NAMESPACE}/hyperlink" Target="mailto:alice@example.test" TargetMode="External"/></Relationships>`,
      ),
    });

    const result = extractDocxText(archive);

    expect(result.coverage.hyperlinkTextSegmentCount).toBe(0);
    expect(result.coverage.parts).toContainEqual({
      status: "unsupported",
      path: "word/_rels/document.xml.rels",
      contentType: "application/vnd.openxmlformats-package.relationships+xml",
      reason:
        'Relationship "rId5" target uses a PII-bearing external scheme (mailto/tel) that anonymization does not redact',
    });
  });

  test("flags a PII-bearing external target in the package root relationships part", () => {
    // The root relationships part (_rels/.rels) sits outside word/, so a
    // scan restricted to WordprocessingML-part relationships would miss an
    // extra mailto:/tel: relationship placed there and report full coverage
    // while the rewritten archive retained the target.
    const archive = zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${CONTENT_TYPE_PREFIX}document.main+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="word/document.xml"/><Relationship Id="rId9" Type="${RELATIONSHIP_NAMESPACE}/hyperlink" Target="mailto:alice@example.test" TargetMode="External"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        wordDocument("<w:p><w:r><w:t>No PII in the body</w:t></w:r></w:p>"),
      ),
    });

    const result = extractDocxText(archive);

    expect(result.coverage.parts).toContainEqual({
      status: "unsupported",
      path: "_rels/.rels",
      contentType: "application/vnd.openxmlformats-package.relationships+xml",
      reason:
        'Relationship "rId9" target uses a PII-bearing external scheme (mailto/tel) that anonymization does not redact',
    });
  });

  test("flags any external relationship target, not just mailto/tel schemes", () => {
    // An orphaned or icon-only hyperlink can smuggle PII inside an
    // ordinary web URL (userinfo, path, query, fragment) with no visible
    // display text; the target is preserved verbatim by the rewrite, so
    // every external target is uncovered.
    const archive = zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${CONTENT_TYPE_PREFIX}document.main+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        wordDocument("<w:p><w:r><w:t>Contact us</w:t></w:r></w:p>"),
      ),
      "word/_rels/document.xml.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId7" Type="${RELATIONSHIP_NAMESPACE}/hyperlink" Target="https://example.test/?email=alice@example.test" TargetMode="External"/></Relationships>`,
      ),
    });

    const result = extractDocxText(archive);

    expect(result.coverage.parts).toContainEqual({
      status: "unsupported",
      path: "word/_rels/document.xml.rels",
      contentType: "application/vnd.openxmlformats-package.relationships+xml",
      reason:
        'Relationship "rId7" target is external and is not examined or redacted by anonymization',
    });
  });

  test("flags a dangling internal relationship target", () => {
    // A relationship whose Target has no scheme and no TargetMode looks
    // internal, but "alice@example.test" resolves to no package entry: the
    // PII-bearing string survives verbatim in the retained .rels XML, so
    // it must surface as uncovered instead of letting require-full pass.
    const archive = zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${CONTENT_TYPE_PREFIX}document.main+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="word/document.xml"/><Relationship Id="rId8" Type="${RELATIONSHIP_NAMESPACE}/hyperlink" Target="alice@example.test"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        wordDocument("<w:p><w:r><w:t>No PII in the body</w:t></w:r></w:p>"),
      ),
    });

    const result = extractDocxText(archive);

    expect(result.coverage.parts).toContainEqual({
      status: "unsupported",
      path: "_rels/.rels",
      contentType: "application/vnd.openxmlformats-package.relationships+xml",
      reason:
        'Relationship "rId8" target does not resolve to a package part and is not examined or redacted by anonymization',
    });
  });

  test("keeps resolving internal relationship targets unflagged", () => {
    // Relative, package-absolute, and percent-encoded internal targets
    // that resolve to real archive entries are covered by the parts they
    // address; the relationships part itself must not be flagged.
    const archive = zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${CONTENT_TYPE_PREFIX}document.main+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="/word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        wordDocument("<w:p><w:r><w:t>No PII in the body</w:t></w:r></w:p>"),
      ),
      "word/_rels/document.xml.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId2" Type="${RELATIONSHIP_NAMESPACE}/image" Target="media/image%201.png"/><Relationship Id="rId3" Type="${RELATIONSHIP_NAMESPACE}/settings" Target="../word/document.xml"/></Relationships>`,
      ),
      "word/media/image 1.png": new Uint8Array([137, 80, 78, 71]),
    });

    const result = extractDocxText(archive);

    expect(
      result.coverage.parts.filter(
        (item) =>
          item.status === "unsupported" &&
          (item.path === "_rels/.rels" ||
            item.path === "word/_rels/document.xml.rels"),
      ),
    ).toEqual([]);
  });

  test("keeps internal relationship targets covered by part-level coverage", () => {
    // Internal targets address parts inside the package; those parts get
    // their own coverage entries, so the relationship itself is not
    // flagged and a minimal internal-only package stays fully covered.
    const archive = zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${CONTENT_TYPE_PREFIX}document.main+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        wordDocument("<w:p><w:r><w:t>No links here</w:t></w:r></w:p>"),
      ),
    });

    const result = extractDocxText(archive);

    expect(
      result.coverage.parts.filter(({ status }) => status === "unsupported"),
    ).toEqual([]);
  });

  test("flags a non-conventional docProps part as uncovered metadata", () => {
    // A properties relationship may address docProps/custom2.xml rather
    // than a conventional core/app/custom filename; the part must still be
    // retained and flagged instead of silently surviving the rewrite.
    const archive = zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${CONTENT_TYPE_PREFIX}document.main+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        wordDocument("<w:p><w:r><w:t>No PII in the body</w:t></w:r></w:p>"),
      ),
      "docProps/custom2.xml": strToU8(
        '<Properties><property name="owner">Alice Example</property></Properties>',
      ),
    });

    const result = extractDocxText(archive);

    expect(result.coverage.parts).toContainEqual({
      status: "unsupported",
      path: "docProps/custom2.xml",
      contentType: "application/xml",
      reason: "Document metadata parts are not extracted or redacted",
    });
  });

  test("flags a metadata content type declared at a non-docProps path", () => {
    // Coverage keys on the declared properties content type too, so a
    // custom-properties part relocated outside docProps/ is still flagged.
    const archive = zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${CONTENT_TYPE_PREFIX}document.main+xml"/><Override PartName="/meta/props.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        wordDocument("<w:p><w:r><w:t>No PII in the body</w:t></w:r></w:p>"),
      ),
      "meta/props.xml": strToU8(
        '<Properties><property name="owner">Alice Example</property></Properties>',
      ),
    });

    const result = extractDocxText(archive);

    expect(result.coverage.parts).toContainEqual({
      status: "unsupported",
      path: "meta/props.xml",
      contentType:
        "application/vnd.openxmlformats-officedocument.custom-properties+xml",
      reason: "Document metadata parts are not extracted or redacted",
    });
  });

  test("flags undeclared and unexamined archive entries as uncovered", () => {
    // Entries the retention filter drops (media, arbitrary extra files)
    // are preserved verbatim by the rewrite; the coverage inventory must
    // surface them instead of letting require-full report full.
    const archive = zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${CONTENT_TYPE_PREFIX}document.main+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        wordDocument("<w:p><w:r><w:t>No PII in the body</w:t></w:r></w:p>"),
      ),
      "word/media/image1.png": new Uint8Array([137, 80, 78, 71]),
      "extra/notes.txt": strToU8("Call Alice at 604 123 456"),
    });

    const result = extractDocxText(archive);

    expect(result.coverage.parts).toContainEqual({
      status: "unsupported",
      path: "word/media/image1.png",
      contentType: "application/octet-stream",
      reason: "Package part is not examined by anonymization",
    });
    expect(result.coverage.parts).toContainEqual({
      status: "unsupported",
      path: "extra/notes.txt",
      contentType: "application/octet-stream",
      reason: "Package part is not examined by anonymization",
    });
  });

  test("flags declared non-WordprocessingML payload parts as uncovered", () => {
    // Charts, diagrams, and embedded objects carry document text but are
    // not extracted; a declared part of any unhandled content type is
    // flagged rather than silently preserved.
    const archive = zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${CONTENT_TYPE_PREFIX}document.main+xml"/><Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        wordDocument("<w:p><w:r><w:t>No PII in the body</w:t></w:r></w:p>"),
      ),
      "word/charts/chart1.xml": strToU8("<chart>Alice revenue</chart>"),
    });

    const result = extractDocxText(archive);

    expect(result.coverage.parts).toContainEqual({
      status: "unsupported",
      path: "word/charts/chart1.xml",
      contentType:
        "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
      reason: "Package part type is not extracted or redacted",
    });
  });

  test("flags docProps/core.xml as unsupported instead of silently treating metadata as fully covered", () => {
    const archive = zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${CONTENT_TYPE_PREFIX}document.main+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        wordDocument("<w:p><w:r><w:t>No PII in the body</w:t></w:r></w:p>"),
      ),
      "docProps/core.xml": strToU8(
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Alice Example</dc:creator></cp:coreProperties>',
      ),
    });

    const result = extractDocxText(archive);

    expect(result.coverage.parts).toContainEqual({
      status: "unsupported",
      path: "docProps/core.xml",
      contentType: "application/vnd.openxmlformats-package.core-properties+xml",
      reason: "Document metadata parts are not extracted or redacted",
    });
  });
});
