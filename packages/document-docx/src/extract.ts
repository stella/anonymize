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
// Bounds the aggregate cost of inlineContexts() stack scans (segmentCount x
// stack depth). Each scan is O(depth) regardless of how many segments are
// produced, so segmentCount and depth budgets alone leave their product
// unbounded (up to DOCX_MAX_TEXT_SEGMENTS x DOCX_XML_MAX_DEPTH = 256e6 scans
// from a deep, wide crafted document). This ceiling is far above realistic
// documents (depth is typically well under 30) but well below the
// pathological worst case.
const DOCX_MAX_INLINE_CONTEXT_SCAN_OPS = 20_000_000;

const CONTENT_TYPES_PATH = "[Content_Types].xml";
const ROOT_RELATIONSHIPS_PATH = "_rels/.rels";
const DOCX_CORE_PROPERTIES_PATH = "docProps/core.xml";
const DOCX_APP_PROPERTIES_PATH = "docProps/app.xml";
const DOCX_CUSTOM_PROPERTIES_PATH = "docProps/custom.xml";
const CUSTOM_XML_DIRECTORY_PREFIX = "customXml/";
const DOCPROPS_DIRECTORY_PREFIX = "docProps/";
// Metadata/properties content types that carry document PII (dc:creator,
// cp:lastModifiedBy, custom properties) wherever the part lives — a
// properties part is not required to sit at the conventional docProps/*
// path, so coverage must also key on the declared content type.
const METADATA_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-package.core-properties+xml",
  "application/vnd.openxmlformats-officedocument.extended-properties+xml",
  "application/vnd.openxmlformats-officedocument.custom-properties+xml",
]);
// RFC 3986 scheme prefix ("mailto:", "https:", "file:", even "c:"). Any
// target carrying a scheme is addressed outside the package, as is a
// protocol-relative "//host/..." target.
const ABSOLUTE_URI_PATTERN = /^[a-z][a-z0-9+.-]*:/iu;
// Fallback content types for the well-known metadata parts above, used only
// when [Content_Types].xml does not carry an explicit <Override> for them
// (e.g. a part relying on a <Default Extension="xml"> rule). These are the
// content types the OPC/OOXML specs assign to these fixed part names.
const KNOWN_METADATA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  [DOCX_CORE_PROPERTIES_PATH]:
    "application/vnd.openxmlformats-package.core-properties+xml",
  [DOCX_APP_PROPERTIES_PATH]:
    "application/vnd.openxmlformats-officedocument.extended-properties+xml",
  [DOCX_CUSTOM_PROPERTIES_PATH]:
    "application/vnd.openxmlformats-officedocument.custom-properties+xml",
};
const GENERIC_XML_CONTENT_TYPE = "application/xml";
const GENERIC_BINARY_CONTENT_TYPE = "application/octet-stream";
const RELATIONSHIPS_CONTENT_TYPE =
  "application/vnd.openxmlformats-package.relationships+xml";
// Relationship target URI schemes that can carry PII directly in
// [Content_Types]-invisible relationship metadata (e.g. hyperlink targets),
// independent of whatever display text a <w:hyperlink> wraps.
const PII_RELATIONSHIP_TARGET_SCHEMES: readonly string[] = ["mailto:", "tel:"];
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

// Shared across every extracted part of one archive: `extractDocxText`
// creates a single budget and threads it through each `extractPart` call,
// so the segment and inline-context-scan ceilings are enforced
// archive-wide. A per-part budget would let a crafted archive split the
// work across parts and stay under each per-part cap while still forcing
// the aggregate worst case.
type ArchiveTextBudget = {
  segmentCount: number;
  inlineContextScanOps: number;
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

const RELATIONSHIPS_ENTRY_PATTERN = /(?:^|\/)_rels\/[^/]+\.rels$/u;

// Any OPC relationships part: the package root "_rels/.rels" plus every
// "<dir>/_rels/<part>.rels", wherever it lives. All of them can carry
// PII-bearing external targets (mailto:, tel:), so they are retained and
// scanned uniformly instead of only the ones below word/.
const isRelationshipsEntry = (name: string): boolean =>
  name === ROOT_RELATIONSHIPS_PATH || RELATIONSHIPS_ENTRY_PATTERN.test(name);

const isCustomXmlEntry = (name: string): boolean =>
  name.startsWith(CUSTOM_XML_DIRECTORY_PREFIX) && name.endsWith(".xml");

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
    (file.name.startsWith("word/") && file.name.endsWith(".xml")) ||
    isRelationshipsEntry(file.name) ||
    // The whole docProps/ directory, not just the conventional core/app/
    // custom filenames: a properties relationship may address a
    // non-conventional part (e.g. docProps/custom2.xml) that must still be
    // flagged as uncovered metadata.
    file.name.startsWith(DOCPROPS_DIRECTORY_PREFIX) ||
    isCustomXmlEntry(file.name)
  );
};

