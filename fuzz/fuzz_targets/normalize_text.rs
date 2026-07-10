#![no_main]

//! Boundary safety for search normalization.
//!
//! `normalize_for_search` folds arbitrary UTF-8 for matching. Contract: it
//! must never panic on any input and must always return valid UTF-8 (a
//! `String`, so the type enforces the latter). This stresses the folding and
//! char-boundary handling against adversarial multi-byte and combining input.
//!
//! Idempotence invariant: normalizing already-normalized text must be a
//! fixed point. A normalizer that keeps changing its own output would make
//! offset mapping and cache keys unstable.

use libfuzzer_sys::fuzz_target;
use stella_anonymize_core::normalize_for_search;

fuzz_target!(|data: &[u8]| {
  let Ok(text) = core::str::from_utf8(data) else {
    return;
  };
  let once = normalize_for_search(text);
  let twice = normalize_for_search(&once);
  assert_eq!(once, twice, "normalize_for_search is not idempotent");
});
