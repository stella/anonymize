#![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

use stella_anonymize_core::{
  Error, FuzzySearchOptions, LiteralSearchOptions, RegexSearchOptions,
  SearchIndex, SearchIndexArtifacts, SearchMatch, SearchOptions, SearchPattern,
};

#[test]
fn search_index_routes_literal_regex_and_fuzzy_patterns() {
  let index = SearchIndex::new(
    vec![
      SearchPattern::Literal(String::from("Alice")),
      SearchPattern::Regex(String::from(r"\b[A-Z]{2}\d{4}\b")),
      SearchPattern::Fuzzy {
        pattern: String::from("Muller"),
        distance: Some(1),
      },
    ],
    SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: false,
        whole_words: true,
      },
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: false,
      },
      fuzzy: FuzzySearchOptions {
        case_insensitive: true,
        whole_words: true,
        normalize_diacritics: false,
      },
    },
  )
  .unwrap();

  let matches = index
    .find_iter("Alice signed AB1234. Later, Muler countersigned.")
    .unwrap();

  assert_eq!(
    matches,
    vec![
      SearchMatch::Literal {
        pattern: 0,
        start: 0,
        end: 5,
      },
      SearchMatch::Regex {
        pattern: 1,
        start: 13,
        end: 19,
      },
      SearchMatch::Fuzzy {
        pattern: 2,
        start: 28,
        end: 33,
        distance: 1,
      },
    ]
  );
}

#[test]
fn search_index_preserves_byte_offsets_from_primitive_engines() {
  const SUPPLEMENTARY_SCALAR: &str = "\u{1F9EA}";

  let index = SearchIndex::new(
    vec![
      SearchPattern::Literal(String::from("Bob")),
      SearchPattern::Regex(String::from(SUPPLEMENTARY_SCALAR)),
    ],
    SearchOptions::default(),
  )
  .unwrap();

  let haystack = format!("A {SUPPLEMENTARY_SCALAR} Bob");
  let matches = index.find_iter(&haystack).unwrap();

  assert_eq!(
    matches,
    vec![
      SearchMatch::Regex {
        pattern: 1,
        start: 2,
        end: 6,
      },
      SearchMatch::Literal {
        pattern: 0,
        start: 7,
        end: 10,
      },
    ]
  );
}

#[test]
fn search_index_preserves_case_insensitive_literal_byte_offsets() {
  let index = SearchIndex::new(
    vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("krajským soudem"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    SearchOptions::default(),
  )
  .unwrap();

  let haystack = "zapsaná v obchodním rejstříku vedeném Krajským soudem";
  let start = haystack.find("Krajským").unwrap();
  let end = haystack.len();

  assert_eq!(
    index.find_iter(haystack).unwrap(),
    vec![SearchMatch::Literal {
      pattern: 0,
      start: u32::try_from(start).unwrap(),
      end: u32::try_from(end).unwrap(),
    }]
  );
}

#[test]
fn search_index_preserves_large_case_insensitive_literal_byte_offsets() {
  let mut patterns = Vec::new();
  for index in 0..300 {
    let pattern = if index == 216 {
      String::from("krajským soudem")
    } else {
      format!("needle-{index}")
    };
    patterns.push(SearchPattern::LiteralWithOptions {
      pattern,
      case_insensitive: Some(true),
      whole_words: Some(false),
    });
  }
  let index = SearchIndex::new(patterns, SearchOptions::default()).unwrap();

  let haystack = "zapsaná v obchodním rejstříku vedeném Krajským soudem v Ústí";
  let start = haystack.find("Krajským").unwrap();
  let end = start.saturating_add("Krajským soudem".len());

  assert_eq!(
    index.find_iter(haystack).unwrap(),
    vec![SearchMatch::Literal {
      pattern: 216,
      start: u32::try_from(start).unwrap(),
      end: u32::try_from(end).unwrap(),
    }]
  );
}

#[test]
fn search_index_returns_overlapping_literal_matches() {
  let index = SearchIndex::new(
    vec![
      SearchPattern::Literal(String::from("Alice")),
      SearchPattern::Literal(String::from("Alice Smith")),
    ],
    SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: false,
        whole_words: true,
      },
      ..SearchOptions::default()
    },
  )
  .unwrap();

  let matches = index.find_iter("Alice Smith signed.").unwrap();

  assert_eq!(
    matches,
    vec![
      SearchMatch::Literal {
        pattern: 0,
        start: 0,
        end: 5,
      },
      SearchMatch::Literal {
        pattern: 1,
        start: 0,
        end: 11,
      },
    ]
  );
}

#[test]
fn search_index_can_return_overlapping_regex_matches() {
  let index = SearchIndex::new(
    vec![
      SearchPattern::Regex(String::from("Alice")),
      SearchPattern::Regex(String::from("Alice Smith")),
    ],
    SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: true,
      },
      ..SearchOptions::default()
    },
  )
  .unwrap();

  let matches = index.find_iter("Alice Smith signed.").unwrap();

  assert_eq!(
    matches,
    vec![
      SearchMatch::Regex {
        pattern: 0,
        start: 0,
        end: 5,
      },
      SearchMatch::Regex {
        pattern: 1,
        start: 0,
        end: 11,
      },
    ]
  );
}

