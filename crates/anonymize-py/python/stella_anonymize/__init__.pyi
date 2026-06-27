from __future__ import annotations

from collections.abc import Mapping
from os import PathLike
from typing import TypeAlias

from ._native import (
    PreparedSearch as NativePreparedSearch,
    OperatorEntry as OperatorEntry,
    PipelineEntity as PipelineEntity,
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
OperatorConfig: TypeAlias = Mapping[str, str] | str | None

class PreparedAnonymizer:
    def __init__(self, prepared: NativePreparedSearch) -> None: ...
    @classmethod
    def from_config_json(cls, config_json: str) -> PreparedAnonymizer: ...
    @classmethod
    def from_config_json_and_artifact_bytes(
        cls,
        config_json: str,
        artifact_bytes: BytesLike,
    ) -> PreparedAnonymizer: ...
    @classmethod
    def from_prepared_package_bytes(
        cls,
        package_bytes: BytesLike,
    ) -> PreparedAnonymizer: ...
    def prepare_diagnostics_json(self) -> str: ...
    def warm_lazy_regex(self) -> None: ...
    def warm_lazy_regex_diagnostics_json(self) -> str: ...
    def redact_text(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult: ...
    def redact_text_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def diagnostics_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def redact_static_entities(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult: ...
    def redact_static_entities_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def redact_static_entities_diagnostics_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...

PreparedSearch: TypeAlias = PreparedAnonymizer

def prepare_search_package(
    config_json: str, *, compressed: bool = True
) -> bytes: ...
def load_prepared_package(package_bytes: BytesLike) -> PreparedAnonymizer: ...
def load_prepared_package_file(
    package_path: PathLikeString,
) -> PreparedAnonymizer: ...
def redact_text(
    config_json: str,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> StaticRedactionResult: ...
def redact_text_json(
    config_json: str,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str: ...
def diagnostics_json(
    config_json: str,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str: ...

__all__: list[str]
