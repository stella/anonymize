import { strToU8, zipSync } from "fflate";
import { SaxesParser, type SaxesTagNS } from "saxes";

import {
  DOCX_ARCHIVE_MAX_BYTES,
  DOCX_ENTRY_MAX_BYTES,
  DOCX_UNCOMPRESSED_MAX_BYTES,
  DOCX_XML_MAX_DEPTH,
  extractDocxText,
  unzipDocxArchive,
} from "./extract";
import {
  DOCX_REWRITE_ERROR_CODES,
  type DocxBlockLocation,
  type DocxBlockRewrite,
  type DocxRewriteErrorCode,
  type DocxRewriteResult,
  type DocxTextBlock,
  type DocxTextReplacement,
  type DocxTextSegment,
} from "./types";

const WORDPROCESSING_NAMESPACES = new Set([
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
]);
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const DOCX_MAX_REPLACEMENTS = 1_000_000;
const SIGNATURE_PART_PREFIX = "_xmlsignatures/";

export class DocxRewriteError extends Error {
  readonly code: DocxRewriteErrorCode;

  constructor(code: DocxRewriteErrorCode, message: string) {
    super(message);
    this.name = "DocxRewriteError";
    this.code = code;
  }
}

type ElementFrame = {
  path: readonly number[];
  nextChildIndex: number;
};

type TextNodeUpdate = {
  path: readonly number[];
  value: string;
};

type XmlPatch = {
  start: number;
  end: number;
  value: string;
};

const rewriteError = (
  code: DocxRewriteErrorCode,
  message: string,
): DocxRewriteError => new DocxRewriteError(code, message);

const arraysEqual = (
  left: readonly number[],
  right: readonly number[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right.at(index));

const locationsEqual = (
  left: DocxBlockLocation,
  right: DocxBlockLocation,
): boolean => {
  if (
    left.type !== right.type ||
    left.part.type !== right.part.type ||
    left.part.path !== right.part.path ||
    left.blockIndex !== right.blockIndex ||
    !arraysEqual(left.xmlPath, right.xmlPath)
  ) {
    return false;
  }
  if (left.type === "paragraph" && right.type === "paragraph") {
    return true;
  }
  if (
    left.type === "table-cell-paragraph" &&
    right.type === "table-cell-paragraph"
  ) {
    return (
      arraysEqual(left.tablePath, right.tablePath) &&
      arraysEqual(left.rowPath, right.rowPath) &&
      arraysEqual(left.cellPath, right.cellPath)
    );
  }
  if (
    left.type === "text-box-paragraph" &&
    right.type === "text-box-paragraph"
  ) {
    return arraysEqual(left.textBoxPath, right.textBoxPath);
  }
  return false;
};

const locationKey = ({ blockIndex, part }: DocxBlockLocation): string =>
  `${part.path}\0${blockIndex}`;

const pathKey = (path: readonly number[]): string => path.join(".");

const isValidXmlText = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      (codePoint !== 0x09 &&
        codePoint !== 0x0a &&
        codePoint !== 0x0d &&
        (codePoint < 0x20 ||
          (codePoint > 0xd7ff && codePoint < 0xe000) ||
          (codePoint > 0xfffd && codePoint < 0x10_000) ||
          codePoint > 0x10_ffff))
    ) {
      return false;
    }
  }
  return true;
};

const isUtf16Boundary = (value: string, offset: number): boolean => {
  if (offset === 0 || offset === value.length) {
    return true;
  }
  const previous = value.charCodeAt(offset - 1);
  const next = value.charCodeAt(offset);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  );
};

const validateReplacement = (
  replacement: DocxTextReplacement,
  blockText: string,
): void => {
  if (
    !Number.isSafeInteger(replacement.start) ||
    !Number.isSafeInteger(replacement.end) ||
    replacement.start < 0 ||
    replacement.start >= replacement.end ||
    replacement.end > blockText.length ||
    !isUtf16Boundary(blockText, replacement.start) ||
    !isUtf16Boundary(blockText, replacement.end)
  ) {
    throw rewriteError(
      DOCX_REWRITE_ERROR_CODES.invalidReplacement,
      "DOCX replacement spans must be nonempty bounded integer ranges at UTF-16 boundaries",
    );
  }
  if (!isValidXmlText(replacement.replacement)) {
    throw rewriteError(
      DOCX_REWRITE_ERROR_CODES.invalidReplacement,
      "DOCX replacement text must contain only valid XML characters",
    );
  }
  if (strToU8(replacement.replacement).byteLength > DOCX_ENTRY_MAX_BYTES) {
    throw rewriteError(
      DOCX_REWRITE_ERROR_CODES.rewriteLimitExceeded,
      `DOCX replacement text must not exceed ${DOCX_ENTRY_MAX_BYTES} UTF-8 bytes`,
    );
  }
};

