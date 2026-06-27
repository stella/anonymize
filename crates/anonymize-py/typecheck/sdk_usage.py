from __future__ import annotations

import stella_anonymize as anonymize


def redact_with_prepared_package(config_json: str, text: str) -> str:
    package_bytes = anonymize.prepare_search_package(config_json)
    prepared = anonymize.load_prepared_package(package_bytes)
    result = prepared.redact_text(text)
    return result.redaction.redacted_text


def redact_with_package_file(package_path: str, text: str) -> int:
    prepared = anonymize.load_prepared_package_file(package_path)
    result = prepared.redact_text(text, {"country": "redact"})
    return result.redaction.entity_count


def redact_with_default_package(text: str) -> int:
    prepared = anonymize.get_default_native_pipeline(language="en")
    warmed = anonymize.preload_default_native_pipeline(language="en")
    assert prepared is warmed
    result = prepared.redact_text(text, {"country": "redact"})
    return result.redaction.entity_count


def default_package_size() -> int:
    return len(anonymize.read_default_native_pipeline_package_file(language="en"))


def runtime_version() -> str:
    return anonymize.native_package_version()


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
