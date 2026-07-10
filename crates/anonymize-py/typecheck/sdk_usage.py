from __future__ import annotations

from collections.abc import Mapping

import stella_anonymize as anonymize


def redact_with_prepared_package(config_json: str, text: str) -> str:
    package_bytes = anonymize.prepare_search_package(config_json)
    prepared = anonymize.load_prepared_package(package_bytes)
    result = prepared.redact_text(text)
    return result.redaction.redacted_text


def redact_with_config_input(
    config: anonymize.NativeSearchPackageInput,
    text: str,
) -> str:
    return anonymize.redact_text_json(config, text, redact_string="***")


def prepare_package_from_object(config: Mapping[str, object]) -> bytes:
    return anonymize.prepare_search_package(config, compressed=False)


def prepare_package_from_bytes(config_json: bytes) -> bytes:
    return anonymize.prepare_search_package(config_json)


def redact_with_package_file(package_path: str, text: str) -> int:
    prepared = anonymize.load_prepared_package_file(package_path)
    result = prepared.redact_text(text, {"country": "redact"})
    return result.redaction.entity_count


def redact_with_default_package(text: str) -> int:
    prepared = anonymize.get_default_native_pipeline(language="en")
    deferred = anonymize.get_default_native_pipeline(
        language="en",
        warmup="none",
    )
    warmed = anonymize.preload_default_native_pipeline(language="en")
    assert prepared is deferred
    assert prepared is warmed
    result = prepared.redact_text(text, {"country": "redact"})
    return result.redaction.entity_count


def redact_default_helper(text: str) -> str:
    return anonymize.redact_default_text_json(
        text,
        {"country": "redact"},
        language="en",
        redact_string="***",
    )


def redact_default_object(text: str) -> int:
    result = anonymize.redact_default_text(
        text,
        {"country": "redact"},
        language="en",
    )
    return result.redaction.entity_count


def default_package_size() -> int:
    return len(anonymize.read_default_native_pipeline_package_file(language="en"))


def default_package_languages() -> tuple[str, ...]:
    return anonymize.available_default_native_pipeline_languages()


def runtime_version() -> str:
    return anonymize.native_package_version()


def redact_caller_detection(text: str) -> str:
    prepared = anonymize.get_default_native_pipeline(language="en")
    detections: list[anonymize.CallerDetection] = [
        {"start": 0, "end": len(text), "label": "person", "score": 0.9}
    ]
    return prepared.redact_text_with_caller_detections(
        text,
        detections,
    ).redaction.redacted_text


def package_version() -> str:
    return anonymize.__version__


def redact_json(config_json: str, text: str) -> str:
    return anonymize.redact_text_json(
        config_json,
        text,
        {"country": "redact"},
        redact_string="***",
    )


def redact_object(config_json: str, text: str) -> int:
    result = anonymize.redact_text(
        config_json,
        text,
        {"country": "redact"},
        redact_string="***",
    )
    return result.redaction.entity_count
