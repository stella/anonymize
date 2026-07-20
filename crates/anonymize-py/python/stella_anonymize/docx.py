"""Bounded DOCX extraction, rewriting, anonymization, and restoration.

The public shapes mirror ``@stll/anonymize-docx`` while using Python naming.
All offsets are UTF-16 code-unit offsets, matching the cross-runtime contract.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from collections.abc import Mapping, Sequence
from pathlib import PurePosixPath
from typing import Any, TypedDict
from urllib.parse import unquote
from xml.etree import ElementTree as ET

from ._native import extract_docx_text_json as _extract_docx_text_json
from ._native import rewrite_docx_text_native as _rewrite_docx_text_native

DOCX_EXTRACTION_CONTRACT_VERSION = 1
DOCX_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024
DOCX_ENTRY_MAX_BYTES = 16 * 1024 * 1024
DOCX_UNCOMPRESSED_MAX_BYTES = 128 * 1024 * 1024
DOCX_XML_MAX_DEPTH = 256
DOCX_MAX_ENTRIES = 4096
DOCX_MAX_TEXT_BLOCKS = 100_000
DOCX_MAX_TEXT_SEGMENTS = 1_000_000
DOCX_MAX_REPLACEMENTS = 1_000_000

_CONTENT_TYPES = "[Content_Types].xml"
_ROOT_RELS = "_rels/.rels"
_WORD_NAMESPACES = frozenset(
    {
        "http://purl.oclc.org/ooxml/wordprocessingml/main",
        "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    }
)
_REL_NAMESPACES = frozenset(
    {
        "http://purl.oclc.org/ooxml/officeDocument/relationships",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    }
)
_PACKAGE_REL_NAMESPACES = frozenset(
    {
        "http://purl.oclc.org/ooxml/package/relationships",
        "http://schemas.openxmlformats.org/package/2006/relationships",
    }
)
_CONTENT_TYPES_NAMESPACE = (
    "http://schemas.openxmlformats.org/package/2006/content-types"
)
_WORD_CONTENT_TYPE_PREFIX = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml."
)
_SUPPORTED_PARTS: dict[str, str] = {
    "comments+xml": "comments",
    "document.main+xml": "main-document",
    "endnotes+xml": "endnotes",
    "footer+xml": "footer",
    "footnotes+xml": "footnotes",
    "header+xml": "header",
}
_REL_CONTENT_TYPE = "application/vnd.openxmlformats-package.relationships+xml"
_GENERIC_XML = "application/xml"
_GENERIC_BINARY = "application/octet-stream"
_ABSOLUTE_URI = re.compile(r"^[a-z][a-z0-9+.-]*:", re.IGNORECASE)
_RELATIONSHIPS_ENTRY = re.compile(r"(?:^|/)_rels/[^/]+\.rels$")


class DocxError(ValueError):
    """Base class for stable, coded DOCX errors."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class DocxExtractionError(DocxError):
    pass


class DocxRewriteError(DocxError):
    pass


class DocxAnonymizationError(DocxError):
    pass


class DocxRestorationError(DocxError):
    pass


class DocxTextReplacement(TypedDict):
    start: int
    end: int
    replacement: str


class DocxBlockRewrite(TypedDict):
    location: Mapping[str, Any]
    expected_text: str
    replacements: Sequence[DocxTextReplacement]


def _split_tag(tag: str) -> tuple[str, str]:
    if tag.startswith("{") and "}" in tag:
        namespace, local = tag[1:].split("}", 1)
        return namespace, local
    return "", tag


def _is_word(element: ET.Element, local: str) -> bool:
    namespace, name = _split_tag(element.tag)
    return namespace in _WORD_NAMESPACES and name == local


def _attribute(element: ET.Element, local: str) -> str | None:
    for name, value in element.attrib.items():
        if _split_tag(name)[1] == local:
            return value
    return None


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _utf16_slice(value: str, start: int, end: int | None = None) -> str:
    encoded = value.encode("utf-16-le")
    start_byte = start * 2
    end_byte = len(encoded) if end is None else end * 2
    try:
        return encoded[start_byte:end_byte].decode("utf-16-le")
    except UnicodeDecodeError as error:
        raise DocxRewriteError(
            "invalid-replacement",
            "DOCX replacement spans must use UTF-16 boundaries",
        ) from error


def _is_valid_xml_text(value: str) -> bool:
    return all(
        codepoint in {0x09, 0x0A, 0x0D}
        or 0x20 <= codepoint <= 0xD7FF
        or 0xE000 <= codepoint <= 0xFFFD
        or 0x10000 <= codepoint <= 0x10FFFF
        for codepoint in map(ord, value)
    )


def _escaped_xml_bytes(value: str) -> int:
    total = 0
    for character in value:
        if character == "&":
            total += 5
        elif character in {"<", ">"}:
            total += 4
        else:
            total += len(character.encode("utf-8"))
    return total


def _safe_path(name: str) -> bool:
    return (
        bool(name)
        and not name.startswith("/")
        and "\\" not in name
        and "\0" not in name
        and ".." not in name.split("/")
    )


def _parse_xml(data: bytes, path: str) -> ET.Element:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise DocxExtractionError(
            "invalid-xml", f"DOCX XML part is not valid UTF-8: {path}"
        ) from error
    if "<!DOCTYPE" in text.upper():
        raise DocxExtractionError(
            "invalid-package",
            "DOCX XML must not contain a document type declaration",
        )
    try:
        root = ET.fromstring(text)
    except ET.ParseError as error:
        raise DocxExtractionError(
            "invalid-xml", f"DOCX part is not valid XML: {path}"
        ) from error
    stack: list[tuple[ET.Element, int]] = [(root, 1)]
    while stack:
        node, depth = stack.pop()
        if depth >= DOCX_XML_MAX_DEPTH:
            raise DocxExtractionError(
                "uncompressed-limit-exceeded",
                f"DOCX XML must not exceed {DOCX_XML_MAX_DEPTH} nested elements",
            )
        stack.extend((child, depth + 1) for child in list(node))
    return root


