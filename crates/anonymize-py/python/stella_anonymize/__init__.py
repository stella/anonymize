from __future__ import annotations

import json
import re
from collections.abc import Mapping
from functools import lru_cache
from importlib.resources import files
from os import PathLike
from typing import Literal
from weakref import WeakSet

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
    "DefaultNativePipelineWarmup",
    "DEFAULT_NATIVE_PIPELINE_WARMUPS",
    "PreparedAnonymizer",
    "NativePreparedSearch",
    "PipelineEntity",
    "PreparedSearch",
    "RedactionEntry",
    "RedactionResult",
    "StaticRedactionResult",
    "create_native_pipeline_from_default_package",
    "diagnostics_json",
    "get_default_native_pipeline",
    "load_prepared_package",
    "load_prepared_package_file",
    "native_package_version",
    "normalize_for_search",
    "preload_default_native_pipeline",
    "prepare_search_package",
    "prepare_static_search_artifacts_bytes",
    "prepare_static_search_compressed_package_bytes",
    "prepare_static_search_package_bytes",
    "read_default_native_pipeline_package_file",
    "redact_text",
    "redact_text_json",
    "redact_static_entities_diagnostics_json",
    "redact_static_entities_json",
]

BytesLike = bytes | bytearray | memoryview
PathLikeString = str | PathLike[str]
OperatorConfig = Mapping[str, str] | str | None
DefaultNativePipelineWarmup = Literal["lazy-regex", "none"]
DEFAULT_NATIVE_PIPELINE_WARMUPS: tuple[
    DefaultNativePipelineWarmup,
    DefaultNativePipelineWarmup,
] = ("lazy-regex", "none")
DEFAULT_NATIVE_PIPELINE_PACKAGE = "native-pipeline.stlanonpkg"
_DEFAULT_NATIVE_PIPELINE_LANGUAGE_PATTERN = re.compile(
    r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
)


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

    def warm_lazy_regex(self) -> None:
        self._prepared.warm_lazy_regex()

    def warm_lazy_regex_diagnostics_json(self) -> str:
        return self._prepared.warm_lazy_regex_diagnostics_json()

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
_warmed_default_native_pipelines: WeakSet[PreparedAnonymizer] = WeakSet()


def prepare_search_package(config_json: str, *, compressed: bool = True) -> bytes:
    if compressed:
        return prepare_static_search_compressed_package_bytes(config_json)
    return prepare_static_search_package_bytes(config_json)


def load_prepared_package(package_bytes: BytesLike) -> PreparedAnonymizer:
    return _load_prepared_package(bytes(package_bytes))


def load_prepared_package_file(package_path: PathLikeString) -> PreparedAnonymizer:
    with open(package_path, "rb") as handle:
        return load_prepared_package(handle.read())


def read_default_native_pipeline_package_file(
    *,
    language: str | None = None,
) -> bytes:
    package_name = _default_native_pipeline_package_name(language)
    try:
        resource = files(__name__).joinpath("native_packages", package_name)
        return resource.read_bytes()
    except (FileNotFoundError, ModuleNotFoundError, OSError) as error:
        raise FileNotFoundError(
            f"{_default_native_pipeline_package_description(language)} is unavailable: {error}"
        ) from error


def create_native_pipeline_from_default_package(
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
    warmup: DefaultNativePipelineWarmup | None = None,
) -> PreparedAnonymizer:
    return _apply_default_native_pipeline_warmup(
        PreparedAnonymizer.from_prepared_package_bytes(
            _read_default_native_pipeline_package(
                language=language,
                package_path=package_path,
            )
        ),
        _normalize_default_native_pipeline_warmup(warmup),
    )


def get_default_native_pipeline(
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
    warmup: DefaultNativePipelineWarmup | None = None,
) -> PreparedAnonymizer:
    return _apply_default_native_pipeline_warmup(
        _get_default_native_pipeline(
            _default_native_pipeline_cache_key(
                language=language,
                package_path=package_path,
            )
        ),
        _normalize_default_native_pipeline_warmup(warmup),
    )