const coveredTextSegments = (
  block: DocxTextBlock,
  replacement: DocxTextReplacement,
): readonly DocxTextSegment[] => {
  const segments = block.segments.filter(
    ({ end, start }) => start < replacement.end && end > replacement.start,
  );
  let cursor = replacement.start;
  for (const segment of segments) {
    if (
      segment.source !== "text" ||
      segment.start > cursor ||
      segment.contexts.some((context) => context.type === "revision")
    ) {
      throw rewriteError(
        DOCX_REWRITE_ERROR_CODES.unsupportedReplacement,
        "DOCX replacements must stay within contiguous non-revision text segments",
      );
    }
    cursor = Math.min(replacement.end, segment.end);
  }
  if (segments.length === 0 || cursor !== replacement.end) {
    throw rewriteError(
      DOCX_REWRITE_ERROR_CODES.unsupportedReplacement,
      "DOCX replacements must stay within contiguous non-revision text segments",
    );
  }
  return segments;
};

const planBlockUpdates = (
  block: DocxTextBlock,
  rewrite: DocxBlockRewrite,
): TextNodeUpdate[] => {
  const replacements = [...rewrite.replacements].sort(
    (left, right) => left.start - right.start,
  );
  for (const [index, replacement] of replacements.entries()) {
    validateReplacement(replacement, block.text);
    const previous = index === 0 ? undefined : replacements.at(index - 1);
    if (previous !== undefined && previous.end > replacement.start) {
      throw rewriteError(
        DOCX_REWRITE_ERROR_CODES.invalidReplacement,
        "DOCX replacement spans must not overlap",
      );
    }
  }

  const values = new Map<string, TextNodeUpdate>();
  const originalValues = new Map<string, string>();
  for (const segment of block.segments) {
    if (segment.source !== "text") {
      continue;
    }
    values.set(pathKey(segment.xmlPath), {
      path: segment.xmlPath,
      value: block.text.slice(segment.start, segment.end),
    });
    originalValues.set(
      pathKey(segment.xmlPath),
      block.text.slice(segment.start, segment.end),
    );
  }

  for (const replacement of replacements.toReversed()) {
    const segments = coveredTextSegments(block, replacement);
    const first = segments.at(0);
    const last = segments.at(-1);
    if (first === undefined || last === undefined) {
      throw rewriteError(
        DOCX_REWRITE_ERROR_CODES.unsupportedReplacement,
        "DOCX replacement text segments are unavailable",
      );
    }
    const firstUpdate = values.get(pathKey(first.xmlPath));
    const lastUpdate = values.get(pathKey(last.xmlPath));
    if (firstUpdate === undefined || lastUpdate === undefined) {
      throw rewriteError(
        DOCX_REWRITE_ERROR_CODES.unsupportedReplacement,
        "DOCX replacement text nodes are unavailable",
      );
    }
    const firstStart = replacement.start - first.start;
    const lastEnd = replacement.end - last.start;
    if (first === last) {
      firstUpdate.value =
        firstUpdate.value.slice(0, firstStart) +
        replacement.replacement +
        firstUpdate.value.slice(lastEnd);
      continue;
    }
    firstUpdate.value =
      firstUpdate.value.slice(0, firstStart) + replacement.replacement;
    for (const segment of segments.slice(1, -1)) {
      const update = values.get(pathKey(segment.xmlPath));
      if (update !== undefined) {
        update.value = "";
      }
    }
    lastUpdate.value = lastUpdate.value.slice(lastEnd);
  }
  return [...values.entries()]
    .filter(([key, update]) => update.value !== originalValues.get(key))
    .map(([, update]) => update);
};

const escapeXmlText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const requiresPreservedSpace = (value: string): boolean =>
  /^\s|\s$/u.test(value);