def _read_archive(document: bytes) -> tuple[dict[str, bytes], list[str]]:
    if len(document) > DOCX_ARCHIVE_MAX_BYTES:
        raise DocxExtractionError(
            "archive-limit-exceeded",
            f"DOCX archives must not exceed {DOCX_ARCHIVE_MAX_BYTES} bytes",
        )
    entries: dict[str, bytes] = {}
    order: list[str] = []
    total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(document), "r") as archive:
            infos = archive.infolist()
            if len(infos) > DOCX_MAX_ENTRIES:
                raise DocxExtractionError(
                    "uncompressed-limit-exceeded",
                    f"DOCX archives must contain at most {DOCX_MAX_ENTRIES} entries",
                )
            for info in infos:
                if not _safe_path(info.filename):
                    raise DocxExtractionError(
                        "unsafe-entry-path",
                        "DOCX archive contains an unsafe entry path",
                    )
                if info.file_size > DOCX_ENTRY_MAX_BYTES:
                    raise DocxExtractionError(
                        "uncompressed-limit-exceeded",
                        f"DOCX entries must not exceed {DOCX_ENTRY_MAX_BYTES} bytes",
                    )
                total += info.file_size
                if total > DOCX_UNCOMPRESSED_MAX_BYTES:
                    raise DocxExtractionError(
                        "uncompressed-limit-exceeded",
                        f"DOCX archives must not exceed {DOCX_UNCOMPRESSED_MAX_BYTES} uncompressed bytes",
                    )
                order.append(info.filename)
                entries[info.filename] = archive.read(info)
    except DocxExtractionError:
        raise
    except (OSError, RuntimeError, zipfile.BadZipFile) as error:
        raise DocxExtractionError(
            "invalid-archive", "Input is not a valid bounded DOCX ZIP archive"
        ) from error
    return entries, order


def _content_type_parts(entries: Mapping[str, bytes]) -> list[tuple[str, str]]:
    data = entries.get(_CONTENT_TYPES)
    if data is None:
        raise DocxExtractionError(
            "invalid-package", "DOCX archive is missing [Content_Types].xml"
        )
    root = _parse_xml(data, _CONTENT_TYPES)
    parts: list[tuple[str, str]] = []
    paths: set[str] = set()
    for element in root.iter():
        namespace, local = _split_tag(element.tag)
        if namespace != _CONTENT_TYPES_NAMESPACE or local != "Override":
            continue
        raw_path = _attribute(element, "PartName")
        content_type = _attribute(element, "ContentType")
        if raw_path is None or content_type is None:
            raise DocxExtractionError(
                "invalid-package", "DOCX content-type override is incomplete"
            )
        path = raw_path.removeprefix("/")
        if not _safe_path(path) or path in paths:
            raise DocxExtractionError(
                "invalid-package",
                "DOCX content-type overrides must have unique safe paths",
            )
        paths.add(path)
        parts.append((path, content_type))
    return parts


def _main_target(entries: Mapping[str, bytes]) -> str:
    data = entries.get(_ROOT_RELS)
    if data is None:
        raise DocxExtractionError(
            "invalid-package", "DOCX archive is missing _rels/.rels"
        )
    root = _parse_xml(data, _ROOT_RELS)
    targets: list[str] = []
    allowed_types = {f"{namespace}/officeDocument" for namespace in _REL_NAMESPACES}
    for element in root.iter():
        namespace, local = _split_tag(element.tag)
        if namespace not in _PACKAGE_REL_NAMESPACES or local != "Relationship":
            continue
        if _attribute(element, "Type") not in allowed_types:
            continue
        target = _attribute(element, "Target")
        if (
            target is None
            or (_attribute(element, "TargetMode") or "").lower() == "external"
        ):
            raise DocxExtractionError(
                "invalid-package", "DOCX main-document relationship must be internal"
            )
        normalized = target.removeprefix("/")
        if not _safe_path(normalized) or ":" in normalized:
            raise DocxExtractionError(
                "invalid-package",
                "DOCX main-document relationship has an unsafe target",
            )
        targets.append(normalized)
    if len(targets) != 1:
        raise DocxExtractionError(
            "invalid-package",
            "DOCX archive must contain exactly one main-document relationship",
        )
    return targets[0]


def _is_relationships_entry(path: str) -> bool:
    return path == _ROOT_RELS or _RELATIONSHIPS_ENTRY.search(path) is not None


def _resolve_relationship_target(target: str, relationships_path: str) -> str | None:
    decoded = unquote(target.strip())
    if not decoded:
        return None
    if decoded.startswith("/"):
        candidate = PurePosixPath(decoded[1:])
    else:
        marker = relationships_path.rfind("_rels/")
        base = relationships_path[:marker] if marker > 0 else ""
        candidate = PurePosixPath(base) / decoded
    normalized: list[str] = []
    for part in candidate.parts:
        if part in {"", "."}:
            continue
        if part == "..":
            if not normalized:
                return None
            normalized.pop()
        else:
            normalized.append(part)
    return "/".join(normalized) or None