def preload_default_native_pipeline(
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
) -> PreparedAnonymizer:
    return _apply_default_native_pipeline_warmup(
        get_default_native_pipeline(
            language=language,
            package_path=package_path,
            warmup="none",
        ),
        "lazy-regex",
    )


def _apply_default_native_pipeline_warmup(
    pipeline: PreparedAnonymizer,
    warmup: DefaultNativePipelineWarmup,
) -> PreparedAnonymizer:
    if warmup != "lazy-regex":
        return pipeline
    if pipeline not in _warmed_default_native_pipelines:
        pipeline.warm_lazy_regex()
        _warmed_default_native_pipelines.add(pipeline)
    return pipeline


def _normalize_default_native_pipeline_warmup(
    warmup: DefaultNativePipelineWarmup | None,
) -> DefaultNativePipelineWarmup:
    if warmup is None:
        return "lazy-regex"
    if warmup in DEFAULT_NATIVE_PIPELINE_WARMUPS:
        return warmup
    raise ValueError('Default native pipeline warmup must be "lazy-regex" or "none"')


@lru_cache(maxsize=8)
def _load_prepared_package(package_bytes: bytes) -> PreparedAnonymizer:
    return PreparedAnonymizer.from_prepared_package_bytes(package_bytes)


@lru_cache(maxsize=8)
def _get_default_native_pipeline(
    cache_key: tuple[str | None, str | None],
) -> PreparedAnonymizer:
    language, package_path = cache_key
    return create_native_pipeline_from_default_package(
        language=language,
        package_path=package_path,
        warmup="none",
    )


@lru_cache(maxsize=8)
def _prepare_from_config_json(config_json: str) -> PreparedAnonymizer:
    return PreparedAnonymizer.from_config_json(config_json)


def redact_text(
    config_json: str,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> StaticRedactionResult:
    return _prepare_from_config_json(config_json).redact_text(
        full_text,
        operators,
        redact_string=redact_string,
    )


def redact_text_json(
    config_json: str,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str:
    return _prepare_from_config_json(config_json).redact_text_json(
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
    return _prepare_from_config_json(config_json).diagnostics_json(
        full_text,
        operators,
        redact_string=redact_string,
    )


def _read_default_native_pipeline_package(
    *,
    language: str | None,
    package_path: PathLikeString | None,
) -> bytes:
    if language is not None and package_path is not None:
        raise ValueError("Use either language or package_path, not both")
    if package_path is not None:
        with open(package_path, "rb") as handle:
            return handle.read()
    return read_default_native_pipeline_package_file(language=language)


def _default_native_pipeline_cache_key(
    *,
    language: str | None,
    package_path: PathLikeString | None,
) -> tuple[str | None, str | None]:
    if language is not None and package_path is not None:
        raise ValueError("Use either language or package_path, not both")
    return (
        _normalize_default_native_pipeline_language(language)
        if language is not None
        else None,
        str(package_path) if package_path is not None else None,
    )


def _default_native_pipeline_package_name(language: str | None) -> str:
    if language is None:
        return DEFAULT_NATIVE_PIPELINE_PACKAGE
    normalized = _normalize_default_native_pipeline_language(language)
    return f"native-pipeline.{normalized}.stlanonpkg"


def _default_native_pipeline_package_description(language: str | None) -> str:
    if language is None:
        return "Default native pipeline package"
    normalized = _normalize_default_native_pipeline_language(language)
    return f'Default native pipeline package for language "{normalized}"'


def _normalize_default_native_pipeline_language(language: str) -> str:
    normalized = language.strip().lower()
    if not _DEFAULT_NATIVE_PIPELINE_LANGUAGE_PATTERN.fullmatch(normalized):
        raise ValueError(
            "Default native pipeline language must match "
            f"{_DEFAULT_NATIVE_PIPELINE_LANGUAGE_PATTERN.pattern}"
        )
    return normalized


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
