from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from os import PathLike
from typing import Literal, TypeAlias, TypedDict

from ._native import (
    PreparedSearch as NativePreparedSearch,
    OperatorEntry as OperatorEntry,
    PipelineEntity as PipelineEntity,
    RedactionEntry as RedactionEntry,
    RedactionResult as RedactionResult,
    StaticRedactionResult as StaticRedactionResult,
    native_package_version as native_package_version,
    normalize_for_search as normalize_for_search,
    assemble_static_search_compressed_package_bytes as assemble_static_search_compressed_package_bytes,
    assemble_static_search_config_json as assemble_static_search_config_json,
    assemble_static_search_package_bytes as assemble_static_search_package_bytes,
    prepare_static_search_artifacts_bytes as prepare_static_search_artifacts_bytes,
    prepare_static_search_compressed_package_bytes as prepare_static_search_compressed_package_bytes,
    prepare_static_search_package_bytes as prepare_static_search_package_bytes,
    redact_static_entities_diagnostics_json as redact_static_entities_diagnostics_json,
    redact_static_entities_json as redact_static_entities_json,
    redact_static_entities_result_stream_json as redact_static_entities_result_stream_json,
    redact_static_entities_summary_diagnostics_json as redact_static_entities_summary_diagnostics_json,
)

BytesLike: TypeAlias = bytes | bytearray | memoryview
PathLikeString: TypeAlias = str | PathLike[str]
OperatorConfig: TypeAlias = Mapping[str, str] | str | None
CALLER_DETECTION_CONTRACT_VERSION: int

class CallerDetection(TypedDict):
    start: int
    end: int
    label: str
    score: float
    provider_id: str
    detection_id: str

DiagnosticsBatchCallback: TypeAlias = Callable[[str], object]
ResultEventCallback: TypeAlias = Callable[[str], object]
NativeSearchPackageInput: TypeAlias = str | BytesLike | Mapping[str, object]
DefaultNativePipelineWarmup: TypeAlias = Literal["lazy-regex", "none"]
DEFAULT_NATIVE_PIPELINE_WARMUPS: tuple[
    DefaultNativePipelineWarmup,
    DefaultNativePipelineWarmup,
]
__version__: str

class PreparedAnonymizer:
    def __init__(self, prepared: NativePreparedSearch) -> None: ...
    @classmethod
    def from_config_json(
        cls,
        config_json: NativeSearchPackageInput,
    ) -> PreparedAnonymizer: ...
    @classmethod
    def from_config_json_and_artifact_bytes(
        cls,
        config_json: NativeSearchPackageInput,
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
    def redact_text_with_caller_detections(
        self,
        full_text: str,
        detections: Sequence[CallerDetection],
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult: ...
    def redact_text_with_caller_detections_json(
        self,
        full_text: str,
        detections: Sequence[CallerDetection],
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def redact_text_with_caller_detections_diagnostics_json(
        self,
        full_text: str,
        detections: Sequence[CallerDetection],
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def redact_static_entities_with_caller_detections(
        self,
        full_text: str,
        detections: Sequence[CallerDetection],
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> StaticRedactionResult: ...
    def redact_text_stream_json(
        self,
        full_text: str,
        on_event: ResultEventCallback,
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
    def diagnostics_stream_json(
        self,
        full_text: str,
        on_batch: DiagnosticsBatchCallback,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...
    def summary_diagnostics_json(
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
    def redact_static_entities_result_stream_json(
        self,
        full_text: str,
        on_event: ResultEventCallback,
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
    def redact_static_entities_summary_diagnostics_json(
        self,
        full_text: str,
        operators: OperatorConfig = None,
        *,
        redact_string: str | None = None,
    ) -> str: ...

PreparedSearch: TypeAlias = PreparedAnonymizer

def prepare_search_package(
    config_json: NativeSearchPackageInput, *, compressed: bool = False
) -> bytes: ...
def load_prepared_package(package_bytes: BytesLike) -> PreparedAnonymizer: ...
def load_prepared_package_file(
    package_path: PathLikeString,
) -> PreparedAnonymizer: ...
def read_default_native_pipeline_package_file(
    *,
    language: str | None = None,
) -> bytes: ...
def available_default_native_pipeline_languages() -> tuple[str, ...]: ...
def create_native_pipeline_from_default_package(
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
    warmup: DefaultNativePipelineWarmup | None = None,
) -> PreparedAnonymizer: ...
def get_default_native_pipeline(
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
    warmup: DefaultNativePipelineWarmup | None = None,
) -> PreparedAnonymizer: ...
def preload_default_native_pipeline(
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
) -> PreparedAnonymizer: ...
def redact_default_text(
    full_text: str,
    operators: OperatorConfig = None,
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
    warmup: DefaultNativePipelineWarmup | None = None,
    redact_string: str | None = None,
) -> StaticRedactionResult: ...
def redact_default_text_json(
    full_text: str,
    operators: OperatorConfig = None,
    *,
    language: str | None = None,
    package_path: PathLikeString | None = None,
    warmup: DefaultNativePipelineWarmup | None = None,
    redact_string: str | None = None,
) -> str: ...
def redact_text(
    config_json: NativeSearchPackageInput,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> StaticRedactionResult: ...
def redact_text_json(
    config_json: NativeSearchPackageInput,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str: ...
def redact_text_stream_json(
    config_json: NativeSearchPackageInput,
    full_text: str,
    on_event: ResultEventCallback,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str: ...
def diagnostics_json(
    config_json: NativeSearchPackageInput,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str: ...
def diagnostics_stream_json(
    config_json: NativeSearchPackageInput,
    full_text: str,
    on_batch: DiagnosticsBatchCallback,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str: ...
def summary_diagnostics_json(
    config_json: NativeSearchPackageInput,
    full_text: str,
    operators: OperatorConfig = None,
    *,
    redact_string: str | None = None,
) -> str: ...

__all__: list[str]