const isWordTextTag = (tag: SaxesTagNS): boolean =>
  WORDPROCESSING_NAMESPACES.has(tag.uri) &&
  (tag.local === "t" || tag.local === "delText");

const hasPreservedSpace = (tag: SaxesTagNS): boolean =>
  Object.values(tag.attributes).some(
    (attribute) =>
      attribute.uri === XML_NAMESPACE &&
      attribute.local === "space" &&
      attribute.value === "preserve",
  );

type FindClosingTagStartOptions = {
  xml: string;
  contentStart: number;
  parserPosition: number;
};

const findClosingTagStart = ({
  xml,
  contentStart,
  parserPosition,
}: FindClosingTagStartOptions): number => {
  for (let index = parserPosition - 1; index >= contentStart; index -= 1) {
    if (xml[index] === "<" && xml[index + 1] === "/") {
      return index;
    }
  }
  throw rewriteError(
    DOCX_REWRITE_ERROR_CODES.staleExtraction,
    "DOCX text-node closing tag changed after extraction",
  );
};

const rewritePartXml = (
  xml: string,
  updates: readonly TextNodeUpdate[],
): string => {
  const updatesByPath = new Map(
    updates.map((update) => [pathKey(update.path), update]),
  );
  const foundPaths = new Set<string>();
  const patches: XmlPatch[] = [];
  const stack: ElementFrame[] = [];
  let activeText:
    | { key: string; contentStart: number; tag: SaxesTagNS }
    | undefined;
  let parseError: Error | null = null;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", (error) => {
    parseError = error;
  });
  parser.on("opentag", (tag) => {
    if (stack.length >= DOCX_XML_MAX_DEPTH) {
      throw rewriteError(
        DOCX_REWRITE_ERROR_CODES.rewriteLimitExceeded,
        `DOCX XML must not exceed ${DOCX_XML_MAX_DEPTH} nested elements`,
      );
    }
    const parent = stack.at(-1);
    const childIndex = parent?.nextChildIndex ?? 0;
    if (parent !== undefined) {
      parent.nextChildIndex += 1;
    }
    const path = [...(parent?.path ?? []), childIndex];
    stack.push({ path, nextChildIndex: 0 });
    const key = pathKey(path);
    if (isWordTextTag(tag) && updatesByPath.has(key)) {
      if (tag.isSelfClosing) {
        throw rewriteError(
          DOCX_REWRITE_ERROR_CODES.unsupportedReplacement,
          "DOCX self-closing text nodes cannot receive replacements",
        );
      }
      activeText = { key, contentStart: parser.position, tag };
    }
  });
  parser.on("closetag", (tag) => {
    if (activeText?.tag === tag) {
      const update = updatesByPath.get(activeText.key);
      if (update !== undefined) {
        const contentEnd = findClosingTagStart({
          xml,
          contentStart: activeText.contentStart,
          parserPosition: parser.position,
        });
        patches.push({
          start: activeText.contentStart,
          end: contentEnd,
          value: escapeXmlText(update.value),
        });
        if (requiresPreservedSpace(update.value) && !hasPreservedSpace(tag)) {
          patches.push({
            start: activeText.contentStart - 1,
            end: activeText.contentStart - 1,
            value: ' xml:space="preserve"',
          });
        }
        foundPaths.add(activeText.key);
      }
      activeText = undefined;
    }
    stack.pop();
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof DocxRewriteError) {
      throw error;
    }
    parseError = error instanceof Error ? error : new Error("invalid XML");
  }
  if (parseError !== null) {
    throw rewriteError(
      DOCX_REWRITE_ERROR_CODES.unsupportedReplacement,
      "DOCX source XML changed after extraction",
    );
  }
  if (foundPaths.size !== updatesByPath.size) {
    throw rewriteError(
      DOCX_REWRITE_ERROR_CODES.staleExtraction,
      "DOCX text-node locations changed after extraction",
    );
  }
  let rewritten = xml;
  for (const patch of patches.toSorted(
    (left, right) => right.start - left.start,
  )) {
    rewritten =
      rewritten.slice(0, patch.start) +
      patch.value +
      rewritten.slice(patch.end);
  }
  return rewritten;
};