export const unzipDocxArchive = (
  archive: Uint8Array,
  includeAllEntries = false,
  onSkippedEntry?: (name: string) => void,
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
      filter: (file) => {
        const keep = archiveFilter({ budget, file, includeAllEntries });
        if (!keep) {
          onSkippedEntry?.(file.name);
        }
        return keep;
      },
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

const hasPiiRelationshipTargetScheme = (target: string): boolean => {
  const normalized = target.trim().toLowerCase();
  return PII_RELATIONSHIP_TARGET_SCHEMES.some((scheme) =>
    normalized.startsWith(scheme),
  );
};

// A target addressed outside the package: an explicit TargetMode of
// "External", any target with a URI scheme, or a protocol-relative URL.
// The attribute alone is not trusted — a crafted archive can carry an
// absolute URI in a nominally internal relationship.
const isExternalRelationshipTarget = (
  target: string,
  targetMode: string | null,
): boolean => {
  const normalized = target.trim();
  return (
    targetMode?.trim().toLowerCase() === "external" ||
    ABSOLUTE_URI_PATTERN.test(normalized) ||
    normalized.startsWith("//")
  );
};

type UncoveredRelationshipTarget = {
  relationshipId: string | null;
  reason: string;
};

const PII_SCHEME_TARGET_REASON =
  "target uses a PII-bearing external scheme (mailto/tel) that anonymization does not redact";
const EXTERNAL_TARGET_REASON =
  "target is external and is not examined or redacted by anonymization";
const DANGLING_TARGET_REASON =
  "target does not resolve to a package part and is not examined or redacted by anonymization";

// The OPC base directory internal targets resolve against: the directory
// that contains the relationships part's _rels folder ("word/" for
// "word/_rels/document.xml.rels", "" for the package root "_rels/.rels").
const relationshipBaseDirectory = (relsPath: string): string => {
  const marker = relsPath.lastIndexOf("_rels/");
  return marker <= 0 ? "" : relsPath.slice(0, marker);
};

// Percent-decodes an OPC target segment ("My%20Doc.xml" → "My Doc.xml").
// Malformed encoding yields null, which callers treat as unresolvable
// (fail closed) rather than guessing.
const decodeOpcTarget = (target: string): string | null => {
  try {
    return decodeURIComponent(target);
  } catch {
    return null;
  }
};

// Collapses "." and empty segments and applies ".." segments; a path that
// climbs above the package root cannot name a part and yields null.
const normalizeOpcPath = (path: string): string | null => {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
};

// Resolves an internal relationship target to a package entry name:
// package-absolute ("/word/document.xml") or relative to the relationships
// part's base directory ("media/image1.png" from
// "word/_rels/document.xml.rels" → "word/media/image1.png"). Returns null
// when the target cannot name a part (malformed encoding, escapes the
// root, or is empty).
const resolveInternalRelationshipTarget = (
  target: string,
  relsPath: string,
): string | null => {
  const decoded = decodeOpcTarget(target.trim());
  if (decoded === null || decoded === "") {
    return null;
  }
  if (decoded.startsWith("/")) {
    return normalizeOpcPath(decoded.slice(1));
  }
  return normalizeOpcPath(`${relationshipBaseDirectory(relsPath)}${decoded}`);
};

// Scans a relationships part for Relationship elements whose Target leaves
// the package. These targets are never visited by extractPart (which only
// walks WordprocessingML part XML), so without this check a hyperlink
// pointing at "mailto:alice@example.test" — or at any external URL that
// embeds PII in its userinfo, path, query, or fragment — with no PII in
// its visible display text (or an orphaned relationship not referenced by
// any <w:hyperlink>) produces no text segment and is invisible to
// coverage. Every external target is uncovered: the rewrite never touches
// relationship targets, so an external URI of any scheme or shape is an
// unexamined channel that survives the rewrite verbatim. Internal
// (in-package) targets are only covered when they resolve to an actual
// archive entry (which then carries its own coverage entry); a dangling
// internal target ("alice@example.test" with no scheme and no matching
// part) is a PII channel preserved verbatim in the .rels XML and is
// flagged too.
type ParseUncoveredRelationshipTargetsOptions = {
  xml: string;
  relsPath: string;
  // Lowercased archive entry names (OPC part-name comparison is
  // case-insensitive), including entries the retention filter dropped —
  // those still exist in the package and get inventory coverage entries.
  knownEntryPaths: ReadonlySet<string>;
};

const parseUncoveredRelationshipTargets = ({
  xml,
  relsPath: path,
  knownEntryPaths,
}: ParseUncoveredRelationshipTargetsOptions): UncoveredRelationshipTarget[] => {
  const found: UncoveredRelationshipTarget[] = [];
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
    const target = attributeByLocalName(tag, "Target");
    if (target === null) {
      return;
    }
    const targetMode = attributeByLocalName(tag, "TargetMode");
    if (hasPiiRelationshipTargetScheme(target)) {
      found.push({
        relationshipId: attributeByLocalName(tag, "Id"),
        reason: PII_SCHEME_TARGET_REASON,
      });
      return;
    }
    if (isExternalRelationshipTarget(target, targetMode)) {
      found.push({
        relationshipId: attributeByLocalName(tag, "Id"),
        reason: EXTERNAL_TARGET_REASON,
      });
      return;
    }
    const resolved = resolveInternalRelationshipTarget(target, path);
    if (resolved === null || !knownEntryPaths.has(resolved.toLowerCase())) {
      found.push({
        relationshipId: attributeByLocalName(tag, "Id"),
        reason: DANGLING_TARGET_REASON,
      });
    }
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
      `DOCX relationships are not valid XML: ${path}`,
    );
  }
  return found;
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
  budget: ArchiveTextBudget,
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
      `DOCX archives must not contain more than ${DOCX_MAX_TEXT_SEGMENTS} text segments`,
    );
  }
  budget.segmentCount += 1;
  // inlineContexts() below scans the whole element stack, so its cost is
  // O(stack.length). Bound the aggregate cost (see
  // DOCX_MAX_INLINE_CONTEXT_SCAN_OPS) rather than only the segment count and
  // depth independently, since their product is otherwise unbounded.
  if (
    budget.inlineContextScanOps + stack.length >
    DOCX_MAX_INLINE_CONTEXT_SCAN_OPS
  ) {
    throw new DocxExtractionError(
      DOCX_EXTRACTION_ERROR_CODES.uncompressedLimitExceeded,
      `DOCX archives must not require more than ${DOCX_MAX_INLINE_CONTEXT_SCAN_OPS} aggregate inline-context scan operations`,
    );
  }
  budget.inlineContextScanOps += stack.length;
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

