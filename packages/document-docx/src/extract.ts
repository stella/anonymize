import { unzipSync, type UnzipFileInfo } from "fflate";
import { SaxesParser, type SaxesTagNS } from "saxes";

import {
  DOCX_EXTRACTION_ERROR_CODES,
  DOCX_PART_TYPES,
  type DocxCoverageItem,
  type DocxExtraction,
  type DocxExtractionErrorCode,
  type DocxPart,
  type DocxPartType,
  type DocxTextBlock,
  type DocxTextSegment,
  type DocxInlineContext,
} from "./types";

export const DOCX_EXTRACTION_CONTRACT_VERSION = 1 as const;
export const DOCX_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
export const DOCX_ENTRY_MAX_BYTES = 16 * 1024 * 1024;
export const DOCX_UNCOMPRESSED_MAX_BYTES = 128 * 1024 * 1024;
export const DOCX_XML_MAX_DEPTH = 256;
const DOCX_MAX_ENTRIES = 4096;
const DOCX_MAX_TEXT_BLOCKS = 100_000;
const DOCX_MAX_TEXT_SEGMENTS = 1_000_000;

const CONTENT_TYPES_PATH = "[Content_Types].xml";
const ROOT_RELATIONSHIPS_PATH = "_rels/.rels";
const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const PACKAGE_RELATIONSHIP_NAMESPACES = new Set([
  "http://purl.oclc.org/ooxml/package/relationships",
  "http://schemas.openxmlformats.org/package/2006/relationships",
]);
const WORDPROCESSING_CONTENT_TYPE_PREFIX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.";
const SUPPORTED_CONTENT_TYPE_SUFFIXES: Readonly<Record<string, DocxPartType>> =
  {
    "comments+xml": DOCX_PART_TYPES.comments,
    "document.main+xml": DOCX_PART_TYPES.mainDocument,
    "endnotes+xml": DOCX_PART_TYPES.endnotes,
    "footer+xml": DOCX_PART_TYPES.footer,
    "footnotes+xml": DOCX_PART_TYPES.footnotes,
    "header+xml": DOCX_PART_TYPES.header,
  };
const WORDPROCESSING_NAMESPACES = new Set([
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
]);
const RELATIONSHIP_NAMESPACES = new Set([
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
]);
const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = new Set(
  [...RELATIONSHIP_NAMESPACES].map(
    (namespace) => `${namespace}/officeDocument`,
  ),
);
const MARKUP_COMPATIBILITY_NAMESPACES = new Set([
  "http://purl.oclc.org/ooxml/markup-compatibility/main",
  "http://schemas.openxmlformats.org/markup-compatibility/2006",
]);

export class DocxExtractionError extends Error {
  readonly code: DocxExtractionErrorCode;

  constructor(code: DocxExtractionErrorCode, message: string) {
    super(message);
    this.name = "DocxExtractionError";
    this.code = code;
  }
}

type ContentTypePart = {
  path: string;
  contentType: string;
};

type ElementFrame = {
  tag: SaxesTagNS;
  path: readonly number[];
  nextChildIndex: number;
};

type MutableBlock = {
  text: string;
  segments: DocxTextSegment[];
  location: DocxTextBlock["location"];
};

type PartExtraction = {
  blocks: DocxTextBlock[];
  hyperlinkTextSegmentCount: number;
  revisionTextSegmentCount: number;
  unsupportedAlternateContentCount: number;
  unsupportedSymbolCount: number;
  unsupportedFieldInstructionCount: number;
};

type PartTextBudget = {
  segmentCount: number;
};

const invalidPackage = (message: string): DocxExtractionError =>
  new DocxExtractionError(DOCX_EXTRACTION_ERROR_CODES.invalidPackage, message);

const assertXmlDepth = (depth: number): void => {
  if (depth < DOCX_XML_MAX_DEPTH) {
    return;
  }
  throw new DocxExtractionError(
    DOCX_EXTRACTION_ERROR_CODES.uncompressedLimitExceeded,
    `DOCX XML must not exceed ${DOCX_XML_MAX_DEPTH} nested elements`,
  );
};

