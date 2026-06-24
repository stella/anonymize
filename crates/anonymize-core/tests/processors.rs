#![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

use stella_anonymize_core::{
  CountryMatchData, DetectionSource, GazetteerMatchData, PatternSlice,
  PipelineEntity, RegexMatchMeta, SearchMatch, SourceDetail,
  process_country_matches, process_gazetteer_matches, process_regex_matches,
};

#[test]
fn regex_processor_filters_slice_and_short_phone_matches() {
  let matches = vec![
    SearchMatch::Regex {
      pattern: 0,
      start: 0,
      end: 5,
    },
    SearchMatch::Regex {
      pattern: 1,
      start: 13,
      end: 18,
    },
    SearchMatch::Regex {
      pattern: 2,
      start: 20,
      end: 32,
    },
  ];
  let meta = vec![
    RegexMatchMeta::new("person", 0.8),
    RegexMatchMeta::new("phone number", 0.8),
  ];

  let entities = process_regex_matches(
    &matches,
    PatternSlice { start: 0, end: 2 },
    "Alice called 12345 then 123456789012",
    &meta,
  )
  .unwrap();

  assert_eq!(
    entities,
    vec![PipelineEntity::detected(
      0,
      5,
      "person",
      "Alice",
      0.8,
      DetectionSource::Regex
    )]
  );
}

#[test]
fn regex_processor_rejects_unported_validators() {
  let matches = vec![SearchMatch::Regex {
    pattern: 7,
    start: 0,
    end: 5,
  }];
  let meta = vec![RegexMatchMeta {
    label: String::from("tax identification number"),
    score: 0.9,
    source_detail: None,
    requires_validation: true,
  }];

  let err = process_regex_matches(
    &matches,
    PatternSlice { start: 7, end: 8 },
    "12345",
    &meta,
  )
  .unwrap_err();

  assert_eq!(
    err.to_string(),
    "Regex pattern 7 requires validation that is not available in core"
  );
}

#[test]
fn regex_processor_preserves_custom_regex_source_detail() {
  let matches = vec![SearchMatch::Regex {
    pattern: 0,
    start: 0,
    end: 5,
  }];
  let meta = vec![RegexMatchMeta {
    label: String::from("matter id"),
    score: 0.7,
    source_detail: Some(SourceDetail::CustomRegex),
    requires_validation: false,
  }];

  let entities = process_regex_matches(
    &matches,
    PatternSlice { start: 0, end: 1 },
    "A-123",
    &meta,
  )
  .unwrap();

  assert_eq!(entities[0].source_detail, Some(SourceDetail::CustomRegex));
}

#[test]
fn gazetteer_processor_extends_exact_matches_and_drops_overlapping_fuzzy() {
  let matches = vec![
    SearchMatch::Literal {
      pattern: 10,
      start: 0,
      end: 4,
    },
    SearchMatch::Fuzzy {
      pattern: 11,
      start: 0,
      end: 4,
      distance: 1,
    },
  ];
  let data = GazetteerMatchData {
    labels: vec![String::from("organization"), String::from("organization")],
    is_fuzzy: vec![false, true],
  };

  let entities = process_gazetteer_matches(
    &matches,
    PatternSlice { start: 10, end: 12 },
    "Acme s.r.o. signed",
    &data,
  )
  .unwrap();

  assert_eq!(entities.len(), 1);
  assert_eq!(entities[0].text, "Acme s.r.o.");
  assert_eq!(
    entities[0].source_detail,
    Some(SourceDetail::GazetteerExtension)
  );
}

#[test]
fn gazetteer_processor_emits_non_overlapping_fuzzy_matches() {
  let matches = vec![SearchMatch::Fuzzy {
    pattern: 2,
    start: 10,
    end: 15,
    distance: 1,
  }];
  let data = GazetteerMatchData {
    labels: vec![String::from("organization")],
    is_fuzzy: vec![true],
  };

  let entities = process_gazetteer_matches(
    &matches,
    PatternSlice { start: 2, end: 3 },
    "Signed by Akmee today",
    &data,
  )
  .unwrap();

  assert_eq!(entities[0].text, "Akmee");
  assert_eq!(entities[0].score.to_bits(), 0.85_f64.to_bits());
}

#[test]
fn country_processor_requires_uppercase_letter_start() {
  let matches = vec![
    SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 6,
    },
    SearchMatch::Literal {
      pattern: 0,
      start: 11,
      end: 17,
    },
  ];
  let data = CountryMatchData {
    labels: vec![String::from("country")],
  };

  let entities = process_country_matches(
    &matches,
    PatternSlice { start: 0, end: 1 },
    "turkey and Turkey",
    &data,
  )
  .unwrap();

  assert_eq!(entities.len(), 1);
  assert_eq!(entities[0].text, "Turkey");
  assert_eq!(entities[0].source, DetectionSource::Country);
}
