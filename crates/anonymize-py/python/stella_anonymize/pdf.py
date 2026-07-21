"""Fail-closed PDF coverage inspection; this module does not redact PDFs."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

from ._native import inspect_pdf_json as _inspect_pdf_json

PDF_INSPECTION_CONTRACT_VERSION = 1
PDF_DOCUMENT_MAX_BYTES = 64 * 1024 * 1024
PDF_DECOMPRESSED_MAX_BYTES = 128 * 1024 * 1024
PDF_MAX_OBJECTS = 200_000
PDF_MAX_OBJECT_NODES = 1_000_000
PDF_MAX_OBJECT_DEPTH = 128
PDF_MAX_PAGES = 10_000
PDF_MAX_GLYPHS = 5_000_000
PDF_MAX_PAGE_TEXT_UTF8_BYTES = 16 * 1024 * 1024
PDF_MAX_OBSERVATION_TEXT_UTF8_BYTES = 64 * 1024 * 1024
PDF_MAX_OBSERVATION_JSON_BYTES = 256 * 1024 * 1024


class PdfInspectionError(ValueError):
    """Stable, coded PDF inspection failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def inspect_pdf(
    document: bytes | bytearray | memoryview,
    page_observations: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Inventory PDF risks and renderer coverage without claiming redaction."""

    observations_json = (
        None
        if page_observations is None
        else json.dumps(list(page_observations), separators=(",", ":"))
    )
    if observations_json is not None and len(observations_json.encode("utf-8")) > PDF_MAX_OBSERVATION_JSON_BYTES:
        raise PdfInspectionError("observation-limit-exceeded", "PDF observation JSON exceeds the supported UTF-8 byte limit")
    try:
        return json.loads(_inspect_pdf_json(bytes(document), observations_json))
    except ValueError as error:
        message = str(error)
        prefix, separator, _ = message.partition(":")
        code = prefix if separator else "invalid-document"
        raise PdfInspectionError(code, message) from error
