# stella-anonymize-core

Python bindings for the stella anonymization Rust core.

## Install

Prebuilt wheels are published to PyPI (this activates with the next release).
Wheels ship the bundled native pipeline packages, so no monorepo checkout is
needed:

```bash
uv add stella-anonymize-core
# or: pip install stella-anonymize-core
```

Wheels target Python 3.11+ (abi3) on manylinux x64/aarch64, macOS x64/arm64,
and Windows x64. Only wheels are published; there is no source distribution.
The `build.rs` step needs the monorepo's generated `.stlanonpkg` native
pipeline packages, so a source build cannot be self-contained. To build from a
checkout instead, run `bun run build` first so those packages exist, then:

```bash
uv add ./crates/anonymize-py
```

## Usage

Prepare or load the anonymizer once, then reuse it for documents.

```py
import stella_anonymize as anonymize

languages = anonymize.available_default_native_pipeline_languages()
prepared = anonymize.preload_default_native_pipeline(
    language="en" if "en" in languages else None
)
result = prepared.redact_text(text, redact_string="***")

print(result.redaction.redacted_text)
```

Caller-produced detections use Python character indexes and enter the same
resolution and redaction pipeline as built-in detections:

```py
result = prepared.redact_text_with_caller_detections(
    "😀Alice signed.",
    [{"start": 1, "end": 6, "label": "person", "score": 0.95,
      "provider_id": "example-ner", "detection_id": "person-1"}],
)
```

Pass `{"organization": "keep"}` as the operators argument to preserve
detected organizations while processing other labels normally. Kept entities
remain in the result and operator map, but create no reversible mapping entry.

`provider_id` and `detection_id` are required 1–128 byte ASCII identifiers:
they start with an alphanumeric character and otherwise contain only
alphanumerics, `.`, `_`, `:`, or `-`. Do not encode personal data in them.
Retained entities preserve both IDs;
`redact_text_with_caller_detections_diagnostics_json()` reports audit-safe
external input and retained counts without matched text.

Regional codes use the exact package when present and otherwise fall back to
the base language package, so `en-US` can use the shipped `en` artifact.

For caller-owned configs, prepare package bytes before serving documents and
load them at runtime:

```py
import stella_anonymize as anonymize

package_bytes = anonymize.prepare_search_package(config_json)
prepared = anonymize.load_prepared_package(package_bytes)
prepared.warm_lazy_regex()
result = prepared.redact_text(text, redact_string="***")
```

`get_default_native_pipeline()` defers lazy regex warmup by default so the first
call only pays for regexes the document actually touches. Use
`preload_default_native_pipeline()` or pass `warmup="lazy-regex"` when startup can
absorb that cost before serving documents. Top-level `redact_text()` and
`redact_text_json()` are available for one-off calls, but they prepare from config
on each invocation. Use `load_prepared_package()` or `load_prepared_package_file()`
for repeated document processing.

## API

- `prepare_search_package(config_json | config_bytes | config_mapping, compressed=True) -> bytes`
- `load_prepared_package(package_bytes) -> PreparedAnonymizer`
- `load_prepared_package_file(package_path) -> PreparedAnonymizer`
- `available_default_native_pipeline_languages() -> tuple[str, ...]`
- `read_default_native_pipeline_package_file(language=None) -> bytes`
- `get_default_native_pipeline(language=None, package_path=None, warmup="none") -> PreparedAnonymizer`
- `preload_default_native_pipeline(language=None, package_path=None) -> PreparedAnonymizer`
- `PreparedAnonymizer.warm_lazy_regex()`
- `PreparedAnonymizer.warm_lazy_regex_diagnostics_json()`
- `PreparedAnonymizer.redact_text(text, operators=None, redact_string=None)`
- `PreparedAnonymizer.redact_text_json(text, operators=None, redact_string=None)`
- `PreparedAnonymizer.diagnostics_json(text, operators=None, redact_string=None)`

`PreparedSearch` is an alias for `PreparedAnonymizer`.
