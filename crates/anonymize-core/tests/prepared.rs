#![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

use stella_anonymize_core::{
  CountryMatchData, DenyListMatchData, DetectionSource, Error,
  FuzzySearchOptions, GazetteerMatchData, LiteralSearchOptions, OperatorConfig,
  PatternSlice, PreparedSearch, PreparedSearchConfig, PreparedSearchSlices,
  RegexMatchMeta, RegexSearchOptions, SearchOptions, SearchPattern,
  SourceDetail,
};

fn empty_config(slices: PreparedSearchSlices) -> PreparedSearchConfig {
  PreparedSearchConfig {
    regex_patterns: vec![],
    custom_regex_patterns: vec![],
    literal_patterns: vec![],
    regex_options: SearchOptions::default(),
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions::default(),
    slices,
    regex_meta: vec![],
    custom_regex_meta: vec![],
    deny_list_data: None,
    gazetteer_data: None,
    country_data: None,
  }
}

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
    deny_list_data: None,
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
    deny_list_data: None,
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

#[test]
fn prepared_search_redacts_static_entities_end_to_end() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\b[A-Z]{2}\d{4}\b",
    ))],
    custom_regex_patterns: vec![],
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
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedSearchSlices {
      regex: PatternSlice { start: 0, end: 1 },
      gazetteer: PatternSlice { start: 0, end: 1 },
      countries: PatternSlice { start: 1, end: 2 },
      ..PreparedSearchSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("registration number", 0.9)],
    custom_regex_meta: vec![],
    deny_list_data: None,
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
    .redact_static_entities(
      "Acme s.r.o. filed AB1234 in Turkey.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert_eq!(
    result.redaction.redacted_text,
    "[ORGANIZATION_1] filed [REGISTRATION_NUMBER_1] in [COUNTRY_1]."
  );
  assert_eq!(result.redaction.entity_count, 3);
  assert_eq!(result.resolved_entities.len(), 3);
}

#[test]
fn prepared_search_redacts_custom_deny_list_entities() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![],
    custom_regex_patterns: vec![],
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Secret Code"),
      case_insensitive: Some(true),
      whole_words: Some(true),
    }],
    regex_options: SearchOptions::default(),
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedSearchSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    regex_meta: vec![],
    custom_regex_meta: vec![],
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("matter")]],
      custom_labels: vec![vec![String::from("matter")]],
      originals: vec![String::from("Secret Code")],
      sources: vec![vec![String::from("custom-deny-list")]],
    }),
    gazetteer_data: None,
    country_data: None,
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Secret Code was disclosed.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert_eq!(result.detections.deny_list_entities.len(), 1);
  assert_eq!(result.redaction.redacted_text, "[MATTER_1] was disclosed.");
  assert_eq!(result.redaction.entity_count, 1);
}

#[test]
fn prepared_search_rejects_unsupported_static_slices() {
  let unsupported = PatternSlice { start: 0, end: 1 };
  let cases = [
    (
      "legal_forms",
      PreparedSearchSlices {
        legal_forms: unsupported,
        ..PreparedSearchSlices::default()
      },
    ),
    (
      "triggers",
      PreparedSearchSlices {
        triggers: unsupported,
        ..PreparedSearchSlices::default()
      },
    ),
    (
      "deny_list",
      PreparedSearchSlices {
        deny_list: unsupported,
        ..PreparedSearchSlices::default()
      },
    ),
    (
      "street_types",
      PreparedSearchSlices {
        street_types: unsupported,
        ..PreparedSearchSlices::default()
      },
    ),
  ];

  for (slice, slices) in cases {
    let error = PreparedSearch::new(empty_config(slices))
      .err()
      .expect("unsupported slice should be rejected");

    assert_eq!(error, Error::UnsupportedStaticSlice { slice });
  }
}

#[test]
fn prepared_search_rejects_curated_deny_list_sources() {
  let error = PreparedSearch::new(PreparedSearchConfig {
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]],
      custom_labels: vec![vec![]],
      originals: vec![String::from("Prague")],
      sources: vec![vec![String::from("city")]],
    }),
    ..empty_config(PreparedSearchSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    })
  })
  .err()
  .expect("curated deny-list source should be rejected");

  assert_eq!(
    error,
    Error::UnsupportedDenyListSource {
      source: String::from("city")
    }
  );
}

#[test]
fn prepared_search_rejects_truncated_deny_list_data() {
  let error = PreparedSearch::new(PreparedSearchConfig {
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("matter")]],
      custom_labels: vec![],
      originals: vec![String::from("Secret Code")],
      sources: vec![vec![String::from("custom-deny-list")]],
    }),
    ..empty_config(PreparedSearchSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    })
  })
  .err()
  .expect("truncated deny-list data should be rejected");

  assert_eq!(
    error,
    Error::StaticDataLengthMismatch {
      field: "deny_list.custom_labels",
      expected: 1,
      actual: 0
    }
  );
}
