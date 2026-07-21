#![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

use stella_anonymize_core::{
  CountryMatchData, CountryVariant, DenyListFilterData, DenyListMatchData,
  DenyListPatternMeta, DenyListPatternMetaSet, DetectionSource, Error,
  GazetteerMatchData, PatternSlice, PipelineEntity, RegexMatchMeta,
  SearchMatch, SigningPlaceGuardData, SourceDetail, process_country_matches,
  process_deny_list_matches, process_gazetteer_matches, process_regex_matches,
};

#[test]
fn regex_processor_filters_slice_and_short_matches_by_meta() {
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
    RegexMatchMeta {
      label: String::from("short gated"),
      score: 0.8,
      source_detail: None,
      requires_validation: false,
      validator_id: None,
      validator_input: None,
      min_byte_length: Some(7),
    },
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
    validator_id: None,
    validator_input: None,
    min_byte_length: None,
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
fn regex_processor_applies_native_validator_ids() {
  let matches = vec![
    SearchMatch::Regex {
      pattern: 3,
      start: 4,
      end: 14,
    },
    SearchMatch::Regex {
      pattern: 3,
      start: 19,
      end: 29,
    },
  ];
  let meta = vec![RegexMatchMeta {
    label: String::from("tax identification number"),
    score: 0.9,
    source_detail: None,
    requires_validation: true,
    validator_id: Some(String::from("us.ein")),
    validator_input: None,
    min_byte_length: None,
  }];

  let entities = process_regex_matches(
    &matches,
    PatternSlice { start: 3, end: 4 },
    "EIN 87-2451993 bad 00-2451993",
    &meta,
  )
  .unwrap();

  assert_eq!(entities.len(), 1);
  assert_eq!(entities[0].text, "87-2451993");
}

#[test]
fn regex_processor_applies_validator_input_kind() {
  let matches = vec![SearchMatch::Regex {
    pattern: 0,
    start: 0,
    end: 24,
  }];
  let meta = vec![RegexMatchMeta {
    label: String::from("national identification number"),
    score: 0.95,
    source_detail: None,
    requires_validation: true,
    validator_id: Some(String::from("gb.nhs")),
    validator_input: Some(String::from("digits-only")),
    min_byte_length: None,
  }];

  let entities = process_regex_matches(
    &matches,
    PatternSlice { start: 0, end: 1 },
    "NHS number: 401 023 2137",
    &meta,
  )
  .unwrap();

  assert_eq!(entities.len(), 1);
  assert_eq!(entities[0].text, "NHS number: 401 023 2137");
}

#[test]
fn regex_processor_applies_bounded_nanp_validation() {
  let matches = vec![
    SearchMatch::Regex {
      pattern: 0,
      start: 0,
      end: 14,
    },
    SearchMatch::Regex {
      pattern: 0,
      start: 15,
      end: 27,
    },
    SearchMatch::Regex {
      pattern: 0,
      start: 28,
      end: 40,
    },
    SearchMatch::Regex {
      pattern: 0,
      start: 41,
      end: 51,
    },
  ];
  let meta = vec![RegexMatchMeta {
    label: String::from("phone number"),
    score: 0.9,
    source_detail: None,
    requires_validation: true,
    validator_id: Some(String::from("phone.nanp")),
    validator_input: None,
    min_byte_length: None,
  }];

  let entities = process_regex_matches(
    &matches,
    PatternSlice { start: 0, end: 1 },
    "(212) 555-0142 012-555-0142 212-111-0142 4537891022",
    &meta,
  )
  .unwrap();

  assert_eq!(entities.len(), 1);
  assert_eq!(entities[0].text, "(212) 555-0142");
}

#[test]
fn regex_processor_applies_bounded_international_phone_validation() {
  let meta = vec![RegexMatchMeta {
    label: String::from("phone number"),
    score: 1.0,
    source_detail: None,
    requires_validation: true,
    validator_id: Some(String::from("phone.international")),
    validator_input: None,
    min_byte_length: None,
  }];

  for value in [
    "+44 (20 7946 0958",
    "+44 20) 7946 0958",
    "+2024-01-01",
    "+20240721",
    "+2024-0721",
    "+44-2024-01-01",
    "+420 2024 01 01",
    "+4420240101",
    "+42020240721",
    "+1.234.567",
    "+123-45-67",
    "+12-345-6789",
    "+12.34.56.78",
    "+1234567",
  ] {
    let matches = vec![SearchMatch::Regex {
      pattern: 0,
      start: 0,
      end: value.len().try_into().unwrap(),
    }];
    let entities = process_regex_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      value,
      &meta,
    )
    .unwrap();
    assert!(
      entities.is_empty(),
      "accepted non-phone numeric shape: {value}"
    );
  }

  for value in [
    "+44 (20) 7946 0958",
    "+1 415 555 0132",
    "+420 212 345 678",
    "+49 30 12345678",
  ] {
    let matches = vec![SearchMatch::Regex {
      pattern: 0,
      start: 0,
      end: value.len().try_into().unwrap(),
    }];
    let entities = process_regex_matches(
      &matches,
      PatternSlice { start: 0, end: 1 },
      value,
      &meta,
    )
    .unwrap();
    assert_eq!(entities.len(), 1, "rejected real phone: {value}");
  }
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
    validator_id: None,
    validator_input: None,
    min_byte_length: None,
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
fn deny_list_processor_emits_custom_labels() {
  let matches = vec![SearchMatch::Literal {
    pattern: 3,
    start: 0,
    end: 11,
  }];
  let data = DenyListMatchData {
    labels: vec![vec![String::from("matter")]].into(),
    custom_labels: vec![vec![String::from("matter")]].into(),
    originals: vec![String::from("Secret Code")],
    pattern_meta: DenyListPatternMetaSet::default(),
    sources: vec![vec![String::from("custom-deny-list")]].into(),
    filters: None,
  };

  let entities = process_deny_list_matches(
    &matches,
    PatternSlice { start: 3, end: 4 },
    "Secret Code filed",
    &data,
  )
  .unwrap();

  assert_eq!(entities.len(), 1);
  assert_eq!(entities[0].text, "Secret Code");
  assert_eq!(entities[0].source, DetectionSource::DenyList);
  assert_eq!(
    entities[0].source_detail,
    Some(SourceDetail::CustomDenyList)
  );
}

#[test]
fn deny_list_processor_rejects_embedded_custom_word_matches() {
  let matches = vec![
    SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 6,
    },
    SearchMatch::Literal {
      pattern: 0,
      start: 14,
      end: 20,
    },
  ];
  let data = DenyListMatchData {
    labels: vec![vec![String::from("matter")]].into(),
    custom_labels: vec![vec![String::from("matter")]].into(),
    originals: vec![String::from("Secret")],
    pattern_meta: DenyListPatternMetaSet::default(),
    sources: vec![vec![String::from("custom-deny-list")]].into(),
    filters: None,
  };

  let entities = process_deny_list_matches(
    &matches,
    PatternSlice { start: 0, end: 1 },
    "Secret filed xSecret.",
    &data,
  )
  .unwrap();

  assert_eq!(entities.len(), 1);
  assert_eq!(entities[0].text, "Secret");
}

