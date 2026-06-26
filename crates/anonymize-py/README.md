# stella-anonymize-core

Python bindings for the Stella anonymization Rust core.

## Install

```bash
uv add stella-anonymize-core
```

## Usage

Prepare or load the anonymizer once, then reuse it for documents.

```py
import stella_anonymize as anonymize

package_bytes = anonymize.prepare_search_package(config_json)
prepared = anonymize.load_prepared_package(package_bytes)
result = prepared.redact_text(text, redact_string="***")

print(result.redaction.redacted_text)
```

For prepared package files:

```py
import stella_anonymize as anonymize

prepared = anonymize.load_prepared_package_file("anonymize.stlanonpkg")
result_json = prepared.redact_text_json(text)
```

Top-level `redact_text()` and `redact_text_json()` are available for one-off calls, but they prepare from config on each invocation. Use `load_prepared_package()` or `load_prepared_package_file()` for repeated document processing.

## API

- `prepare_search_package(config_json, compressed=True) -> bytes`
- `load_prepared_package(package_bytes) -> PreparedAnonymizer`
- `load_prepared_package_file(package_path) -> PreparedAnonymizer`
- `PreparedAnonymizer.redact_text(text, operators=None, redact_string=None)`
- `PreparedAnonymizer.redact_text_json(text, operators=None, redact_string=None)`
- `PreparedAnonymizer.diagnostics_json(text, operators=None, redact_string=None)`

`PreparedSearch` is an alias for `PreparedAnonymizer`.
