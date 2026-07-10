#![allow(clippy::unwrap_used)]

//! Determinism guard for the full static redaction pipeline.
//!
//! Detection runs on parallel scoped threads (see `prepared/search_phase.rs`),
//! and `merge_and_dedup` resolves overlaps in the order entities arrive. The
//! pipeline is only reproducible because the parallel branch results are joined
//! back into fixed slots, so `merge_and_dedup` always sees the same order. This
//! test locks that in: the same input redacted many times must produce a
//! byte-identical result. If a future change collected the parallel matches in
//! thread-completion order instead, this would fail.

mod support;

use stella_anonymize_core::{
  GazetteerMatchData, LiteralSearchOptions, OperatorConfig, PatternSlice,
  PreparedEngine, PreparedEngineSlices, RegexMatchMeta, RegexSearchOptions,
  SearchOptions, SearchPattern,
};
use support::prepared_config;

/// A multi-detector engine: the regex and literal branches both run, so
/// detection actually spawns parallel work.
fn multi_detector_engine() -> PreparedEngine {
  PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\b[A-Z]{2}\d{4}\b",
    ))],
    custom_regex_patterns: vec![],
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Acme"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    regex_options: SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: false,
        ..RegexSearchOptions::default()
      },
      ..SearchOptions::default()
    },
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    allowed_labels: vec![],
    threshold: 0.0,
    confidence_boost: false,
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      gazetteer: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("registration number", 0.9)],
    custom_regex_meta: vec![],
    deny_list_data: None,
    false_positive_filters: None,
    gazetteer_data: Some(GazetteerMatchData {
      labels: vec![String::from("organization")],
      is_fuzzy: vec![false],
    }),
    country_data: None,
    hotword_data: None,
    trigger_data: None,
    legal_form_data: None,
    address_seed_data: None,
    zone_data: None,
    address_context_data: None,
    coreference_data: None,
    name_corpus_data: None,
    signature_data: None,
    date_data: None,
    monetary_data: None,
  })
  .unwrap()
}

#[test]
fn static_redaction_is_deterministic_across_repeated_runs() {
  const INPUT: &str = "Acme s.r.o. filed AB1234. Acme paid CD5678.";
  let prepared = multi_detector_engine();

  let baseline = prepared
    .redact_static_entities(INPUT, &OperatorConfig::default())
    .unwrap();
  // Sanity check the fixture actually detects something, or the test is vacuous.
  assert!(
    !baseline.redaction.redaction_map.is_empty(),
    "fixture detected no entities; determinism check would be vacuous",
  );

  // Re-run enough times that thread-scheduling variance would surface a
  // completion-order dependency.
  for run in 1..=64 {
    let again = prepared
      .redact_static_entities(INPUT, &OperatorConfig::default())
      .unwrap();
    assert_eq!(
      again, baseline,
      "run {run} produced a different result than the first run",
    );
  }
}
