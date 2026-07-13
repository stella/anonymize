from __future__ import annotations

from collections.abc import Callable
from typing import TypeAlias

BytesLike: TypeAlias = bytes | bytearray | memoryview
ResultEventCallback: TypeAlias = Callable[[str], object]

class RedactionEntry:
    @property
    def placeholder(self) -> str: ...
    @property
    def original(self) -> str: ...

class OperatorEntry:
    @property
    def placeholder(self) -> str: ...
    @property
    def operator(self) -> str: ...

class RedactionResult:
    @property
    def redacted_text(self) -> str: ...
    @property
    def redaction_map(self) -> list[RedactionEntry]: ...
    @property
    def operator_map(self) -> list[OperatorEntry]: ...
    @property
    def entity_count(self) -> int: ...

class PipelineEntity:
    @property
    def start(self) -> int: ...
    @property
    def end(self) -> int: ...
    @property
    def label(self) -> str: ...
    @property
    def text(self) -> str: ...
    @property
    def score(self) -> float: ...
    @property
    def source(self) -> str: ...
    @property
    def source_detail(self) -> str | None: ...
    @property
    def provider_id(self) -> str | None: ...
    @property
    def detection_id(self) -> str | None: ...

class StaticRedactionResult:
    @property
    def resolved_entities(self) -> list[PipelineEntity]: ...
    @property
    def redaction(self) -> RedactionResult: ...

class PreparedRedactionSession:
    def session_id(self) -> str: ...
    def mapping_count(self) -> int: ...
    def to_plaintext_json(self) -> str: ...
    def redact_static_entities(
        self,
        full_text: str,
        operators_json: str | None = None,
    ) -> StaticRedactionResult: ...
    def redact_static_entities_json(
        self,
        full_text: str,
        operators_json: str | None = None,
    ) -> str: ...

class PreparedSearch:
    def __init__(self, config_json: str) -> None: ...
    @staticmethod
    def from_config_json_and_artifact_bytes(
        config_json: str,
        artifact_bytes: BytesLike,
    ) -> PreparedSearch: ...
    @staticmethod
    def from_prepared_package_bytes(
        package_bytes: BytesLike,
    ) -> PreparedSearch: ...
    @staticmethod
    def from_trusted_prepared_package_bytes(
        package_bytes: BytesLike,
    ) -> PreparedSearch: ...
    @staticmethod
    def from_trusted_prepared_package_bytes_without_cache(
        package_bytes: BytesLike,
    ) -> PreparedSearch: ...
    def prepare_diagnostics_json(self) -> str: ...
    def warm_lazy_regex(self) -> None: ...
    def warm_lazy_regex_diagnostics_json(self) -> str: ...
    def create_redaction_session(
        self,
        session_id: str,
    ) -> PreparedRedactionSession: ...
    def restore_redaction_session(
        self,
        plaintext_json: str,
    ) -> PreparedRedactionSession: ...
    def redact_static_entities(
        self,
        full_text: str,
        operators_json: str | None = None,
    ) -> StaticRedactionResult: ...
    def redact_static_entities_json(
        self,
        full_text: str,
        operators_json: str | None = None,
    ) -> str: ...
    def redact_static_entities_with_caller_detections(
        self,
        full_text: str,
        request_json: str,
        operators_json: str | None = None,
    ) -> StaticRedactionResult: ...
    def redact_static_entities_with_caller_detections_json(
        self,
        full_text: str,
        request_json: str,
        operators_json: str | None = None,
    ) -> str: ...
    def redact_static_entities_with_caller_detections_diagnostics_json(
        self,
        full_text: str,
        request_json: str,
        operators_json: str | None = None,
    ) -> str: ...
    def redact_static_entities_result_stream_json(
        self,
        full_text: str,
        on_event: ResultEventCallback,
        operators_json: str | None = None,
    ) -> str: ...
    def redact_static_entities_diagnostics_json(
        self,
        full_text: str,
        operators_json: str | None = None,
    ) -> str: ...
    def redact_static_entities_summary_diagnostics_json(
        self,
        full_text: str,
        operators_json: str | None = None,
    ) -> str: ...

def redact_static_entities_json(
    config_json: str,
    full_text: str,
    operators_json: str | None = None,
) -> str: ...
def redact_static_entities_result_stream_json(
    config_json: str,
    full_text: str,
    on_event: ResultEventCallback,
    operators_json: str | None = None,
) -> str: ...
def assemble_static_search_config_json(
    pipeline_config_json: str,
    dictionaries_json: str | None = None,
    gazetteer_json: str | None = None,
) -> str: ...
def assemble_static_search_package_bytes(
    pipeline_config_json: str,
    dictionaries_json: str | None = None,
    gazetteer_json: str | None = None,
) -> bytes: ...
def assemble_static_search_compressed_package_bytes(
    pipeline_config_json: str,
    dictionaries_json: str | None = None,
    gazetteer_json: str | None = None,
) -> bytes: ...
def prepare_static_search_artifacts_bytes(config_json: str) -> bytes: ...
def prepare_static_search_package_bytes(config_json: str) -> bytes: ...
def prepare_static_search_compressed_package_bytes(config_json: str) -> bytes: ...
def redact_static_entities_diagnostics_json(
    config_json: str,
    full_text: str,
    operators_json: str | None = None,
) -> str: ...
def redact_static_entities_summary_diagnostics_json(
    config_json: str,
    full_text: str,
    operators_json: str | None = None,
) -> str: ...
def normalize_for_search(text: str) -> str: ...
def native_package_version() -> str: ...
