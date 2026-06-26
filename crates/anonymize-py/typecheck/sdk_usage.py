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


def runtime_version() -> str:
    return anonymize.native_package_version()


def redact_json(config_json: str, text: str) -> str:
    return anonymize.redact_text_json(
        config_json,
        text,
        {"country": "redact"},
        redact_string="***",
    )
