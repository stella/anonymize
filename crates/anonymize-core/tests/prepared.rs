#![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

use stella_anonymize_core::{
  CountryMatchData, DetectionSource, FuzzySearchOptions, GazetteerMatchData,
  LiteralSearchOptions, PatternSlice, PreparedSearch, PreparedSearchConfig,
  PreparedSearchSlices, RegexMatchMeta, RegexSearchOptions, SearchOptions,
  SearchPattern, SourceDetail,
};

#[test]
fn prepared_search_runs_normalized_literal_pass() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![],
    custom_regex_patterns: vec![],
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Acme Corp"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    regex_options: SearchOptions::default(),
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions::default(),
    slices: PreparedSearchSlices {
      gazetteer: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    regex_meta: vec![],
    custom_regex_meta: vec![],
    gazetteer_data: Some(GazetteerMatchData {
      labels: vec![String::from("organization")],
      is_fuzzy: vec![false],
    }),
    country_data: None,
  })
  .unwrap();

  let result = prepared
    .detect_static_entities("Acme\u{00a0}Corp. signed")
    .unwrap();

  assert_eq!(result.gazetteer_entities.len(), 1);
  assert_eq!(result.gazetteer_entities[0].text, "Acme\u{00a0}Corp");
}

#[test]
fn prepared_search_emits_static_detector_entities() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\b[A-Z]{2}\d{4}\b",
    ))],
    custom_regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\bMAT-\d{3}\b",
    ))],
    literal_patterns: vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Acme"),
        case_insensitive: Some(true),
        whole_words: Some(false),
      },
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Turkey"),
        case_insensitive: Some(true),
        whole_words: Some(true),
      },
    ],
    regex_options: SearchOptions {
      regex: RegexSearchOptions { whole_words: false },
      ..SearchOptions::default()
    },
    custom_regex_options: SearchOptions {
      regex: RegexSearchOptions { whole_words: false },
      ..SearchOptions::default()
    },
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      fuzzy: FuzzySearchOptions::default(),
      ..SearchOptions::default()
    },
    slices: PreparedSearchSlices {
      regex: PatternSlice { start: 0, end: 1 },
      custom_regex: PatternSlice { start: 0, end: 1 },
      gazetteer: PatternSlice { start: 0, end: 1 },
      countries: PatternSlice { start: 1, end: 2 },
      ..PreparedSearchSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("registration number", 0.9)],
    custom_regex_meta: vec![RegexMatchMeta {
      label: String::from("matter id"),
      score: 1.0,
      source_detail: Some(SourceDetail::CustomRegex),
      requires_validation: false,
    }],
    gazetteer_data: Some(GazetteerMatchData {
      labels: vec![String::from("organization")],
      is_fuzzy: vec![false],
    }),
    country_data: Some(CountryMatchData {
      labels: vec![String::from("country")],
    }),
  })
  .unwrap();

  let result = prepared
    .detect_static_entities("Acme s.r.o. filed AB1234 in Turkey under MAT-123")
    .unwrap();

  assert_eq!(result.regex_entities[0].label, "registration number");
  assert_eq!(result.custom_regex_entities[0].label, "matter id");
  assert_eq!(
    result.custom_regex_entities[0].source_detail,
    Some(SourceDetail::CustomRegex)
  );
  assert_eq!(result.gazetteer_entities[0].text, "Acme s.r.o.");
  assert_eq!(result.country_entities[0].source, DetectionSource::Country);
}