const safeEntryPath = (name: string): boolean =>
  name.length > 0 &&
  !name.startsWith("/") &&
  !name.includes("\\") &&
  !name.split("/").includes("..") &&
  !name.includes("\0");

type ArchiveBudget = {
  entryCount: number;
  uncompressedBytes: number;
};

type ArchiveFilterOptions = {
  budget: ArchiveBudget;
  file: UnzipFileInfo;
  includeAllEntries: boolean;
};

const archiveFilter = ({
  budget,
  file,
  includeAllEntries,
}: ArchiveFilterOptions): boolean => {
  budget.entryCount += 1;
  if (budget.entryCount > DOCX_MAX_ENTRIES) {
    throw new DocxExtractionError(
      DOCX_EXTRACTION_ERROR_CODES.uncompressedLimitExceeded,
      `DOCX archives must contain at most ${DOCX_MAX_ENTRIES} entries`,
    );
  }
  if (!safeEntryPath(file.name)) {
    throw new DocxExtractionError(
      DOCX_EXTRACTION_ERROR_CODES.unsafeEntryPath,
      "DOCX archive contains an unsafe entry path",
    );
  }
  if (file.originalSize > DOCX_ENTRY_MAX_BYTES) {
    throw new DocxExtractionError(
      DOCX_EXTRACTION_ERROR_CODES.uncompressedLimitExceeded,
      `DOCX entries must not exceed ${DOCX_ENTRY_MAX_BYTES} bytes`,
    );
  }
  budget.uncompressedBytes += file.originalSize;
  if (budget.uncompressedBytes > DOCX_UNCOMPRESSED_MAX_BYTES) {
    throw new DocxExtractionError(
      DOCX_EXTRACTION_ERROR_CODES.uncompressedLimitExceeded,
      `DOCX archives must not exceed ${DOCX_UNCOMPRESSED_MAX_BYTES} uncompressed bytes`,
    );
  }
  return (
    includeAllEntries ||
    file.name === CONTENT_TYPES_PATH ||
    file.name === ROOT_RELATIONSHIPS_PATH ||
    (file.name.startsWith("word/") && file.name.endsWith(".xml"))
  );
};

export const unzipDocxArchive = (
  archive: Uint8Array,
  includeAllEntries = false,
): Record<string, Uint8Array> => {
  if (archive.byteLength > DOCX_ARCHIVE_MAX_BYTES) {
    throw new DocxExtractionError(
      DOCX_EXTRACTION_ERROR_CODES.archiveLimitExceeded,
      `DOCX archives must not exceed ${DOCX_ARCHIVE_MAX_BYTES} bytes`,
    );
  }
  const budget: ArchiveBudget = { entryCount: 0, uncompressedBytes: 0 };
  try {
    return unzipSync(archive, {
      filter: (file) => archiveFilter({ budget, file, includeAllEntries }),
    });
  } catch (error) {
    if (error instanceof DocxExtractionError) {
      throw error;
    }
    throw new DocxExtractionError(
      DOCX_EXTRACTION_ERROR_CODES.invalidArchive,
      "Input is not a valid bounded DOCX ZIP archive",
    );
  }
};

const decodeXml = (bytes: Uint8Array, path: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocxExtractionError(
      DOCX_EXTRACTION_ERROR_CODES.invalidXml,
      `DOCX XML part is not valid UTF-8: ${path}`,
    );
  }
};

const attributeByLocalName = (
  tag: SaxesTagNS,
  localName: string,
  namespaces?: ReadonlySet<string>,
): string | null => {
  for (const attribute of Object.values(tag.attributes)) {
    if (
      attribute.local === localName &&
      (namespaces === undefined || namespaces.has(attribute.uri))
    ) {
      return attribute.value;
    }
  }
  return null;
};

