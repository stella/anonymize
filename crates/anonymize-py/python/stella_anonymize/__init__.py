from __future__ import annotations

import json
from collections.abc import Mapping
from functools import lru_cache
from os import PathLike

from ._native import (
    OperatorEntry,
    PipelineEntity,
    PreparedSearch as NativePreparedSearch,
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
    "OperatorConfig",
    "PreparedAnonymizer",
    "NativePreparedSearch",
    "PipelineEntity",
    "PreparedSearch",
    "RedactionEntry",
    "RedactionResult",
    "StaticRedactionResult",
    "diagnostics_json",
    "load_prepared_package",
    "load_prepared_package_file",
    "native_package_version",
    "normalize_for_search",
    "prepare_search_package",
    "prepare_static_search_artifacts_bytes",
    "prepare_static_search_compressed_package_bytes",
    "prepare_static_search_package_bytes",
    "redact_text_json",
    "redact_static_entities_diagnostics_json",
    "redact_static_entities_json",
]

BytesLike = bytes | bytearray | memoryview
PathLikeString = str | PathLike[str]
OperatorConfig = Mapping[str, str] | str | None


class PreparedAnonymizer:
    def __init__(self, prepared: NativePreparedSearch) -> None:
        self._prepared = prepared

    @classmethod
    def from_config_json(cls, config_json: str) -> PreparedAnonymizer:
        return cls(NativePreparedSearch(config_json))

    @classmethod
    def from_config_json_and_artifact_bytes(
        cls,
        config_json: str,
        artifact_bytes: BytesLike,
    ) -> PreparedAnonymizer:
        return cls(
            NativePreparedSearch.from_config_json_and_artifact_bytes(
                config_json,
                bytes(artifact_bytes),
            )
        )

    @classmethod
    def from_prepared_package_bytes(
        cls,
        package_bytes: BytesLike,
    ) -> PreparedAnonymizer:
        return cls(
            NativePreparedSearch.from_prepared_package_bytes(bytes(package_bytes))
        )

    def prepare_diagnostics_json(self) -> str:
        return self._prepared.prepare_diagnostics_json()

    def redact_text(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult:
        return self._prepared.redact_static_entities(
            full_text,
            _operator_config_json(operators, redact_string=redact_string),
        )

    def redact_text_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self._prepared.redact_static_entities_json(
            full_text,
            _operator_config_json(operators, redact_string=redact_string),
        )

    def diagnostics_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self._prepared.redact_static_entities_diagnostics_json(
            full_text,
            _operator_config_json(operators, redact_string=redact_string),
        )

    def redact_static_entities(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult:
        return self.redact_text(
            full_text,
            operators,
            redact_string=redact_string,
        )

    def redact_static_entities_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self.redact_text_json(
            full_text,
            operators,
            redact_string=redact_string,
        )

    def redact_static_entities_diagnostics_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str:
        return self.diagnostics_json(
            full_text,
            operators,
            redact_string=redact_string,
        )


PreparedSearch = PreparedAnonymizer


def prepare_search_package(config_json: str, *, compressed: bool = True) -> bytes:
    if compressed:
        return prepare_static_search_compressed_package_bytes(config_json)
    return prepare_static_search_package_bytes(config_json)


def load_prepared_package(package_bytes: BytesLike) -> PreparedAnonymizer:
    return _load_prepared_package(bytes(package_bytes))


def load_prepared_package_file(package_path: PathLikeString) -> PreparedAnonymizer:
    with open(package_path, "rb") as handle:
        return load_prepared_package(handle.read())


@lru_cache(maxsize=8)
def _load_prepared_package(package_bytes: bytes) -> PreparedAnonymizer:
    return PreparedAnonymizer.from_prepared_package_bytes(package_bytes)


def redact_text_json(
    config_json: str,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str:
    return PreparedAnonymizer.from_config_json(config_json).redact_text_json(
        full_text,
        operators,
        redact_string=redact_string,
    )


def diagnostics_json(
    config_json: str,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str:
    return PreparedAnonymizer.from_config_json(config_json).diagnostics_json(
        full_text,
        operators,
        redact_string=redact_string,
    )


def _operator_config_json(
    operators: OperatorConfig,
    *,
    redact_string: str | None,
) -> str | None:
    if operators is None and redact_string is None:
        return None
    if isinstance(operators, str):
        if redact_string is not None:
            raise ValueError("redact_string cannot be combined with raw JSON")
        return operators
    payload: dict[str, object] = {}
    if operators is not None:
        payload["operators"] = dict(operators)
    if redact_string is not None:
        payload["redactString"] = redact_string
    return json.dumps(payload, separators=(",", ":"))
