#![no_main]

//! Decoder robustness for the search-index artifact format.
//!
//! Contract: `SearchIndexArtifacts::from_bytes` must reject *any* byte slice
//! with a typed `Err` rather than panicking, indexing out of bounds, or
//! slicing across a codepoint. Decoding also runs the external
//! `text_search` slot decoder, so this defends the whole artifact-load path,
//! not just the header framing.
//!
//! Extra invariant on the happy path: whatever decodes must round-trip. If
//! `from_bytes` accepts the input, re-encoding and decoding again must yield
//! an equal value (encode/decode symmetry).

use libfuzzer_sys::fuzz_target;
use stella_anonymize_core::SearchIndexArtifacts;

fuzz_target!(|data: &[u8]| {
  let Ok(decoded) = SearchIndexArtifacts::from_bytes(data) else {
    // Malformed input rejected with a typed error: the expected outcome.
    return;
  };

  // Accepted input must survive an encode/decode round-trip unchanged.
  let reencoded = decoded
    .to_bytes()
    .expect("a value decoded from bytes must re-encode");
  let roundtripped = SearchIndexArtifacts::from_bytes(&reencoded)
    .expect("re-encoded artifact bytes must decode again");
  assert_eq!(
    decoded, roundtripped,
    "encode/decode round-trip changed the decoded artifact"
  );
});
