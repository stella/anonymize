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

Reverse replacement placeholders with the returned redaction map (a mapping of
`placeholder -> original`, a sequence of `RedactionEntry`, or
`(placeholder, original)` pairs; entries apply in order):

```py
restored = anonymize.deanonymise(
    result.redaction.redacted_text,
    result.redaction.redaction_map,
)
```

For related documents, create an explicit in-memory session from the prepared
anonymizer. Repeated normalized entities reuse their placeholders within that
session:

```py
session = prepared.create_redaction_session("opaque_case_1")
first = session.redact_text(first_document)
second = session.redact_text(second_document)
restored_text = session.restore_text(first.redaction.redacted_text)
```

`restore_text()` restores complete known placeholders in one non-cascading
pass. Other session namespaces remain unchanged; unknown placeholders owned by
the session fail closed. Lifecycle sessions also require the caller-supplied
`observed_at_epoch_seconds` argument.

`session.to_plaintext_json()` supports deterministic in-memory transfer between
runtime instances. Its output contains original personal data in plaintext: do
not log it or persist it without an application-owned protection layer. Restore
validated transfer state with `prepared.restore_redaction_session(json_state)`.

For persistence, use the authenticated binary archive API with a caller-owned
32-byte key. Restoring requires the expected session identity so an archive
cannot be substituted across records:

```py
archive = session.to_encrypted_archive(application_key)
restored = prepared.restore_encrypted_redaction_session(
    archive,
    application_key,
    session.session_id(),
)
```

Generate, store, rotate, and authorize access to the key outside the SDK. The
archive contains personal data as ciphertext; do not log the archive or key.
Lifecycle sessions use `to_encrypted_archive_at()` and require
`observed_at_epoch_seconds` when restored.

Sessions can carry explicit lifecycle bounds. The engine never reads the system
clock; supply the UTC epoch-second observation time for each lifecycle-aware
operation:

```py
session = prepared.create_redaction_session_with_lifecycle(
    "opaque_case_2",
    created_at_epoch_seconds=1_800_000_000,
    expires_at_epoch_seconds=1_800_086_400,
)
result = session.redact_text_at(
    document,
    observed_at_epoch_seconds=1_800_000_100,
)
metadata = session.inspect(1_800_000_100)  # contains no entity values
deletion = session.delete()
```

Expiry is fail-closed at its exact boundary. `delete()` performs logical
deletion: it clears the session mappings and prevents future use, but does not
revoke earlier exported copies or claim physical erasure of process memory.

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

Use a tagged mask configuration to replace a number of visible Unicode
grapheme clusters from the start or end:

```py
operators = {
    "email address": {
        "type": "mask",
        "masking_character": "*",
        "characters_to_mask": 6,
        "direction": "start",
    }
}
```

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
- `PreparedAnonymizer.create_redaction_session(session_id) -> PreparedRedactionSession`
- `PreparedAnonymizer.create_redaction_session_with_lifecycle(...) -> PreparedRedactionSession`
- `PreparedAnonymizer.restore_redaction_session(plaintext_json) -> PreparedRedactionSession`
- `PreparedRedactionSession.restore_text(full_text, observed_at_epoch_seconds=None) -> str`
- `deanonymise(redacted_text, redaction_map) -> str`
- `PreparedAnonymizer.redact_text(text, operators=None, redact_string=None)`
- `PreparedAnonymizer.redact_text_json(text, operators=None, redact_string=None)`
- `PreparedAnonymizer.diagnostics_json(text, operators=None, redact_string=None)`

`PreparedSearch` is an alias for `PreparedAnonymizer`.
