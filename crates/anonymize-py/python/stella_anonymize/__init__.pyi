from __future__ import annotations

from os import PathLike
from typing import TypeAlias

from ._native import (
    OperatorEntry as OperatorEntry,
    PipelineEntity as PipelineEntity,
    PreparedSearch as PreparedSearch,
    RedactionEntry as RedactionEntry,
    RedactionResult as RedactionResult,
    StaticRedactionResult as StaticRedactionResult,
    native_package_version as native_package_version,
    normalize_for_search as normalize_for_search,
    prepare_static_search_artifacts_bytes as prepare_static_search_artifacts_bytes,
    prepare_static_search_compressed_package_bytes as prepare_static_search_compressed_package_bytes,
    prepare_static_search_package_bytes as prepare_static_search_package_bytes,
    redact_static_entities_diagnostics_json as redact_static_entities_diagnostics_json,
    redact_static_entities_json as redact_static_entities_json,
)

BytesLike: TypeAlias = bytes | bytearray | memoryview
PathLikeString: TypeAlias = str | PathLike[str]

def prepare_search_package(
    config_json: str, *, compressed: bool = True
) -> bytes: ...
def load_prepared_package(package_bytes: BytesLike) -> PreparedSearch: ...
def load_prepared_package_file(
    package_path: PathLikeString,
) -> PreparedSearch: ...

__all__: list[str]
