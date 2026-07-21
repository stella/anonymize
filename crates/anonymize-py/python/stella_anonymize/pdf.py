"""Fail-closed PDF coverage inspection; this module does not redact PDFs."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from ._native import inspect_pdf_json as _inspect_pdf_json

PDF_INSPECTION_CONTRACT_VERSION = 1
PDF_OBSERVATION_BATCH_VERSION = 1
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


def _observation_json(observation_batch: Mapping[str, Any]) -> str:
    try:
        serialized = json.dumps(
            observation_batch, separators=(",", ":"), ensure_ascii=False
        )
    except (TypeError, ValueError, OverflowError) as error:
        raise PdfInspectionError(
            "invalid-observation",
            "invalid-observation: PDF observation batch is not JSON-serializable",
        ) from error
    # JavaScript JSON.stringify escapes lone UTF-16 surrogates. Python retains
    # them with ensure_ascii=False, so canonicalize only that invalid Unicode
    # range while leaving ordinary non-ASCII text encoded as UTF-8.
    return "".join(
        f"\\u{ord(character):04x}" if "\ud800" <= character <= "\udfff" else character
        for character in serialized
    )


def inspect_pdf(
    document: bytes | bytearray | memoryview,
    observation_batch: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Inventory PDF risks and renderer coverage without claiming redaction."""

    observations_json = (
        None if observation_batch is None else _observation_json(observation_batch)
    )
    try:
        observation_json_bytes = (
            0 if observations_json is None else len(observations_json.encode("utf-8"))
        )
    except UnicodeError as error:
        raise PdfInspectionError(
            "invalid-observation",
            "invalid-observation: PDF observation batch is not valid UTF-8",
        ) from error
    if observation_json_bytes > PDF_MAX_OBSERVATION_JSON_BYTES:
        raise PdfInspectionError(
            "observation-limit-exceeded",
            f"observation-limit-exceeded: PDF observation JSON must not exceed {PDF_MAX_OBSERVATION_JSON_BYTES} UTF-8 bytes",
        )
    try:
        return json.loads(_inspect_pdf_json(bytes(document), observations_json))
    except ValueError as error:
        message = str(error)
        prefix, separator, _ = message.partition(":")
        code = prefix if separator else "invalid-document"
        raise PdfInspectionError(code, message) from error
