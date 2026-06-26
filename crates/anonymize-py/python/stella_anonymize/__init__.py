from __future__ import annotations

from functools import lru_cache
from os import PathLike

from ._native import (
    OperatorEntry,
    PipelineEntity,
    PreparedSearch,
    RedactionEntry,
    RedactionResult,
    StaticRedactionResult,
    native_package_version,
    normalize_for_search,
    prepare_static_search_artifacts_bytes,
    prepare_static_search_compressed_package_bytes,
    prepare_static_search_package_bytes,
    redact_static_entities_diagnostics_json,
    redact_static_entities_json,
)

__all__ = [
    "OperatorEntry",
    "PipelineEntity",
    "PreparedSearch",
    "RedactionEntry",
    "RedactionResult",
    "StaticRedactionResult",
    "load_prepared_package",
    "load_prepared_package_file",
    "native_package_version",
    "normalize_for_search",
    "prepare_search_package",
    "prepare_static_search_artifacts_bytes",
    "prepare_static_search_compressed_package_bytes",
    "prepare_static_search_package_bytes",
    "redact_static_entities_diagnostics_json",
    "redact_static_entities_json",
]

BytesLike = bytes | bytearray | memoryview
PathLikeString = str | PathLike[str]


def prepare_search_package(config_json: str, *, compressed: bool = True) -> bytes:
    if compressed:
        return prepare_static_search_compressed_package_bytes(config_json)
    return prepare_static_search_package_bytes(config_json)


def load_prepared_package(package_bytes: BytesLike) -> PreparedSearch:
    return _load_prepared_package(bytes(package_bytes))


def load_prepared_package_file(package_path: PathLikeString) -> PreparedSearch:
    with open(package_path, "rb") as handle:
        return load_prepared_package(handle.read())


@lru_cache(maxsize=8)
def _load_prepared_package(package_bytes: bytes) -> PreparedSearch:
    return PreparedSearch.from_prepared_package_bytes(package_bytes)