const parseContentTypes = (xml: string): ContentTypePart[] => {
  const parts: ContentTypePart[] = [];
  const paths = new Set<string>();
  const parser = new SaxesParser({ xmlns: true });
  let parseError: Error | null = null;
  let depth = 0;
  parser.on("error", (error) => {
    parseError = error;
  });
  parser.on("doctype", () => {
    throw invalidPackage(
      "DOCX XML must not contain a document type declaration",
    );
  });
  parser.on("opentag", (tag) => {
    assertXmlDepth(depth);
    depth += 1;
    if (tag.local !== "Override" || tag.uri !== CONTENT_TYPES_NAMESPACE) {
      return;
    }
    const rawPath = attributeByLocalName(tag, "PartName");
    const contentType = attributeByLocalName(tag, "ContentType");
    if (rawPath === null || contentType === null) {
      throw invalidPackage("DOCX content-type override is incomplete");
    }
    const path = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
    if (!safeEntryPath(path)) {
      throw invalidPackage("DOCX content-type override has an unsafe path");
    }
    if (paths.has(path)) {
      throw invalidPackage(
        "DOCX content-type overrides must have unique paths",
      );
    }
    paths.add(path);
    parts.push({ path, contentType });
  });
  parser.on("closetag", () => {
    depth -= 1;
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof DocxExtractionError) {
      throw error;
    }
    parseError = error instanceof Error ? error : new Error("invalid XML");
  }
  if (parseError !== null) {
    throw new DocxExtractionError(
      DOCX_EXTRACTION_ERROR_CODES.invalidXml,
      "DOCX content types are not valid XML",
    );
  }
  return parts;
};

const parseMainDocumentTarget = (xml: string): string => {
  const targets: string[] = [];
  const parser = new SaxesParser({ xmlns: true });
  let parseError: Error | null = null;
  let depth = 0;
  parser.on("error", (error) => {
    parseError = error;
  });
  parser.on("doctype", () => {
    throw invalidPackage(
      "DOCX XML must not contain a document type declaration",
    );
  });
  parser.on("opentag", (tag) => {
    assertXmlDepth(depth);
    depth += 1;
    if (
      tag.local !== "Relationship" ||
      !PACKAGE_RELATIONSHIP_NAMESPACES.has(tag.uri)
    ) {
      return;
    }
    const type = attributeByLocalName(tag, "Type");
    if (type === null || !OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(type)) {
      return;
    }
    const targetMode = attributeByLocalName(tag, "TargetMode");
    const rawTarget = attributeByLocalName(tag, "Target");
    if (targetMode === "External" || rawTarget === null) {
      throw invalidPackage("DOCX main-document relationship must be internal");
    }
    const target = rawTarget.startsWith("/") ? rawTarget.slice(1) : rawTarget;
    if (!safeEntryPath(target) || target.includes(":")) {
      throw invalidPackage(
        "DOCX main-document relationship has an unsafe target",
      );
    }
    targets.push(target);
  });
  parser.on("closetag", () => {
    depth -= 1;
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof DocxExtractionError) {
      throw error;
    }
    parseError = error instanceof Error ? error : new Error("invalid XML");
  }
  if (parseError !== null) {
    throw new DocxExtractionError(
      DOCX_EXTRACTION_ERROR_CODES.invalidXml,
      "DOCX root relationships are not valid XML",
    );
  }
  if (targets.length !== 1) {
    throw invalidPackage(
      "DOCX archive must contain exactly one main-document relationship",
    );
  }
  const target = targets.at(0);
  if (target === undefined) {
    throw invalidPackage("DOCX main-document relationship is unavailable");
  }
  return target;
};

const classifyPart = ({
  contentType,
  path,
}: ContentTypePart): DocxPart | null => {
  if (!contentType.startsWith(WORDPROCESSING_CONTENT_TYPE_PREFIX)) {
    return null;
  }
  const suffix = contentType.slice(WORDPROCESSING_CONTENT_TYPE_PREFIX.length);
  const type = SUPPORTED_CONTENT_TYPE_SUFFIXES[suffix];
  return type === undefined ? null : { type, path };
};

const isWordTag = (tag: SaxesTagNS, local: string): boolean =>
  tag.local === local && WORDPROCESSING_NAMESPACES.has(tag.uri);

const frameByLocalName = (
  stack: readonly ElementFrame[],
  local: string,
): ElementFrame | null => {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const frame = stack.at(index);
    if (frame !== undefined && isWordTag(frame.tag, local)) {
      return frame;
    }
  }
  return null;
};