#[test]
fn deny_list_processor_rejects_embedded_custom_word_with_compact_meta() {
  let matches = vec![
    SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 6,
    },
    SearchMatch::Literal {
      pattern: 0,
      start: 14,
      end: 20,
    },
  ];
  let data = DenyListMatchData {
    labels: vec![vec![String::from("matter")]].into(),
    custom_labels: vec![vec![String::from("matter")]].into(),
    originals: Vec::new(),
    pattern_meta: DenyListPatternMetaSet::from_entries(&[
      DenyListPatternMeta {
        has_alphanumeric: true,
        short_upper_acronym: false,
      },
    ]),
    sources: vec![vec![String::from("custom-deny-list")]].into(),
    filters: None,
  };

  let entities = process_deny_list_matches(
    &matches,
    PatternSlice { start: 0, end: 1 },
    "Secret filed xSecret.",
    &data,
  )
  .unwrap();

  assert_eq!(entities.len(), 1);
  assert_eq!(entities[0].text, "Secret");
}

#[test]
fn deny_list_processor_emits_curated_non_person_labels() {
  let matches = vec![SearchMatch::Literal {
    pattern: 0,
    start: 0,
    end: 6,
  }];
  let data = DenyListMatchData {
    labels: vec![vec![String::from("address")]].into(),
    custom_labels: vec![vec![]].into(),
    originals: vec![String::from("Prague")],
    pattern_meta: DenyListPatternMetaSet::default(),
    sources: vec![vec![String::from("city")]].into(),
    filters: Some(DenyListFilterData::default()),
  };

  let entities = process_deny_list_matches(
    &matches,
    PatternSlice { start: 0, end: 1 },
    "Prague",
    &data,
  )
  .unwrap();

  assert_eq!(entities.len(), 1);
  assert_eq!(entities[0].label, "address");
  assert_eq!(entities[0].source_detail, None);
}