#[test]
fn search_index_supports_per_pattern_literal_word_boundaries() {
  let index = SearchIndex::new(
    vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("he"),
        case_insensitive: None,
        whole_words: Some(true),
      },
      SearchPattern::LiteralWithOptions {
        pattern: String::from("s.r.o."),
        case_insensitive: None,
        whole_words: Some(false),
      },
    ],
    SearchOptions::default(),
  )
  .unwrap();

  let matches = index.find_iter("shell Acme s.r.o. he").unwrap();

  assert_eq!(
    matches,
    vec![
      SearchMatch::Literal {
        pattern: 1,
        start: 11,
        end: 17,
      },
      SearchMatch::Literal {
        pattern: 0,
        start: 18,
        end: 20,
      },
    ]
  );
}

#[test]
fn search_index_supports_per_pattern_literal_case_sensitivity() {
  let index = SearchIndex::new(
    vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("alice"),
        case_insensitive: Some(true),
        whole_words: None,
      },
      SearchPattern::LiteralWithOptions {
        pattern: String::from("bob"),
        case_insensitive: Some(false),
        whole_words: None,
      },
    ],
    SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: false,
        whole_words: true,
      },
      ..SearchOptions::default()
    },
  )
  .unwrap();

  let matches = index.find_iter("Alice Bob bob").unwrap();

  assert_eq!(
    matches,
    vec![
      SearchMatch::Literal {
        pattern: 0,
        start: 0,
        end: 5,
      },
      SearchMatch::Literal {
        pattern: 1,
        start: 10,
        end: 13,
      },
    ]
  );
}

#[test]
fn search_index_reports_match_presence_across_engines() {
  let index = SearchIndex::new(
    vec![
      SearchPattern::Literal(String::from("Alice")),
      SearchPattern::Regex(String::from(r"\d{4}")),
    ],
    SearchOptions::default(),
  )
  .unwrap();

  assert!(index.is_match("Case 2026").unwrap());
  assert!(!index.is_match("No hit").unwrap());
}

#[test]
fn search_index_prepared_artifacts_match_direct_index() {
  let patterns = vec![
    SearchPattern::Literal(String::from("Alice")),
    SearchPattern::Regex(String::from(r"\b[A-Z]{2}\d{4}\b")),
    SearchPattern::Fuzzy {
      pattern: String::from("Muller"),
      distance: Some(1),
    },
  ];
  let options = SearchOptions {
    literal: LiteralSearchOptions {
      case_insensitive: false,
      whole_words: true,
    },
    regex: RegexSearchOptions {
      whole_words: false,
      overlap_all: false,
    },
    fuzzy: FuzzySearchOptions {
      case_insensitive: true,
      whole_words: true,
      normalize_diacritics: false,
    },
  };
  let artifacts =
    SearchIndex::prepare_artifacts(patterns.clone(), options).unwrap();
  assert!(
    !artifacts.slots.is_empty(),
    "prepared search index should record text-search slot artifacts"
  );
  let direct = SearchIndex::new(patterns.clone(), options).unwrap();
  let prepared =
    SearchIndex::new_with_artifacts(patterns, options, &artifacts).unwrap();
  let haystack = "Alice signed AB1234. Later, Muler countersigned.";

  assert_eq!(
    prepared.find_iter(haystack).unwrap(),
    direct.find_iter(haystack).unwrap()
  );
  assert_eq!(prepared.is_match(haystack), direct.is_match(haystack));
}

#[test]
fn search_index_prepared_artifacts_roundtrip_bytes() {
  let patterns = vec![
    SearchPattern::Literal(String::from("Alice")),
    SearchPattern::Literal(String::from("Bob")),
  ];
  let options = SearchOptions {
    literal: LiteralSearchOptions {
      case_insensitive: true,
      whole_words: true,
    },
    ..SearchOptions::default()
  };
  let artifacts =
    SearchIndex::prepare_artifacts(patterns.clone(), options).unwrap();
  let bytes = artifacts.to_bytes().unwrap();
  let decoded = SearchIndexArtifacts::from_bytes(&bytes).unwrap();

  assert_eq!(decoded, artifacts);

  let direct = SearchIndex::new(patterns.clone(), options).unwrap();
  let prepared =
    SearchIndex::new_with_artifacts(patterns, options, &decoded).unwrap();
  assert_eq!(
    prepared.find_iter("Alice and Bob").unwrap(),
    direct.find_iter("Alice and Bob").unwrap()
  );
}

#[test]
fn search_index_prepared_artifacts_reject_invalid_bytes() {
  let error = SearchIndexArtifacts::from_bytes(b"not-valid").unwrap_err();

  assert!(
    matches!(error, Error::InvalidStaticData { .. }),
    "invalid artifact bytes should fail at the format boundary"
  );
}

#[test]
fn search_index_prepared_artifacts_reject_wrong_slot_count() {
  let patterns = vec![SearchPattern::Literal(String::from("Alice"))];
  let options = SearchOptions::default();
  let mut artifacts =
    SearchIndex::prepare_artifacts(patterns.clone(), options).unwrap();
  artifacts.slots.clear();

  assert!(
    SearchIndex::new_with_artifacts(patterns, options, &artifacts).is_err(),
    "missing prepared slot artifacts should fail"
  );
}
