# stella-anonymize-core

Python bindings for the stella anonymization Rust core.

## Install

```bash
uv add stella-anonymize-core
```

## Usage

Prepare or load the anonymizer once, then reuse it for documents.

```py
import stella_anonymize as anonymize

prepared = anonymize.preload_default_native_pipeline(language="en")
result = prepared.redact_text(text, redact_string="***")

print(result.redaction.redacted_text)
```

For caller-owned configs, prepare package bytes before serving documents and
load them at runtime:

```py
import stella_anonymize as anonymize

package_bytes = anonymize.prepare_search_package(config_json)
prepared = anonymize.load_prepared_package(package_bytes)
prepared.warm_lazy_regex()
result = prepared.redact_text(text, redact_string="***")
```

`get_default_native_pipeline()` warms lazy regexes by default so the first document does not pay that cost. Pass `warmup="none"` only when the caller wants to defer warmup deliberately. Top-level `redact_text()` and `redact_text_json()` are available for one-off calls, but they prepare from config on each invocation. Use `load_prepared_package()` or `load_prepared_package_file()` for repeated document processing, then call `warm_lazy_regex()` before the first document when startup can absorb that cost.

## API

- `prepare_search_package(config_json, compressed=True) -> bytes`
- `load_prepared_package(package_bytes) -> PreparedAnonymizer`
- `load_prepared_package_file(package_path) -> PreparedAnonymizer`
- `read_default_native_pipeline_package_file(language=None) -> bytes`
- `get_default_native_pipeline(language=None, package_path=None, warmup="lazy-regex") -> PreparedAnonymizer`
- `preload_default_native_pipeline(language=None, package_path=None) -> PreparedAnonymizer`
- `PreparedAnonymizer.warm_lazy_regex()`
- `PreparedAnonymizer.warm_lazy_regex_diagnostics_json()`
- `PreparedAnonymizer.redact_text(text, operators=None, redact_string=None)`
- `PreparedAnonymizer.redact_text_json(text, operators=None, redact_string=None)`
- `PreparedAnonymizer.diagnostics_json(text, operators=None, redact_string=None)`

`PreparedSearch` is an alias for `PreparedAnonymizer`.