def _uncovered_relationships(
    entries: Mapping[str, bytes], known_paths: set[str]
) -> list[dict[str, Any]]:
    uncovered: list[dict[str, Any]] = []
    for path, data in entries.items():
        if not _is_relationships_entry(path):
            continue
        root = _parse_xml(data, path)
        for element in root.iter():
            namespace, local = _split_tag(element.tag)
            if namespace not in _PACKAGE_REL_NAMESPACES or local != "Relationship":
                continue
            target = _attribute(element, "Target")
            if target is None:
                continue
            normalized_target = target.strip()
            external = (
                (_attribute(element, "TargetMode") or "").strip().lower() == "external"
                or _ABSOLUTE_URI.search(normalized_target) is not None
                or normalized_target.startswith("//")
            )
            resolved = (
                None
                if external
                else _resolve_relationship_target(normalized_target, path)
            )
            if (
                not external
                and resolved is not None
                and resolved.lower() in known_paths
            ):
                continue
            relationship_id = _attribute(element, "Id")
            if normalized_target.lower().startswith(("mailto:", "tel:")):
                reason = "target uses a PII-bearing external scheme (mailto/tel) that anonymization does not redact"
            elif external:
                reason = "target is external and is not examined or redacted by anonymization"
            else:
                reason = "target does not resolve to a package part and is not examined or redacted by anonymization"
            prefix = (
                "Relationship"
                if relationship_id is None
                else f'Relationship "{relationship_id}"'
            )
            uncovered.append(
                {
                    "status": "unsupported",
                    "path": path,
                    "contentType": _REL_CONTENT_TYPE,
                    "reason": f"{prefix} {reason}",
                }
            )
    return uncovered


def _contexts(ancestors: Sequence[ET.Element]) -> list[dict[str, str | None]]:
    found: list[dict[str, str | None]] = []
    revisions = {
        "del": "deletion",
        "ins": "insertion",
        "moveFrom": "move-from",
        "moveTo": "move-to",
    }
    for ancestor in ancestors:
        namespace, local = _split_tag(ancestor.tag)
        if namespace not in _WORD_NAMESPACES:
            continue
        if local == "hyperlink":
            relationship_id = None
            anchor = None
            for name, value in ancestor.attrib.items():
                attr_namespace, attr_local = _split_tag(name)
                if attr_local == "id" and attr_namespace in _REL_NAMESPACES:
                    relationship_id = value
                if attr_local == "anchor" and attr_namespace in _WORD_NAMESPACES:
                    anchor = value
            found.append(
                {
                    "type": "hyperlink",
                    "relationshipId": relationship_id,
                    "anchor": anchor,
                }
            )
        revision = revisions.get(local)
        if revision is not None:
            found.append({"type": "revision", "revision": revision})
    return found