const blockLocation = (
  part: DocxPart,
  blockIndex: number,
  paragraphPath: readonly number[],
  stack: readonly ElementFrame[],
): DocxTextBlock["location"] => {
  const textBox = frameByLocalName(stack, "txbxContent");
  if (textBox !== null) {
    return {
      type: "text-box-paragraph",
      part,
      blockIndex,
      xmlPath: paragraphPath,
      textBoxPath: textBox.path,
    };
  }
  const cell = frameByLocalName(stack, "tc");
  const row = frameByLocalName(stack, "tr");
  const table = frameByLocalName(stack, "tbl");
  if (cell !== null && row !== null && table !== null) {
    return {
      type: "table-cell-paragraph",
      part,
      blockIndex,
      xmlPath: paragraphPath,
      tablePath: table.path,
      rowPath: row.path,
      cellPath: cell.path,
    };
  }
  return {
    type: "paragraph",
    part,
    blockIndex,
    xmlPath: paragraphPath,
  };
};

const revisionForTag = (
  tag: SaxesTagNS,
): Extract<DocxInlineContext, { type: "revision" }> | null => {
  if (!WORDPROCESSING_NAMESPACES.has(tag.uri)) {
    return null;
  }
  const revisions: Readonly<
    Record<string, "deletion" | "insertion" | "move-from" | "move-to">
  > = {
    del: "deletion",
    ins: "insertion",
    moveFrom: "move-from",
    moveTo: "move-to",
  };
  const revision = revisions[tag.local];
  return revision === undefined ? null : { type: "revision", revision };
};

const inlineContexts = (
  stack: readonly ElementFrame[],
): DocxInlineContext[] => {
  const contexts: DocxInlineContext[] = [];
  for (const { tag } of stack) {
    if (isWordTag(tag, "hyperlink")) {
      contexts.push({
        type: "hyperlink",
        relationshipId: attributeByLocalName(
          tag,
          "id",
          RELATIONSHIP_NAMESPACES,
        ),
        anchor: attributeByLocalName(tag, "anchor", WORDPROCESSING_NAMESPACES),
      });
    }
    const revision = revisionForTag(tag);
    if (revision !== null) {
      contexts.push(revision);
    }
  }
  return contexts;
};

const appendSegment = (
  block: MutableBlock,
  budget: PartTextBudget,
  value: string,
  source: DocxTextSegment["source"],
  path: readonly number[],
  stack: readonly ElementFrame[],
): void => {
  if (value.length === 0) {
    return;
  }
  if (budget.segmentCount >= DOCX_MAX_TEXT_SEGMENTS) {
    throw new DocxExtractionError(
      DOCX_EXTRACTION_ERROR_CODES.uncompressedLimitExceeded,
      `DOCX parts must not contain more than ${DOCX_MAX_TEXT_SEGMENTS} text segments`,
    );
  }
  budget.segmentCount += 1;
  const start = block.text.length;
  block.text += value;
  block.segments.push({
    start,
    end: block.text.length,
    source,
    contexts: inlineContexts(stack),
    xmlPath: path,
  });
};