const assertArchiveBudgets = (entries: Record<string, Uint8Array>): void => {
  let totalBytes = 0;
  for (const bytes of Object.values(entries)) {
    if (bytes.byteLength > DOCX_ENTRY_MAX_BYTES) {
      throw rewriteError(
        DOCX_REWRITE_ERROR_CODES.rewriteLimitExceeded,
        `Rewritten DOCX entries must not exceed ${DOCX_ENTRY_MAX_BYTES} bytes`,
      );
    }
    totalBytes += bytes.byteLength;
  }
  if (totalBytes > DOCX_UNCOMPRESSED_MAX_BYTES) {
    throw rewriteError(
      DOCX_REWRITE_ERROR_CODES.rewriteLimitExceeded,
      `Rewritten DOCX archives must not exceed ${DOCX_UNCOMPRESSED_MAX_BYTES} uncompressed bytes`,
    );
  }
};

export const rewriteDocxText = (
  archive: Uint8Array,
  rewrites: readonly DocxBlockRewrite[],
): DocxRewriteResult => {
  const extraction = extractDocxText(archive);
  if (rewrites.length === 0) {
    return {
      document: archive.slice(),
      rewrittenBlockCount: 0,
      appliedReplacementCount: 0,
    };
  }
  const blocksByLocation = new Map(
    extraction.blocks.map((block) => [locationKey(block.location), block]),
  );
  const updatesByPart = new Map<string, Map<string, TextNodeUpdate>>();
  const rewrittenLocations = new Set<string>();
  let appliedReplacementCount = 0;

  for (const rewrite of rewrites) {
    const key = locationKey(rewrite.location);
    if (rewrittenLocations.has(key)) {
      throw rewriteError(
        DOCX_REWRITE_ERROR_CODES.invalidReplacement,
        "Each DOCX block may appear in a rewrite plan only once",
      );
    }
    rewrittenLocations.add(key);
    const block = blocksByLocation.get(key);
    if (
      block === undefined ||
      !locationsEqual(block.location, rewrite.location) ||
      block.text !== rewrite.expectedText
    ) {
      throw rewriteError(
        DOCX_REWRITE_ERROR_CODES.staleExtraction,
        "DOCX block location or expected text no longer matches",
      );
    }
    if (rewrite.replacements.length === 0) {
      throw rewriteError(
        DOCX_REWRITE_ERROR_CODES.invalidReplacement,
        "DOCX block rewrite plans must contain at least one replacement",
      );
    }
    if (
      appliedReplacementCount + rewrite.replacements.length >
      DOCX_MAX_REPLACEMENTS
    ) {
      throw rewriteError(
        DOCX_REWRITE_ERROR_CODES.rewriteLimitExceeded,
        `DOCX rewrites must not contain more than ${DOCX_MAX_REPLACEMENTS} replacements`,
      );
    }
    const partUpdates =
      updatesByPart.get(block.location.part.path) ?? new Map();
    for (const update of planBlockUpdates(block, rewrite)) {
      partUpdates.set(pathKey(update.path), update);
    }
    updatesByPart.set(block.location.part.path, partUpdates);
    appliedReplacementCount += rewrite.replacements.length;
  }

  const entries = unzipDocxArchive(archive, true);
  if (
    Object.keys(entries).some((path) =>
      path.toLowerCase().startsWith(SIGNATURE_PART_PREFIX),
    )
  ) {
    throw rewriteError(
      DOCX_REWRITE_ERROR_CODES.unsupportedReplacement,
      "Digitally signed DOCX packages must be re-signed before rewriting",
    );
  }
  for (const [partPath, updates] of updatesByPart) {
    const partBytes = entries[partPath];
    if (partBytes === undefined) {
      throw rewriteError(
        DOCX_REWRITE_ERROR_CODES.staleExtraction,
        "DOCX source part changed after extraction",
      );
    }
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(partBytes);
    entries[partPath] = strToU8(rewritePartXml(xml, [...updates.values()]));
  }
  assertArchiveBudgets(entries);
  const document = zipSync(entries);
  if (document.byteLength > DOCX_ARCHIVE_MAX_BYTES) {
    throw rewriteError(
      DOCX_REWRITE_ERROR_CODES.rewriteLimitExceeded,
      `Rewritten DOCX archives must not exceed ${DOCX_ARCHIVE_MAX_BYTES} bytes`,
    );
  }
  return {
    document,
    rewrittenBlockCount: rewrites.length,
    appliedReplacementCount,
  };
};