#[test]
fn deny_list_processor_suppresses_shorter_curated_same_start_matches() {
  let matches = vec![
    SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 7,
    },
    SearchMatch::Literal {
      pattern: 1,
      start: 0,
      end: 17,
    },
  ];
  let data = DenyListMatchData {
    labels: vec![vec![String::from("address")], vec![String::from("country")]]
      .into(),
    custom_labels: vec![vec![], vec![]].into(),
    originals: vec![String::from("Česká"), String::from("Česká republika")],
    pattern_meta: DenyListPatternMetaSet::default(),
    sources: vec![vec![String::from("city")], vec![String::from("deny-list")]]
      .into(),
    filters: Some(DenyListFilterData::default()),
  };

  let entities = process_deny_list_matches(
    &matches,
    PatternSlice { start: 0, end: 2 },
    "Česká republika",
    &data,
  )
  .unwrap();

  assert_eq!(entities.len(), 1);
  assert_eq!(entities[0].label, "country");
  assert_eq!(entities[0].text, "Česká republika");
}

#[test]
fn deny_list_processor_suppresses_shorter_contained_curated_matches() {
  let matches = vec![
    SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 17,
    },
    SearchMatch::Literal {
      pattern: 1,
      start: 10,
      end: 17,
    },
  ];
  let data = DenyListMatchData {
    labels: vec![
      vec![String::from("organization")],
      vec![String::from("address")],
    ]
    .into(),
    custom_labels: vec![vec![], vec![]].into(),
    originals: vec![String::from("Nemocnice Blansko"), String::from("Blansko")],
    pattern_meta: DenyListPatternMetaSet::default(),
    sources: vec![vec![String::from("deny-list")], vec![String::from("city")]]
      .into(),
    filters: Some(DenyListFilterData::default()),
  };

  let entities = process_deny_list_matches(
    &matches,
    PatternSlice { start: 0, end: 2 },
    "Nemocnice Blansko",
    &data,
  )
  .unwrap();

  assert_eq!(entities.len(), 1);
  assert_eq!(entities[0].label, "organization");
  assert_eq!(entities[0].text, "Nemocnice Blansko");
}

#[test]
fn deny_list_processor_handles_overlapping_person_name_hits() {
  let text = "John Smith Jr arrived.";
  let matches = vec![
    SearchMatch::Literal {
      pattern: 0,
      start: 0,
      end: 10,
    },
    SearchMatch::Literal {
      pattern: 1,
      start: 5,
      end: 13,
    },
  ];
  let data = DenyListMatchData {
    labels: vec![vec![String::from("person")], vec![String::from("person")]]
      .into(),
    custom_labels: vec![vec![], vec![]].into(),
    originals: vec![String::from("John Smith"), String::from("Smith Jr")],
    pattern_meta: DenyListPatternMetaSet::default(),
    sources: vec![
      vec![String::from("first-name")],
      vec![String::from("surname")],
    ]
    .into(),
    filters: Some(DenyListFilterData::default()),
  };

  let entities = process_deny_list_matches(
    &matches,
    PatternSlice { start: 0, end: 2 },
    text,
    &data,
  )
  .unwrap();

  assert_eq!(entities.len(), 1);
  assert_eq!(entities[0].text, "John Smith Jr");
}