const extractPart = (part: DocxPart, xml: string): PartExtraction => {
  const blocks: DocxTextBlock[] = [];
  const stack: ElementFrame[] = [];
  const blockStack: MutableBlock[] = [];
  let nextBlockIndex = 0;
  let currentText = "";
  let currentTextPath: readonly number[] | null = null;
  let parseError: Error | null = null;
  let unsupportedSymbolCount = 0;
  let unsupportedFieldInstructionCount = 0;
  let unsupportedAlternateContentCount = 0;
  const textBudget: PartTextBudget = { segmentCount: 0 };

  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", (error) => {
    parseError = error;
  });
  parser.on("doctype", () => {
    throw invalidPackage(
      "DOCX XML must not contain a document type declaration",
    );
  });
  parser.on("opentag", (tag) => {
    assertXmlDepth(stack.length);
    const parent = stack.at(-1);
    const childIndex = parent?.nextChildIndex ?? 0;
    if (parent !== undefined) {
      parent.nextChildIndex += 1;
    }
    const path = [...(parent?.path ?? []), childIndex];
    if (isWordTag(tag, "p")) {
      if (nextBlockIndex >= DOCX_MAX_TEXT_BLOCKS) {
        throw new DocxExtractionError(
          DOCX_EXTRACTION_ERROR_CODES.uncompressedLimitExceeded,
          `DOCX parts must not contain more than ${DOCX_MAX_TEXT_BLOCKS} text blocks`,
        );
      }
      blockStack.push({
        text: "",
        segments: [],
        location: blockLocation(part, nextBlockIndex, path, stack),
      });
      nextBlockIndex += 1;
    }
    stack.push({ tag, path, nextChildIndex: 0 });
    if (isWordTag(tag, "t") || isWordTag(tag, "delText")) {
      currentText = "";
      currentTextPath = path;
    }
    const currentBlock = blockStack.at(-1);
    if (currentBlock !== undefined && isWordTag(tag, "tab")) {
      appendSegment(currentBlock, textBudget, "\t", "tab", path, stack);
    }
    if (
      currentBlock !== undefined &&
      (isWordTag(tag, "br") || isWordTag(tag, "cr"))
    ) {
      appendSegment(currentBlock, textBudget, "\n", "break", path, stack);
    }
    if (isWordTag(tag, "sym")) {
      unsupportedSymbolCount += 1;
    }
    if (isWordTag(tag, "instrText") || isWordTag(tag, "fldSimple")) {
      unsupportedFieldInstructionCount += 1;
    }
    if (
      tag.local === "AlternateContent" &&
      MARKUP_COMPATIBILITY_NAMESPACES.has(tag.uri)
    ) {
      unsupportedAlternateContentCount += 1;
    }
  });
  parser.on("text", (text) => {
    if (currentTextPath !== null) {
      currentText += text;
    }
  });
  parser.on("cdata", (text) => {
    if (currentTextPath !== null) {
      currentText += text;
    }
  });
  parser.on("closetag", (tag) => {
    const frame = stack.at(-1);
    if (frame === undefined || frame.tag !== tag) {
      throw invalidPackage("DOCX XML element stack is inconsistent");
    }
    if (
      currentTextPath !== null &&
      (isWordTag(tag, "t") || isWordTag(tag, "delText"))
    ) {
      const currentBlock = blockStack.at(-1);
      if (currentBlock === undefined) {
        if (currentText.length > 0) {
          throw invalidPackage("DOCX text is outside a paragraph");
        }
      } else {
        appendSegment(
          currentBlock,
          textBudget,
          currentText,
          "text",
          currentTextPath,
          stack,
        );
      }
      currentText = "";
      currentTextPath = null;
    }
    if (isWordTag(tag, "p")) {
      const completedBlock = blockStack.pop();
      if (completedBlock === undefined) {
        throw invalidPackage("DOCX paragraph state is unavailable");
      }
      blocks.push(completedBlock);
    }
    stack.pop();
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof DocxExtractionError) {
      throw error;
    }
    parseError = error instanceof Error ? error : new Error("invalid XML");
  }
  if (parseError !== null) {
    throw new DocxExtractionError(
      DOCX_EXTRACTION_ERROR_CODES.invalidXml,
      `DOCX part is not valid XML: ${part.path}`,
    );
  }

  blocks.sort(
    (left, right) => left.location.blockIndex - right.location.blockIndex,
  );

  let hyperlinkTextSegmentCount = 0;
  let revisionTextSegmentCount = 0;
  for (const { segments } of blocks) {
    for (const { contexts } of segments) {
      if (contexts.some((context) => context.type === "hyperlink")) {
        hyperlinkTextSegmentCount += 1;
      }
      if (contexts.some((context) => context.type === "revision")) {
        revisionTextSegmentCount += 1;
      }
    }
  }
  return {
    blocks,
    hyperlinkTextSegmentCount,
    revisionTextSegmentCount,
    unsupportedAlternateContentCount,
    unsupportedSymbolCount,
    unsupportedFieldInstructionCount,
  };
};