def _extract_part(
    part: dict[str, str], root: ET.Element
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    blocks: list[dict[str, Any]] = []
    block_stack: list[dict[str, Any]] = []
    ancestors: list[ET.Element] = []
    paths: list[list[int]] = []
    counters = {
        "hyperlinkTextSegmentCount": 0,
        "revisionTextSegmentCount": 0,
        "unsupportedAlternateContentCount": 0,
        "unsupportedSymbolCount": 0,
        "unsupportedFieldInstructionCount": 0,
    }

    def visit(element: ET.Element, path: list[int]) -> None:
        namespace, local = _split_tag(element.tag)
        is_word = namespace in _WORD_NAMESPACES
        if is_word and local == "p":
            location: dict[str, Any] = {
                "type": "paragraph",
                "part": part,
                "blockIndex": len(blocks) + len(block_stack),
                "xmlPath": path,
            }
            for ancestor, ancestor_path in reversed(list(zip(ancestors, paths))):
                if _is_word(ancestor, "txbxContent"):
                    location.update(
                        type="text-box-paragraph", textBoxPath=ancestor_path
                    )
                    break
            else:
                table = row = cell = None
                for ancestor, ancestor_path in reversed(list(zip(ancestors, paths))):
                    if cell is None and _is_word(ancestor, "tc"):
                        cell = ancestor_path
                    elif row is None and _is_word(ancestor, "tr"):
                        row = ancestor_path
                    elif table is None and _is_word(ancestor, "tbl"):
                        table = ancestor_path
                if table is not None and row is not None and cell is not None:
                    location.update(
                        type="table-cell-paragraph",
                        tablePath=table,
                        rowPath=row,
                        cellPath=cell,
                    )
            block_stack.append({"text": "", "location": location, "segments": []})
        current = block_stack[-1] if block_stack else None
        if (
            current is None
            and is_word
            and local in {"t", "delText"}
            and (element.text or "")
        ):
            raise DocxExtractionError(
                "invalid-package", "DOCX text is outside a paragraph"
            )
        if (
            current is not None
            and is_word
            and local in {"t", "delText", "tab", "br", "cr"}
        ):
            source = "text"
            value = element.text or ""
            if local == "tab":
                source, value = "tab", "\t"
            elif local in {"br", "cr"}:
                source, value = "break", "\n"
            if value:
                start = _utf16_length(current["text"])
                current["text"] += value
                contexts = _contexts([*ancestors, element])
                current["segments"].append(
                    {
                        "start": start,
                        "end": start + _utf16_length(value),
                        "source": source,
                        "contexts": contexts,
                        "xmlPath": path,
                    }
                )
                if any(item["type"] == "hyperlink" for item in contexts):
                    counters["hyperlinkTextSegmentCount"] += 1
                if any(item["type"] == "revision" for item in contexts):
                    counters["revisionTextSegmentCount"] += 1
        if is_word and local == "sym":
            counters["unsupportedSymbolCount"] += 1
        if is_word and local in {"instrText", "fldSimple"}:
            counters["unsupportedFieldInstructionCount"] += 1
        if local == "AlternateContent" and "markup-compatibility" in namespace:
            counters["unsupportedAlternateContentCount"] += 1
        ancestors.append(element)
        paths.append(path)
        for index, child in enumerate(list(element)):
            visit(child, [*path, index])
        paths.pop()
        ancestors.pop()
        if is_word and local == "p":
            completed = block_stack.pop()
            blocks.append(completed)

    visit(root, [0])
    blocks.sort(key=lambda block: block["location"]["blockIndex"])
    for index, block in enumerate(blocks):
        block["location"]["blockIndex"] = index
    return blocks, counters


def extract_docx_text(document: bytes | bytearray | memoryview) -> dict[str, Any]:
    """Extract redactable DOCX text blocks and fail-closed coverage metadata."""

    try:
        return json.loads(_extract_docx_text_json(bytes(document)))
    except ValueError as error:
        message = str(error)
        if "unsafe entry path" in message:
            code = "unsafe-entry-path"
        elif "valid bounded DOCX ZIP archive" in message:
            code = "invalid-archive"
        elif "valid XML" in message or "valid UTF-8" in message:
            code = "invalid-xml"
        elif f"must not exceed {DOCX_ARCHIVE_MAX_BYTES} bytes" in message:
            code = "archive-limit-exceeded"
        elif (
            "must not exceed" in message
            or "must not contain more than" in message
            or "at most" in message
        ):
            code = "uncompressed-limit-exceeded"
        else:
            code = "invalid-package"
        raise DocxExtractionError(code, message) from error


def _extract_docx_text_python(document: bytes) -> dict[str, Any]:
    """Compatibility oracle retained until shared coverage vectors are complete."""

    entries, order = _read_archive(document)
    content_types = _content_type_parts(entries)
    main_target = _main_target(entries)
    supported: list[tuple[dict[str, str], str]] = []
    for path, content_type in content_types:
        if content_type.startswith(_WORD_CONTENT_TYPE_PREFIX):
            suffix = content_type[len(_WORD_CONTENT_TYPE_PREFIX) :]
            part_type = _SUPPORTED_PARTS.get(suffix)
            if part_type is not None:
                supported.append(({"type": part_type, "path": path}, content_type))
    main_parts = [part for part, _ in supported if part["type"] == "main-document"]
    if len(main_parts) != 1:
        raise DocxExtractionError(
            "invalid-package", "DOCX archive must contain exactly one main document"
        )
    if main_parts[0]["path"] != main_target:
        raise DocxExtractionError(
            "invalid-package",
            "DOCX main-document relationship and content type do not agree",
        )
    blocks: list[dict[str, Any]] = []
    coverage_parts: list[dict[str, Any]] = []
    totals = {
        "hyperlinkTextSegmentCount": 0,
        "revisionTextSegmentCount": 0,
        "unsupportedAlternateContentCount": 0,
        "unsupportedSymbolCount": 0,
        "unsupportedFieldInstructionCount": 0,
    }
    covered = {_CONTENT_TYPES, _ROOT_RELS}
    for part, _ in supported:
        data = entries.get(part["path"])
        if data is None:
            raise DocxExtractionError(
                "invalid-package",
                f"DOCX archive is missing declared part: {part['path']}",
            )
        part_blocks, counters = _extract_part(part, _parse_xml(data, part["path"]))
        if len(blocks) + len(part_blocks) > DOCX_MAX_TEXT_BLOCKS:
            raise DocxExtractionError(
                "uncompressed-limit-exceeded",
                f"DOCX archives must not contain more than {DOCX_MAX_TEXT_BLOCKS} text blocks",
            )
        blocks.extend(part_blocks)
        if sum(len(block["segments"]) for block in blocks) > DOCX_MAX_TEXT_SEGMENTS:
            raise DocxExtractionError(
                "uncompressed-limit-exceeded",
                f"DOCX archives must not contain more than {DOCX_MAX_TEXT_SEGMENTS} text segments",
            )
        coverage_parts.append(
            {"status": "extracted", "part": part, "blockCount": len(part_blocks)}
        )
        covered.add(part["path"])
        for key, value in counters.items():
            totals[key] += value
    coverage_parts.extend(
        _uncovered_relationships(entries, {path.lower() for path in entries})
    )
    overrides = dict(content_types)
    for path, content_type in content_types:
        if path in covered or content_type == _REL_CONTENT_TYPE:
            continue
        reason = (
            "Document metadata parts are not extracted or redacted"
            if "properties" in content_type
            else "WordprocessingML part type is not extracted"
            if content_type.startswith(_WORD_CONTENT_TYPE_PREFIX)
            else "Package part type is not extracted or redacted"
        )
        coverage_parts.append(
            {
                "status": "unsupported",
                "path": path,
                "contentType": content_type,
                "reason": reason,
            }
        )
        covered.add(path)
    for path in order:
        if path in covered or path.endswith("/") or _is_relationships_entry(path):
            continue
        coverage_parts.append(
            {
                "status": "unsupported",
                "path": path,
                "contentType": overrides.get(
                    path, _GENERIC_XML if path.endswith(".xml") else _GENERIC_BINARY
                ),
                "reason": "Package part is not examined by anonymization",
            }
        )
        covered.add(path)
    return {
        "contractVersion": 1,
        "blocks": blocks,
        "coverage": {"parts": coverage_parts, **totals},
    }


def _location_key(location: Mapping[str, Any]) -> str:
    part = location.get("part")
    part_path = part.get("path") if isinstance(part, Mapping) else None
    xml_path = location.get("xmlPath")
    return f"{part_path}:{location.get('type')}:{'.'.join(str(item) for item in xml_path or [])}"


def _element_at(root: ET.Element, path: Sequence[int]) -> ET.Element:
    if not path or path[0] != 0:
        raise DocxRewriteError(
            "stale-extraction", "DOCX text-node locations changed after extraction"
        )
    current = root
    for index in path[1:]:
        children = list(current)
        if index < 0 or index >= len(children):
            raise DocxRewriteError(
                "stale-extraction", "DOCX text-node locations changed after extraction"
            )
        current = children[index]
    return current


def _write_archive(entries: Mapping[str, bytes], order: Sequence[str]) -> bytes:
    total = 0
    for value in entries.values():
        if len(value) > DOCX_ENTRY_MAX_BYTES:
            raise DocxRewriteError(
                "rewrite-limit-exceeded",
                f"Rewritten DOCX entries must not exceed {DOCX_ENTRY_MAX_BYTES} bytes",
            )
        total += len(value)
    if total > DOCX_UNCOMPRESSED_MAX_BYTES:
        raise DocxRewriteError(
            "rewrite-limit-exceeded",
            f"Rewritten DOCX archives must not exceed {DOCX_UNCOMPRESSED_MAX_BYTES} uncompressed bytes",
        )
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in order:
            archive.writestr(path, entries[path])
    document = output.getvalue()
    if len(document) > DOCX_ARCHIVE_MAX_BYTES:
        raise DocxRewriteError(
            "rewrite-limit-exceeded",
            f"Rewritten DOCX archives must not exceed {DOCX_ARCHIVE_MAX_BYTES} bytes",
        )
    return document


def _rewrite_docx_text_python_oracle(
    document: bytes | bytearray | memoryview,
    rewrites: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Apply validated UTF-16 block replacements to a DOCX package."""

    source = bytes(document)
    extraction = extract_docx_text(source)
    if not rewrites:
        return {
            "document": bytes(source),
            "rewrittenBlockCount": 0,
            "appliedReplacementCount": 0,
        }
    blocks = {_location_key(block["location"]): block for block in extraction["blocks"]}
    entries, order = _read_archive(source)
    if any(path.lower().startswith("_xmlsignatures/") for path in entries):
        raise DocxRewriteError(
            "unsupported-replacement",
            "Digitally signed DOCX packages must be re-signed before rewriting",
        )
    roots: dict[str, ET.Element] = {}
    seen: set[str] = set()
    applied = 0
    total_replacement_bytes = 0
    replacement_bytes_by_part: dict[str, int] = {}
    for rewrite in rewrites:
        location = rewrite.get("location")
        if not isinstance(location, Mapping):
            raise DocxRewriteError(
                "stale-extraction", "DOCX block location is unavailable"
            )
        key = _location_key(location)
        if key in seen:
            raise DocxRewriteError(
                "invalid-replacement",
                "Each DOCX block may appear in a rewrite plan only once",
            )
        seen.add(key)
        block = blocks.get(key)
        expected = rewrite.get("expectedText", rewrite.get("expected_text"))
        if (
            block is None
            or block["location"] != dict(location)
            or block["text"] != expected
        ):
            raise DocxRewriteError(
                "stale-extraction",
                "DOCX block location or expected text no longer matches",
            )
        replacements = list(rewrite.get("replacements", ()))
        if not replacements:
            raise DocxRewriteError(
                "invalid-replacement",
                "DOCX block rewrite plans must contain at least one replacement",
            )
        replacements.sort(key=lambda item: item["start"])
        previous_end = -1
        rewrite_replacement_bytes = 0
        for replacement in replacements:
            start, end = replacement["start"], replacement["end"]
            if (
                not isinstance(start, int)
                or isinstance(start, bool)
                or not isinstance(end, int)
                or isinstance(end, bool)
                or start < 0
                or start >= end
                or end > _utf16_length(block["text"])
            ):
                raise DocxRewriteError(
                    "invalid-replacement",
                    "DOCX replacement spans must be nonempty bounded integer ranges at UTF-16 boundaries",
                )
            _utf16_slice(block["text"], start, end)
            replacement_text = replacement["replacement"]
            if not isinstance(replacement_text, str) or not _is_valid_xml_text(
                replacement_text
            ):
                raise DocxRewriteError(
                    "invalid-replacement",
                    "DOCX replacement text must contain only valid XML characters",
                )
            replacement_bytes = _escaped_xml_bytes(replacement_text)
            if replacement_bytes > DOCX_ENTRY_MAX_BYTES:
                raise DocxRewriteError(
                    "rewrite-limit-exceeded",
                    f"DOCX replacement text must not exceed {DOCX_ENTRY_MAX_BYTES} escaped UTF-8 bytes",
                )
            rewrite_replacement_bytes += replacement_bytes
            if start < previous_end:
                raise DocxRewriteError(
                    "invalid-replacement", "DOCX replacement spans must not overlap"
                )
            previous_end = end
        part_path = location["part"]["path"]
        total_replacement_bytes += rewrite_replacement_bytes
        if total_replacement_bytes > DOCX_UNCOMPRESSED_MAX_BYTES:
            raise DocxRewriteError(
                "rewrite-limit-exceeded",
                f"DOCX rewrite replacement text must not exceed {DOCX_UNCOMPRESSED_MAX_BYTES} aggregate escaped UTF-8 bytes",
            )
        part_replacement_bytes = (
            replacement_bytes_by_part.get(part_path, 0) + rewrite_replacement_bytes
        )
        replacement_bytes_by_part[part_path] = part_replacement_bytes
        if part_replacement_bytes > DOCX_ENTRY_MAX_BYTES:
            raise DocxRewriteError(
                "rewrite-limit-exceeded",
                f"DOCX rewrite replacement text for a single part must not exceed {DOCX_ENTRY_MAX_BYTES} aggregate escaped UTF-8 bytes",
            )
        root = roots.setdefault(part_path, _parse_xml(entries[part_path], part_path))
        updates: dict[tuple[int, ...], str] = {}
        originals: dict[tuple[int, ...], str] = {}
        for segment in block["segments"]:
            if segment["source"] == "text":
                path = tuple(segment["xmlPath"])
                value = _utf16_slice(block["text"], segment["start"], segment["end"])
                updates[path] = value
                originals[path] = value
        for replacement in reversed(replacements):
            segments = [
                segment
                for segment in block["segments"]
                if segment["start"] < replacement["end"]
                and segment["end"] > replacement["start"]
            ]
            cursor = replacement["start"]
            for segment in segments:
                if (
                    segment["source"] != "text"
                    or segment["start"] > cursor
                    or any(
                        context["type"] == "revision" for context in segment["contexts"]
                    )
                ):
                    raise DocxRewriteError(
                        "unsupported-replacement",
                        "DOCX replacements must stay within contiguous non-revision text segments",
                    )
                cursor = min(replacement["end"], segment["end"])
            if not segments or cursor != replacement["end"]:
                raise DocxRewriteError(
                    "unsupported-replacement",
                    "DOCX replacements must stay within contiguous non-revision text segments",
                )
            first, last = segments[0], segments[-1]
            first_path, last_path = tuple(first["xmlPath"]), tuple(last["xmlPath"])
            first_start = replacement["start"] - first["start"]
            last_end = replacement["end"] - last["start"]
            if first_path == last_path:
                updates[first_path] = (
                    _utf16_slice(updates[first_path], 0, first_start)
                    + replacement["replacement"]
                    + _utf16_slice(updates[first_path], last_end)
                )
            else:
                updates[first_path] = (
                    _utf16_slice(updates[first_path], 0, first_start)
                    + replacement["replacement"]
                )
                for segment in segments[1:-1]:
                    updates[tuple(segment["xmlPath"])] = ""
                updates[last_path] = _utf16_slice(updates[last_path], last_end)
        for path, value in updates.items():
            if value != originals[path]:
                element = _element_at(root, path)
                if not (_is_word(element, "t") or _is_word(element, "delText")):
                    raise DocxRewriteError(
                        "stale-extraction",
                        "DOCX text-node locations changed after extraction",
                    )
                element.text = value
                if value[:1].isspace() or value[-1:].isspace():
                    element.set(
                        "{http://www.w3.org/XML/1998/namespace}space", "preserve"
                    )
        applied += len(replacements)
        if applied > DOCX_MAX_REPLACEMENTS:
            raise DocxRewriteError(
                "rewrite-limit-exceeded",
                f"DOCX rewrites must not contain more than {DOCX_MAX_REPLACEMENTS} replacements",
            )
    for path, root in roots.items():
        serialized = ET.tostring(root, encoding="utf-8", xml_declaration=False)
        if len(serialized) > DOCX_ENTRY_MAX_BYTES:
            raise DocxRewriteError(
                "rewrite-limit-exceeded",
                f"Rewritten DOCX entries must not exceed {DOCX_ENTRY_MAX_BYTES} bytes",
            )
        entries[path] = serialized
    return {
        "document": _write_archive(entries, order),
        "rewrittenBlockCount": len(rewrites),
        "appliedReplacementCount": applied,
    }


def _preflight_rewrite_plan(
    rewrites: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    if len(rewrites) > DOCX_MAX_TEXT_BLOCKS:
        raise DocxRewriteError(
            "rewrite-limit-exceeded",
            f"DOCX rewrites must not contain more than {DOCX_MAX_TEXT_BLOCKS} blocks",
        )
    replacement_count = 0
    estimated_bytes = len(rewrites) * 256
    serializable_rewrites: list[dict[str, Any]] = []
    for rewrite in rewrites:
        replacements = rewrite.get("replacements")
        if not isinstance(replacements, Sequence) or isinstance(
            replacements, (str, bytes, bytearray)
        ):
            raise DocxRewriteError(
                "invalid-replacement",
                "DOCX block rewrite replacements must be a sequence",
            )
        replacement_count += len(replacements)
        if replacement_count > DOCX_MAX_REPLACEMENTS:
            raise DocxRewriteError(
                "rewrite-limit-exceeded",
                f"DOCX rewrites must not contain more than {DOCX_MAX_REPLACEMENTS} replacements",
            )
        expected_text = rewrite.get("expectedText")
        estimated_bytes += (
            len(expected_text) * 6 if isinstance(expected_text, str) else 0
        ) + len(replacements) * 96
        serializable_replacements: list[Any] = []
        for replacement in replacements:
            if isinstance(replacement, Mapping):
                value = replacement.get("replacement")
                if isinstance(value, str):
                    estimated_bytes += len(value) * 6
                serializable_replacements.append(
                    {
                        "start": replacement.get("start"),
                        "end": replacement.get("end"),
                        "replacement": value,
                    }
                )
            else:
                serializable_replacements.append(None)
        location = rewrite.get("location")
        serializable_location: Any = None
        if isinstance(location, Mapping):
            serializable_location = {
                "type": location.get("type"),
                "blockIndex": location.get("blockIndex"),
            }
            part = location.get("part")
            if isinstance(part, Mapping):
                serializable_location["part"] = {
                    "type": part.get("type"),
                    "path": part.get("path"),
                }
                for value in (part.get("type"), part.get("path")):
                    if isinstance(value, str):
                        estimated_bytes += len(value) * 6
            location_type = location.get("type")
            if isinstance(location_type, str):
                estimated_bytes += len(location_type) * 6
            for key in (
                "xmlPath",
                "tablePath",
                "rowPath",
                "cellPath",
                "textBoxPath",
            ):
                path = location.get(key)
                if isinstance(path, Sequence) and not isinstance(
                    path, (str, bytes, bytearray)
                ):
                    if len(path) > DOCX_XML_MAX_DEPTH:
                        raise DocxRewriteError(
                            "invalid-replacement",
                            f"DOCX rewrite location paths must not exceed {DOCX_XML_MAX_DEPTH} entries",
                        )
                    estimated_bytes += len(path) * 24
                    serializable_location[key] = list(path)
        serializable_rewrites.append(
            {
                "location": serializable_location,
                "expectedText": expected_text,
                "replacements": serializable_replacements,
            }
        )
        if estimated_bytes > DOCX_UNCOMPRESSED_MAX_BYTES:
            raise DocxRewriteError(
                "rewrite-limit-exceeded",
                f"DOCX rewrite plans must not exceed {DOCX_UNCOMPRESSED_MAX_BYTES} estimated serialized bytes",
            )
    return serializable_rewrites


def rewrite_docx_text(
    document: bytes | bytearray | memoryview,
    rewrites: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Apply the shared Rust DOCX rewrite contract."""

    try:
        normalized_rewrites = []
        for rewrite in rewrites:
            normalized = dict(rewrite)
            if "expectedText" not in normalized and "expected_text" in normalized:
                normalized["expectedText"] = normalized.pop("expected_text")
            normalized_rewrites.append(normalized)
        serializable_rewrites = _preflight_rewrite_plan(normalized_rewrites)
        rewrites_json = json.dumps(serializable_rewrites, separators=(",", ":"))
    except DocxRewriteError:
        raise
    except (TypeError, ValueError) as error:
        raise DocxRewriteError(
            "invalid-replacement",
            f"DOCX rewrite plan is not serializable: {error}",
        ) from error
    try:
        rewritten, block_count, replacement_count = _rewrite_docx_text_native(
            bytes(document), rewrites_json
        )
    except ValueError as error:
        message = str(error)
        code, separator, detail = message.partition(": ")
        if separator and code in {
            "archive-limit-exceeded",
            "invalid-archive",
            "invalid-package",
            "invalid-xml",
            "unsafe-entry-path",
            "uncompressed-limit-exceeded",
        }:
            raise DocxExtractionError(code, detail) from error
        if separator and code in {
            "invalid-replacement",
            "rewrite-limit-exceeded",
            "stale-extraction",
            "unsupported-replacement",
        }:
            raise DocxRewriteError(code, detail) from error
        raise
    return {
        "document": bytes(rewritten),
        "rewrittenBlockCount": block_count,
        "appliedReplacementCount": replacement_count,
    }


def _coverage_summary(coverage: Mapping[str, Any]) -> dict[str, int]:
    parts = coverage["parts"]
    return {
        "extractedPartCount": sum(item["status"] == "extracted" for item in parts),
        "unsupportedPartCount": sum(item["status"] == "unsupported" for item in parts),
        **{
            key: int(coverage[key])
            for key in (
                "hyperlinkTextSegmentCount",
                "revisionTextSegmentCount",
                "unsupportedAlternateContentCount",
                "unsupportedSymbolCount",
                "unsupportedFieldInstructionCount",
            )
        },
    }


def _workflow_coverage(coverage: Mapping[str, Any]) -> dict[str, Any]:
    counts = _coverage_summary(coverage)
    partial = counts["unsupportedPartCount"] > 0 or any(
        counts[key] > 0
        for key in (
            "hyperlinkTextSegmentCount",
            "revisionTextSegmentCount",
            "unsupportedAlternateContentCount",
            "unsupportedSymbolCount",
            "unsupportedFieldInstructionCount",
        )
    )
    return {"status": "partial" if partial else "full", "counts": counts}


def anonymize_docx(
    document: bytes | bytearray | memoryview,
    session: Any,
    expected_session_id: str,
    policy: Mapping[str, Any],
    *,
    caller_detections: Sequence[Mapping[str, Any]] = (),
    observed_at_epoch_seconds: int | None = None,
) -> dict[str, Any]:
    """Anonymize all extracted blocks with a prepared redaction session."""

    session_id = session.session_id()
    if session_id != expected_session_id:
        raise DocxAnonymizationError(
            "session-mismatch",
            "DOCX anonymization session does not match the expected session",
        )
    extraction = extract_docx_text(document)
    coverage = _workflow_coverage(extraction["coverage"])
    coverage_policy = policy.get("coverage", policy)
    if (
        coverage["status"] == "partial"
        and coverage_policy.get("mode") == "require-full"
    ):
        raise DocxAnonymizationError(
            "incomplete-coverage",
            "DOCX contains content outside the fully supported anonymization coverage",
        )
    blocks_by_location = {
        _location_key(block["location"]): block for block in extraction["blocks"]
    }
    detections_by_location: dict[str, Mapping[str, Any]] = {}
    caller_count = 0
    for item in caller_detections:
        key = _location_key(item["location"])
        if key in detections_by_location:
            raise DocxAnonymizationError(
                "invalid-caller-detections",
                "Each DOCX block may have only one caller-detection input",
            )
        block = blocks_by_location.get(key)
        if (
            block is None
            or block["location"] != dict(item["location"])
            or item.get("expectedText", item.get("expected_text")) != block["text"]
        ):
            raise DocxAnonymizationError(
                "invalid-caller-detections",
                "DOCX caller-detection location or expected text no longer matches",
            )
        caller_count += len(item.get("detections", ()))
        if caller_count > 1_000_000:
            raise DocxAnonymizationError(
                "invalid-caller-detections",
                "DOCX workflows must not contain more than 1000000 caller detections",
            )
        detections_by_location[key] = item
    rewrites: list[dict[str, Any]] = []
    operators = policy.get("operators")
    plan_inputs: list[dict[str, Any]] = []
    for block in extraction["blocks"]:
        detection_input = detections_by_location.get(_location_key(block["location"]))
        if (
            detection_input is not None
            and detection_input.get(
                "expectedText", detection_input.get("expected_text")
            )
            != block["text"]
        ):
            raise DocxAnonymizationError(
                "invalid-caller-detections",
                "DOCX caller-detection location or expected text no longer matches",
            )
        plan_inputs.append(
            {
                "full_text": block["text"],
                "detections": (
                    ()
                    if detection_input is None
                    else detection_input.get("detections", ())
                ),
            }
        )
    try:
        native_plan = session._plan_docx_text_batch(
            plan_inputs, operators, observed_at_epoch_seconds
        )
        block_plans = json.loads(native_plan.result_json())
    except (AttributeError, TypeError, ValueError) as error:
        raise DocxAnonymizationError(
            "invalid-caller-detections",
            "DOCX session could not produce a transactional block plan",
        ) from error
    if len(block_plans) != len(extraction["blocks"]):
        raise DocxAnonymizationError(
            "invalid-caller-detections",
            "DOCX session redaction plan does not match the extracted block count",
        )
    entity_count = 0
    retained_caller_count = 0
    for block, block_plan in zip(extraction["blocks"], block_plans):
        entity_count += block_plan["entity_count"]
        retained_caller_count += block_plan["caller_entity_count"]
        replacements = block_plan["replacements"]
        if replacements:
            rewrites.append(
                {
                    "location": block["location"],
                    "expectedText": block["text"],
                    "replacements": replacements,
                }
            )
    rewritten = rewrite_docx_text(document, rewrites)
    native_plan.commit()
    return {
        "document": rewritten["document"],
        "summary": {
            "contractVersion": 1,
            "sessionId": session_id,
            "blockCount": len(extraction["blocks"]),
            "rewrittenBlockCount": rewritten["rewrittenBlockCount"],
            "appliedReplacementCount": rewritten["appliedReplacementCount"],
            "entityCount": entity_count,
            "callerDetectionCount": caller_count,
            "retainedCallerDetectionCount": retained_caller_count,
            "coverage": coverage,
        },
    }


def restore_docx_text(
    document: bytes | bytearray | memoryview,
    session: Any,
    expected_session_id: str,
    *,
    observed_at_epoch_seconds: int | None = None,
) -> dict[str, Any]:
    """Restore placeholders owned by the expected session inside a DOCX."""

    session_id = session.session_id()
    if session_id != expected_session_id:
        raise DocxRestorationError(
            "session-mismatch",
            "DOCX restoration session does not match the expected session id",
        )
    if session.restore_text("", observed_at_epoch_seconds) != "":
        raise DocxRestorationError(
            "invalid-session",
            "DOCX restoration session must preserve text without placeholders",
        )
    extraction = extract_docx_text(document)
    encoded_session = session_id.replace("_", "%5F")
    rewrites: list[dict[str, Any]] = []
    restored_count = 0
    candidate_count = 0

    def is_owned_candidate(value: str) -> bool:
        inner = value[:-1] if value.endswith("]") else value
        count_separator = inner.rfind("_")
        if count_separator <= 0:
            return False
        prefix = inner[:count_separator]
        namespace_separator = prefix.rfind("_")
        return (
            namespace_separator > 0
            and prefix[namespace_separator + 1 :] == encoded_session
        )

    for block in extraction["blocks"]:
        replacements: list[dict[str, Any]] = []
        start: int | None = None
        text = block["text"]
        for cursor, character in enumerate(text):
            if character == "[":
                if start is not None and is_owned_candidate(text[start + 1 : cursor]):
                    raise DocxRestorationError(
                        "invalid-placeholder",
                        "DOCX text contains an incomplete placeholder for the expected session",
                    )
                start = cursor
                continue
            if character != "]" or start is None:
                continue
            candidate_end = cursor + 1
            candidate = text[start:candidate_end]
            candidate_count += 1
            if candidate_count > 1_000_000:
                raise DocxRestorationError(
                    "restoration-limit-exceeded",
                    "DOCX restoration must not inspect more than 1000000 placeholder candidates",
                )
            owned = is_owned_candidate(candidate[1:])
            if _utf16_length(candidate) > 512:
                if owned:
                    raise DocxRestorationError(
                        "invalid-placeholder",
                        "DOCX session placeholder exceeds the maximum length",
                    )
                start = None
                continue
            if not owned:
                start = None
                continue
            restored = session.restore_text(candidate, observed_at_epoch_seconds)
            if restored == candidate:
                raise DocxRestorationError(
                    "invalid-placeholder",
                    "DOCX text contains an unknown placeholder for the expected session",
                )
            replacements.append(
                {
                    "start": _utf16_length(text[:start]),
                    "end": _utf16_length(text[:candidate_end]),
                    "replacement": restored,
                }
            )
            start = None
        if start is not None and is_owned_candidate(text[start + 1 :]):
            raise DocxRestorationError(
                "invalid-placeholder",
                "DOCX text contains an incomplete placeholder for the expected session",
            )
        if replacements:
            restored_count += len(replacements)
            rewrites.append(
                {
                    "location": block["location"],
                    "expectedText": block["text"],
                    "replacements": replacements,
                }
            )
    if session.restore_text("", observed_at_epoch_seconds) != "":
        raise DocxRestorationError(
            "invalid-session",
            "DOCX restoration session must preserve text without placeholders",
        )
    restored = rewrite_docx_text(document, rewrites)
    return {
        "document": restored["document"],
        "sessionId": session_id,
        "restoredBlockCount": restored["rewrittenBlockCount"],
        "restoredPlaceholderCount": restored_count,
        "coverage": _workflow_coverage(extraction["coverage"]),
    }
