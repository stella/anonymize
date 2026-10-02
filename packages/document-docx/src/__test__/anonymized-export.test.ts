import { describe, expect, test } from "bun:test";
import {
  loadNativeAnonymizeBinding,
  setNativeBindingOverride,
} from "@stll/anonymize";
import { strToU8, unzipSync, zipSync } from "fflate";

import {
  DocxAnonymizedExportError,
  rewriteDocxForAnonymizedExport,
} from "../index";
import type { DocxExtraction } from "../types";

const CONTENT_TYPES =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const OFFICE_RELS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELS =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const WORD_CONTENT =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.";

const documentWithMetadata = (extraEntries: Record<string, Uint8Array> = {}) =>
  zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="${CONTENT_TYPES}"><Override PartName="/word/document.xml" ContentType="${WORD_CONTENT}document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${OFFICE_RELS}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="${PACKAGE_RELS}/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${WORD}"><w:body><w:p w:rsidR="00112233"><w:bookmarkStart w:id="1" w:name="Private Bookmark"/><w:r><w:t>Alice signed.</w:t></w:r></w:p></w:body></w:document>`,
    ),
    "docProps/core.xml": strToU8(
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><cp:keywords>Private metadata</cp:keywords></cp:coreProperties>',
    ),
    ...extraEntries,
  });

const redactFirstName =
  (replacement: string) => async (extraction: DocxExtraction) => {
    const block = extraction.blocks.at(0);
    if (block === undefined) {
      throw new Error("test fixture must contain one text block");
    }
    return [
      {
        location: block.location,
        expectedText: block.text,
        replacements: [{ start: 0, end: 5, replacement }],
      },
    ];
  };

const exportOutcome = async (replacement: string) => {
  try {
    const result = await rewriteDocxForAnonymizedExport({
      document: documentWithMetadata(),
      planRewrites: redactFirstName(replacement),
    });
    return { result, error: undefined };
  } catch (error) {
    return { result: undefined, error };
  }
};

describe("rewriteDocxForAnonymizedExport", () => {
  test("plans against sanitized extraction and validates the final document", async () => {
    const result = await rewriteDocxForAnonymizedExport({
      document: documentWithMetadata(),
      planRewrites: async (extraction) => {
        const block = extraction.blocks.at(0);
        if (block === undefined) {
          throw new Error("test fixture must contain one text block");
        }
        expect(block.text).toBe("Alice signed.");
        return [
          {
            location: block.location,
            expectedText: block.text,
            replacements: [{ start: 0, end: 5, replacement: "█████" }],
          },
        ];
      },
    });

    const entries = unzipSync(result.document);
    expect(entries["docProps/core.xml"]).toBeUndefined();
    const documentXml = new TextDecoder().decode(entries["word/document.xml"]);
    expect(documentXml).toContain("█████ signed.");
    expect(documentXml).not.toContain("Private Bookmark");
    expect(documentXml).not.toContain("00112233");
    expect(result.report).toMatchObject({
      contractVersion: 1,
      removedPartCount: 1,
    });
  });

  test("returns a fixed safe error for unsupported package content", async () => {
    let caught: unknown;
    try {
      await rewriteDocxForAnonymizedExport({
        document: documentWithMetadata({
          "word/media/private-name.png": new Uint8Array([137, 80, 78, 71]),
        }),
        planRewrites: async () => [],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocxAnonymizedExportError);
    expect(caught).toMatchObject({
      code: "unsupported-document",
      message: "The DOCX contains content unsupported by anonymized export",
    });
    expect(JSON.stringify(caught)).not.toContain("private-name");
  });

  test("rejects a NUL replacement and returns no document", async () => {
    const { result, error } = await exportOutcome("\u0000");
    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(DocxAnonymizedExportError);
    expect(error).toMatchObject({ code: "invalid-rewrite-plan" });
  });

  test("returns validation-failed and no document when finalization rejects", async () => {
    const binding = loadNativeAnonymizeBinding();
    const finalized: Uint8Array[] = [];
    setNativeBindingOverride(
      new Proxy(binding, {
        get: (target, key, receiver) =>
          key === "finalizeDocxAnonymizedExportNative"
            ? (document: Uint8Array) => {
                finalized.push(document);
                throw new Error("unsupported-replacement: synthetic failure");
              }
            : Reflect.get(target, key, receiver),
      }),
    );
    let outcome: Awaited<ReturnType<typeof exportOutcome>>;
    try {
      outcome = await exportOutcome("█████");
    } finally {
      setNativeBindingOverride(undefined);
    }

    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(DocxAnonymizedExportError);
    expect(outcome.error).toMatchObject({
      code: "validation-failed",
      message: "The anonymized DOCX did not pass export validation",
    });
    expect(finalized).toHaveLength(1);
    const rewritten = finalized.at(0);
    if (rewritten === undefined) {
      throw new Error("finalization must receive the rewritten document");
    }
    const documentXml = new TextDecoder().decode(
      unzipSync(rewritten)["word/document.xml"],
    );
    expect(documentXml).toContain("█████ signed.");
  });
});