export const extractDocxText = (archive: Uint8Array): DocxExtraction => {
  const entries = unzipDocxArchive(archive);
  const contentTypesBytes = entries[CONTENT_TYPES_PATH];
  if (contentTypesBytes === undefined) {
    throw invalidPackage("DOCX archive is missing [Content_Types].xml");
  }
  const contentTypes = parseContentTypes(
    decodeXml(contentTypesBytes, CONTENT_TYPES_PATH),
  );
  const rootRelationshipsBytes = entries[ROOT_RELATIONSHIPS_PATH];
  if (rootRelationshipsBytes === undefined) {
    throw invalidPackage("DOCX archive is missing _rels/.rels");
  }
  const mainDocumentTarget = parseMainDocumentTarget(
    decodeXml(rootRelationshipsBytes, ROOT_RELATIONSHIPS_PATH),
  );
  const supportedParts = contentTypes
    .map(classifyPart)
    .filter((part): part is DocxPart => part !== null);
  if (
    supportedParts.filter((part) => part.type === DOCX_PART_TYPES.mainDocument)
      .length !== 1
  ) {
    throw invalidPackage("DOCX archive must contain exactly one main document");
  }
  const mainDocument = supportedParts.find(
    (part) => part.type === DOCX_PART_TYPES.mainDocument,
  );
  if (mainDocument?.path !== mainDocumentTarget) {
    throw invalidPackage(
      "DOCX main-document relationship and content type do not agree",
    );
  }

  const blocks: DocxTextBlock[] = [];
  const coverageParts: DocxCoverageItem[] = [];
  let hyperlinkTextSegmentCount = 0;
  let revisionTextSegmentCount = 0;
  let unsupportedSymbolCount = 0;
  let unsupportedFieldInstructionCount = 0;
  let unsupportedAlternateContentCount = 0;
  let textSegmentCount = 0;
  for (const part of supportedParts) {
    const bytes = entries[part.path];
    if (bytes === undefined) {
      throw invalidPackage(
        `DOCX archive is missing declared part: ${part.path}`,
      );
    }
    const extracted = extractPart(part, decodeXml(bytes, part.path));
    if (blocks.length + extracted.blocks.length > DOCX_MAX_TEXT_BLOCKS) {
      throw new DocxExtractionError(
        DOCX_EXTRACTION_ERROR_CODES.uncompressedLimitExceeded,
        `DOCX archives must not contain more than ${DOCX_MAX_TEXT_BLOCKS} text blocks`,
      );
    }
    const extractedSegmentCount = extracted.blocks.reduce(
      (count, block) => count + block.segments.length,
      0,
    );
    if (textSegmentCount + extractedSegmentCount > DOCX_MAX_TEXT_SEGMENTS) {
      throw new DocxExtractionError(
        DOCX_EXTRACTION_ERROR_CODES.uncompressedLimitExceeded,
        `DOCX archives must not contain more than ${DOCX_MAX_TEXT_SEGMENTS} text segments`,
      );
    }
    textSegmentCount += extractedSegmentCount;
    blocks.push(...extracted.blocks);
    coverageParts.push({
      status: "extracted",
      part,
      blockCount: extracted.blocks.length,
    });
    hyperlinkTextSegmentCount += extracted.hyperlinkTextSegmentCount;
    revisionTextSegmentCount += extracted.revisionTextSegmentCount;
    unsupportedSymbolCount += extracted.unsupportedSymbolCount;
    unsupportedFieldInstructionCount +=
      extracted.unsupportedFieldInstructionCount;
    unsupportedAlternateContentCount +=
      extracted.unsupportedAlternateContentCount;
  }

  for (const { contentType, path } of contentTypes) {
    if (
      contentType.startsWith(WORDPROCESSING_CONTENT_TYPE_PREFIX) &&
      classifyPart({ contentType, path }) === null
    ) {
      coverageParts.push({
        status: "unsupported",
        path,
        contentType,
        reason: "WordprocessingML part type is not extracted",
      });
    }
  }

  return {
    contractVersion: DOCX_EXTRACTION_CONTRACT_VERSION,
    blocks,
    coverage: {
      parts: coverageParts,
      hyperlinkTextSegmentCount,
      revisionTextSegmentCount,
      unsupportedAlternateContentCount,
      unsupportedSymbolCount,
      unsupportedFieldInstructionCount,
    },
  };
};