#[test]
fn deny_list_processor_suppresses_signing_place_address() {
  let text = "Podepsano V Brně dne 1. ledna 2026.";
  let start = u32::try_from(text.find("Brně").unwrap()).unwrap();
  let end = start.saturating_add(u32::try_from("Brně".len()).unwrap());
  let matches = vec![SearchMatch::Literal {
    pattern: 0,
    start,
    end,
  }];
  let data = DenyListMatchData {
    labels: vec![vec![String::from("address")]].into(),
    custom_labels: vec![vec![]].into(),
    originals: vec![String::from("Brně")],
    pattern_meta: DenyListPatternMetaSet::default(),
    sources: vec![vec![String::from("city")]].into(),
    filters: Some(DenyListFilterData {
      signing_place_guards: vec![SigningPlaceGuardData {
        prefix_phrases: [String::from("v"), String::from("ve")].into(),
        suffix_phrases: [String::from("dne")].into(),
      }],
      ..DenyListFilterData::default()
    }),
  };

  let entities = process_deny_list_matches(
    &matches,
    PatternSlice { start: 0, end: 1 },
    text,
    &data,
  )
  .unwrap();

  assert!(entities.is_empty());
}

#[test]
fn deny_list_processor_keeps_real_address_city() {
  let text = "Sidlo: Ulice 12, Brně 602 00.";
  let start = u32::try_from(text.find("Brně").unwrap()).unwrap();
  let end = start.saturating_add(u32::try_from("Brně".len()).unwrap());
  let matches = vec![SearchMatch::Literal {
    pattern: 0,
    start,
    end,
  }];
  let data = DenyListMatchData {
    labels: vec![vec![String::from("address")]].into(),
    custom_labels: vec![vec![]].into(),
    originals: vec![String::from("Brně")],
    pattern_meta: DenyListPatternMetaSet::default(),
    sources: vec![vec![String::from("city")]].into(),
    filters: Some(DenyListFilterData {
      address_stopwords: [String::from("brně")].into(),
      signing_place_guards: vec![SigningPlaceGuardData {
        prefix_phrases: [String::from("v"), String::from("ve")].into(),
        suffix_phrases: [String::from("dne")].into(),
      }],
      ..DenyListFilterData::default()
    }),
  };

  let entities = process_deny_list_matches(
    &matches,
    PatternSlice { start: 0, end: 1 },
    text,
    &data,
  )
  .unwrap();

  assert_eq!(entities.len(), 1);
  assert_eq!(entities[0].text, "Brně");
}

#[test]
fn deny_list_processor_keeps_address_when_signing_guards_do_not_pair() {
  let text = "Company is incorporated in Delaware.";
  let start = u32::try_from(text.find("Delaware").unwrap()).unwrap();
  let end = start.saturating_add(u32::try_from("Delaware".len()).unwrap());
  let matches = vec![SearchMatch::Literal {
    pattern: 0,
    start,
    end,
  }];
  let data = DenyListMatchData {
    labels: vec![vec![String::from("address")]].into(),
    custom_labels: vec![vec![]].into(),
    originals: vec![String::from("Delaware")],
    pattern_meta: DenyListPatternMetaSet::default(),
    sources: vec![vec![String::from("city")]].into(),
    filters: Some(DenyListFilterData {
      signing_place_guards: vec![
        SigningPlaceGuardData {
          prefix_phrases: [String::new()].into(),
          suffix_phrases: [String::from("den")].into(),
        },
        SigningPlaceGuardData {
          prefix_phrases: [String::from("signed in")].into(),
          suffix_phrases: [String::new()].into(),
        },
      ],
      ..DenyListFilterData::default()
    }),
  };

  let entities = process_deny_list_matches(
    &matches,
    PatternSlice { start: 0, end: 1 },
    text,
    &data,
  )
  .unwrap();

  assert_eq!(entities.len(), 1);
  assert_eq!(entities[0].text, "Delaware");
}

#[test]
fn deny_list_processor_rejects_curated_sources_without_filters() {
  let matches = vec![SearchMatch::Literal {
    pattern: 0,
    start: 0,
    end: 6,
  }];
  let data = DenyListMatchData {
    labels: vec![vec![String::from("address")]].into(),
    custom_labels: vec![vec![]].into(),
    originals: vec![String::from("Prague")],
    pattern_meta: DenyListPatternMetaSet::default(),
    sources: vec![vec![String::from("city")]].into(),
    filters: None,
  };

  let error = process_deny_list_matches(
    &matches,
    PatternSlice { start: 0, end: 1 },
    "Prague",
    &data,
  )
  .unwrap_err();

  assert_eq!(
    error,
    Error::MissingStaticData {
      field: "deny_list.filters"
    }
  );
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
    iso_codes: vec![String::from("TR")],
    variants: vec![CountryVariant::Name],
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