const extractPart = (
  part: DocxPart,
  xml: string,
  textBudget: ArchiveTextBudget,
): PartExtraction => {
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
  // Entries the retention filter drops are still preserved verbatim by the
  // rewrite, so their names are recorded for the coverage inventory below.
  const skippedEntryPaths: string[] = [];
  const entries = unzipDocxArchive(archive, false, (name) => {
    skippedEntryPaths.push(name);
  });
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
  // One budget for the whole archive: segment count and inline-context scan
  // ops accumulate across parts inside appendSegment, so splitting the work
  // over many parts cannot dodge the aggregate ceilings.
  const textBudget: ArchiveTextBudget = {
    segmentCount: 0,
    inlineContextScanOps: 0,
  };
  for (const part of supportedParts) {
    const bytes = entries[part.path];
    if (bytes === undefined) {
      throw invalidPackage(
        `DOCX archive is missing declared part: ${part.path}`,
      );
    }
    const extracted = extractPart(
      part,
      decodeXml(bytes, part.path),
      textBudget,
    );
    if (blocks.length + extracted.blocks.length > DOCX_MAX_TEXT_BLOCKS) {
      throw new DocxExtractionError(
        DOCX_EXTRACTION_ERROR_CODES.uncompressedLimitExceeded,
        `DOCX archives must not contain more than ${DOCX_MAX_TEXT_BLOCKS} text blocks`,
      );
    }
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

  // OPC relationships parts are never walked by extractPart, which only
  // parses WordprocessingML. Any external relationship target — a
  // PII-bearing scheme (mailto:, tel:) or an external URL that embeds PII
  // in its userinfo, path, query, or fragment — can therefore carry
  // unredacted PII even when the visible hyperlink display text has no PII
  // of its own, when the relationship is not referenced by any
  // <w:hyperlink> at all, or when it lives outside word/ entirely (e.g. an
  // extra external relationship in the package root "_rels/.rels"). Rather
  // than attempting to rewrite relationship targets, fail closed: scan
  // every relationships part in the package and mark every external or
  // dangling target unsupported so `require-full` cannot report "full"
  // while such a target survives the rewrite untouched.
  const knownEntryPaths: ReadonlySet<string> = new Set(
    [...Object.keys(entries), ...skippedEntryPaths].map((name) =>
      name.toLowerCase(),
    ),
  );
  for (const [relsPath, relsBytes] of Object.entries(entries)) {
    if (!isRelationshipsEntry(relsPath)) {
      continue;
    }
    const uncoveredTargets = parseUncoveredRelationshipTargets({
      xml: decodeXml(relsBytes, relsPath),
      relsPath,
      knownEntryPaths,
    });
    for (const uncovered of uncoveredTargets) {
      coverageParts.push({
        status: "unsupported",
        path: relsPath,
        contentType: RELATIONSHIPS_CONTENT_TYPE,
        reason:
          uncovered.relationshipId === null
            ? `Relationship ${uncovered.reason}`
            : `Relationship "${uncovered.relationshipId}" ${uncovered.reason}`,
      });
    }
  }

  // ── Coverage inventory ──────────────────────────────────────────────
  // Every archive entry must end up either extracted, structural
  // ([Content_Types].xml and relationships parts, both parsed above), or
  // explicitly marked unsupported. Anything less lets the rewrite
  // preserve a part verbatim while `require-full` reports "full".
  const coveredPaths = new Set<string>([
    CONTENT_TYPES_PATH,
    ...supportedParts.map((part) => part.path),
  ]);
  const overrideContentTypes = new Map(
    contentTypes.map((entry) => [entry.path, entry.contentType]),
  );
  const markUnsupported = (
    path: string,
    contentType: string,
    reason: string,
  ): void => {
    if (coveredPaths.has(path)) {
      return;
    }
    coveredPaths.add(path);
    coverageParts.push({ status: "unsupported", path, contentType, reason });
  };

  // docProps/* (core, extended, custom, and any non-conventional
  // properties part) and customXml/* can carry PII (dc:creator,
  // cp:lastModifiedBy, custom properties, structured custom XML content)
  // but are never walked by extractPart. Redacting arbitrary metadata and
  // custom-XML schemas is out of scope here, so fail closed: mark every
  // present metadata/custom-XML part unsupported.
  for (const path of Object.keys(entries)) {
    if (path.startsWith(DOCPROPS_DIRECTORY_PREFIX)) {
      markUnsupported(
        path,
        overrideContentTypes.get(path) ??
          KNOWN_METADATA_CONTENT_TYPES[path] ??
          GENERIC_XML_CONTENT_TYPE,
        "Document metadata parts are not extracted or redacted",
      );
    } else if (isCustomXmlEntry(path)) {
      markUnsupported(
        path,
        overrideContentTypes.get(path) ?? GENERIC_XML_CONTENT_TYPE,
        "Custom XML parts are not extracted or redacted",
      );
    }
  }

  // Every part declared in [Content_Types].xml that the extractor does not
  // parse is uncovered, whatever its content type: metadata parts at
  // non-conventional paths, non-extracted WordprocessingML part types
  // (styles, settings, ...), and any other declared payload (charts,
  // diagrams, embedded objects, ...) that can carry document text.
  for (const { contentType, path } of contentTypes) {
    if (
      contentType === RELATIONSHIPS_CONTENT_TYPE ||
      isRelationshipsEntry(path)
    ) {
      continue;
    }
    if (METADATA_CONTENT_TYPES.has(contentType)) {
      markUnsupported(
        path,
        contentType,
        "Document metadata parts are not extracted or redacted",
      );
      continue;
    }
    if (contentType.startsWith(WORDPROCESSING_CONTENT_TYPE_PREFIX)) {
      markUnsupported(
        path,
        contentType,
        "WordprocessingML part type is not extracted",
      );
      continue;
    }
    markUnsupported(
      path,
      contentType,
      "Package part type is not extracted or redacted",
    );
  }

  // Finally, every remaining archive entry — retained but undeclared, or
  // dropped by the retention filter (media, fonts, embedded binaries,
  // arbitrary extra files) — is preserved verbatim by the rewrite without
  // ever being examined, so it must surface as uncovered too.
  for (const path of [...Object.keys(entries), ...skippedEntryPaths]) {
    if (path.endsWith("/") || isRelationshipsEntry(path)) {
      continue;
    }
    markUnsupported(
      path,
      overrideContentTypes.get(path) ??
        (path.endsWith(".xml")
          ? GENERIC_XML_CONTENT_TYPE
          : GENERIC_BINARY_CONTENT_TYPE),
      "Package part is not examined by anonymization",
    );
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
