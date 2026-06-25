#![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

use std::collections::{BTreeMap, BTreeSet};

use stella_anonymize_core::{
  AddressSeedData, AmountWordsData, CountryMatchData, CurrencyData, DateData,
  DenyListFilterData, DenyListMatchData, DetectionSource, DiagnosticEventKind,
  DiagnosticStage, Error, FuzzySearchOptions, GazetteerMatchData,
  LegalFormData, LiteralSearchOptions, MagnitudeSuffixData, MonetaryData,
  OperatorConfig, PatternSlice, PreparedSearch, PreparedSearchArtifacts,
  PreparedSearchConfig, PreparedSearchSlices, RegexMatchMeta,
  RegexSearchOptions, SearchOptions, SearchPattern, SourceDetail, TriggerData,
  TriggerRule, TriggerStrategy, TriggerValidation, WrittenAmountPatternData,
};

fn empty_config(slices: PreparedSearchSlices) -> PreparedSearchConfig {
  PreparedSearchConfig {
    regex_patterns: vec![],
    custom_regex_patterns: vec![],
    literal_patterns: vec![],
    regex_options: SearchOptions::default(),
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions::default(),
    allowed_labels: vec![],
    threshold: 0.0,
    slices,
    regex_meta: vec![],
    custom_regex_meta: vec![],
    deny_list_data: None,
    gazetteer_data: None,
    country_data: None,
    trigger_data: None,
    legal_form_data: None,
    address_seed_data: None,
    date_data: None,
    monetary_data: None,
  }
}

fn legal_form_prepared_search(suffixes: Vec<&str>) -> PreparedSearch {
  let suffix_strings = suffixes
    .iter()
    .map(|suffix| (*suffix).to_owned())
    .collect::<Vec<_>>();
  let regex_patterns = suffixes
    .into_iter()
    .map(|suffix| SearchPattern::Literal(suffix.to_owned()))
    .collect::<Vec<_>>();

  PreparedSearch::new(PreparedSearchConfig {
    regex_patterns,
    regex_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: false,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedSearchSlices {
      legal_forms: PatternSlice {
        start: 0,
        end: u32::try_from(suffix_strings.len()).unwrap(),
      },
      ..PreparedSearchSlices::default()
    },
    legal_form_data: Some(LegalFormData {
      suffixes: suffix_strings,
      normalized_boundary_suffixes: vec![
        String::from("as"),
        String::from("co"),
        String::from("inc"),
        String::from("llc"),
        String::from("sro"),
      ],
      normalized_in_name_words: vec![String::from("co")],
      normalized_suffix_words: vec![
        String::from("as"),
        String::from("co"),
        String::from("inc"),
        String::from("llc"),
        String::from("sro"),
      ],
      connector_words: vec![
        String::from("&"),
        String::from("a"),
        String::from("and"),
      ],
      and_connector_words: vec![String::from("and")],
      in_name_prepositions: vec![String::from("of")],
      company_suffix_words: vec![String::from("Company")],
      sentence_verb_indicators: vec![
        String::from("include"),
        String::from("is"),
        String::from("podepsaly"),
      ],
      ..LegalFormData::default()
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap()
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
    allowed_labels: vec![],
    threshold: 0.0,
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
    trigger_data: None,
    legal_form_data: None,
    address_seed_data: None,
    date_data: None,
    monetary_data: None,
  })
  .unwrap();

  let result = prepared
    .detect_static_entities("Acme\u{00a0}Corp. signed")
    .unwrap();

  assert_eq!(result.gazetteer_entities.len(), 1);
  assert_eq!(result.gazetteer_entities[0].text, "Acme\u{00a0}Corp");
}

#[test]
fn prepared_search_artifacts_match_direct_prepare() {
  let config = PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\bID\d{3}\b"))],
    custom_regex_patterns: vec![],
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Acme Corp"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    regex_options: SearchOptions::default(),
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions::default(),
    allowed_labels: vec![],
    threshold: 0.0,
    slices: PreparedSearchSlices {
      regex: PatternSlice { start: 0, end: 1 },
      gazetteer: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("identifier", 1.0)],
    custom_regex_meta: vec![],
    deny_list_data: None,
    gazetteer_data: Some(GazetteerMatchData {
      labels: vec![String::from("organization")],
      is_fuzzy: vec![false],
    }),
    country_data: None,
    trigger_data: None,
    legal_form_data: None,
    address_seed_data: None,
    date_data: None,
    monetary_data: None,
  };
  let artifacts = PreparedSearch::prepare_artifacts(config.clone()).unwrap();
  assert!(
    !artifacts.literals.slots.is_empty(),
    "literal index should produce prepared artifacts"
  );

  let direct = PreparedSearch::new(config.clone()).unwrap();
  let prepared =
    PreparedSearch::new_with_artifacts(config.clone(), &artifacts).unwrap();
  let text = "Acme\u{00a0}Corp. signed ID123";

  assert_eq!(
    prepared.find_matches(text).unwrap(),
    direct.find_matches(text).unwrap()
  );

  let mut missing = artifacts;
  missing.literals.slots.clear();
  assert!(
    PreparedSearch::new_with_artifacts(config, &missing).is_err(),
    "missing literal artifacts should fail"
  );
}

#[test]
fn prepared_search_artifacts_roundtrip_bytes() {
  let config = PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\bID\d{3}\b"))],
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Acme Corp"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedSearchSlices {
      regex: PatternSlice { start: 0, end: 1 },
      gazetteer: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("identifier", 1.0)],
    gazetteer_data: Some(GazetteerMatchData {
      labels: vec![String::from("organization")],
      is_fuzzy: vec![false],
    }),
    ..empty_config(PreparedSearchSlices::default())
  };
  let artifacts = PreparedSearch::prepare_artifacts(config.clone()).unwrap();
  let bytes = artifacts.to_bytes().unwrap();
  let decoded = PreparedSearchArtifacts::from_bytes(&bytes).unwrap();

  assert_eq!(decoded, artifacts);

  let direct = PreparedSearch::new(config.clone()).unwrap();
  let prepared = PreparedSearch::new_with_artifacts(config, &decoded).unwrap();
  assert_eq!(
    prepared.find_matches("Acme Corp signed ID123").unwrap(),
    direct.find_matches("Acme Corp signed ID123").unwrap()
  );
}

#[test]
fn prepared_search_artifacts_reject_invalid_bytes() {
  let error = PreparedSearchArtifacts::from_bytes(b"not-valid").unwrap_err();

  assert!(
    matches!(error, Error::InvalidStaticData { .. }),
    "invalid prepared-search artifacts should fail at the format boundary"
  );
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
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: false,
      },
      ..SearchOptions::default()
    },
    custom_regex_options: SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: false,
      },
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
    allowed_labels: vec![],
    threshold: 0.0,
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
      validator_id: None,
      validator_input: None,
      min_byte_length: None,
    }],
    deny_list_data: None,
    gazetteer_data: Some(GazetteerMatchData {
      labels: vec![String::from("organization")],
      is_fuzzy: vec![false],
    }),
    country_data: Some(CountryMatchData {
      labels: vec![String::from("country")],
    }),
    trigger_data: None,
    legal_form_data: None,
    address_seed_data: None,
    date_data: None,
    monetary_data: None,
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
fn prepared_search_preserves_overlapping_custom_regex_matches() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    custom_regex_patterns: vec![
      SearchPattern::Regex(String::from("Alice")),
      SearchPattern::Regex(String::from("Alice Smith")),
    ],
    custom_regex_options: SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: true,
      },
      ..SearchOptions::default()
    },
    slices: PreparedSearchSlices {
      custom_regex: PatternSlice { start: 0, end: 2 },
      ..PreparedSearchSlices::default()
    },
    custom_regex_meta: vec![
      RegexMatchMeta {
        label: String::from("person"),
        score: 1.0,
        source_detail: Some(SourceDetail::CustomRegex),
        requires_validation: false,
        validator_id: None,
        validator_input: None,
        min_byte_length: None,
      },
      RegexMatchMeta {
        label: String::from("person"),
        score: 1.0,
        source_detail: Some(SourceDetail::CustomRegex),
        requires_validation: false,
        validator_id: None,
        validator_input: None,
        min_byte_length: None,
      },
    ],
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .detect_static_entities("Alice Smith signed.")
    .unwrap();
  let custom_texts = result
    .custom_regex_entities
    .iter()
    .map(|entity| entity.text.as_str())
    .collect::<Vec<_>>();

  assert_eq!(custom_texts, ["Alice", "Alice Smith"]);
}

#[test]
fn prepared_search_drops_person_spans_ending_in_trailing_noun() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\bCOBRA Reimbursement Period\b",
    ))],
    regex_options: SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedSearchSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("person", 0.9)],
    deny_list_data: Some(DenyListMatchData {
      labels: Vec::new().into(),
      custom_labels: Vec::new().into(),
      originals: Vec::new(),
      sources: Vec::new().into(),
      filters: Some(DenyListFilterData {
        person_trailing_nouns: BTreeSet::from([String::from("period")]),
        ..DenyListFilterData::default()
      }),
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Payments continue during the COBRA Reimbursement Period.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(result.resolved_entities.is_empty());
}

#[test]
fn prepared_search_extracts_dates_from_anchored_data() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    date_data: Some(DateData {
      month_names_by_language: BTreeMap::from([
        (
          String::from("en"),
          vec![
            String::from("January"),
            String::from("March"),
            String::from("December"),
          ],
        ),
        (
          String::from("cs"),
          vec![String::from("ledna"), String::from("únor")],
        ),
      ]),
      year_words_by_language: BTreeMap::from([(
        String::from("cs"),
        vec![String::from("roce")],
      )]),
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .detect_static_entities(
      "Signed 7 January 2025, renewed March 9, 2026, effective 2026. únor 3., filed 1.ledna 2026 and signed 1. ledna 2026. Ends December 31, \n\n2025. Výpis v roce 2026.",
    )
    .unwrap();
  let entities = result
    .anchored_entities
    .iter()
    .map(|entity| (entity.text.as_str(), entity.label.as_str(), entity.source))
    .collect::<Vec<_>>();

  assert_eq!(
    entities,
    [
      ("7 January 2025", "date", DetectionSource::Regex),
      ("March 9, 2026", "date", DetectionSource::Regex),
      ("2026. únor 3.", "date", DetectionSource::Regex),
      ("ledna 2026", "date", DetectionSource::Regex),
      ("1. ledna 2026", "date", DetectionSource::Regex),
      ("December 31, \n\n2025", "date", DetectionSource::Regex),
      ("2026", "date", DetectionSource::Trigger),
    ],
  );
}

#[test]
fn prepared_search_extracts_written_date_of_birth_trigger() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("geboren am"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedSearchSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("geboren am"),
        label: String::from("date of birth"),
        strategy: TriggerStrategy::NWords { count: 3 },
        validations: Vec::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Herr Müller, geboren am 21. März 1968, ist Geschäftsführer.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "date of birth"
        && entity.text == "21. März 1968")
  );
}

#[test]
fn prepared_search_extends_single_word_written_date_trigger() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("geboren am"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedSearchSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("geboren am"),
        label: String::from("date of birth"),
        strategy: TriggerStrategy::NWords { count: 1 },
        validations: Vec::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Herr Müller, geboren am 21. März 1968, ist Geschäftsführer.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "date of birth"
        && entity.text == "21. März 1968")
  );
}

#[test]
fn prepared_search_extracts_year_after_duplicate_year_word_noise() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: ["rok", "an", "roce"]
      .into_iter()
      .map(|pattern| SearchPattern::LiteralWithOptions {
        pattern: String::from(pattern),
        case_insensitive: Some(true),
        whole_words: Some(false),
      })
      .collect(),
    regex_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedSearchSlices {
      triggers: PatternSlice { start: 0, end: 3 },
      ..PreparedSearchSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: ["rok", "an", "roce"]
        .into_iter()
        .map(|trigger| TriggerRule {
          trigger: String::from(trigger),
          label: String::from("date"),
          strategy: TriggerStrategy::NWords { count: 1 },
          validations: vec![TriggerValidation::MatchesPattern {
            pattern: String::from(r"^(?:19|20)\d{2}\.?$"),
            flags: None,
          }],
          include_trigger: false,
        })
        .collect(),
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let text = "účetní uzávěrku za roky 2019, 2020, 2021, 2022, 2023 a 2024, výpis z valné hromady konané v\u{00a0}roce 2026 a to nejpozději";
  let result = prepared.detect_static_entities(text).unwrap();

  assert!(
    result
      .trigger_entities
      .iter()
      .any(|entity| entity.label == "date" && entity.text == "2026")
  );
}

#[test]
fn prepared_search_trigger_caps_by_characters_not_bytes() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("ve výši"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedSearchSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("ve výši"),
        label: String::from("monetary amount"),
        strategy: TriggerStrategy::ToNextComma {
          stop_words: Vec::new(),
          max_length: None,
        },
        validations: Vec::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let expected = "0,2 % z Ceny Plnění dle příslušné Dílčí smlouvy za každý i započatý kalendářní den prodlení";
  let result = prepared
    .detect_static_entities(&format!("Smluvní pokuta ve výši {expected}."))
    .unwrap();

  assert!(
    result.trigger_entities.iter().any(|entity| entity.label
      == "monetary amount"
      && entity.text == expected)
  );
}

#[test]
fn prepared_search_trigger_validations_count_characters_not_bytes() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("jméno"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedSearchSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("jméno"),
        label: String::from("person"),
        strategy: TriggerStrategy::NWords { count: 1 },
        validations: vec![
          TriggerValidation::MinLength(5),
          TriggerValidation::MaxLength(5),
        ],
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .detect_static_entities("Smluvní jméno Áběčď bylo ověřeno.")
    .unwrap();

  assert!(
    result
      .trigger_entities
      .iter()
      .any(|entity| entity.label == "person" && entity.text == "Áběčď")
  );
}

#[test]
fn prepared_search_rejects_lowercase_acronym_trigger_collisions() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("dni"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedSearchSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("DNI"),
        label: String::from("national identification number"),
        strategy: TriggerStrategy::CompanyIdValue,
        validations: Vec::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let lower = prepared
    .detect_static_entities("Cena je stanovena ke dni 6.11.2025.")
    .unwrap();
  assert!(lower.trigger_entities.is_empty());

  let upper = prepared
    .detect_static_entities("Documento DNI 12345678Z.")
    .unwrap();
  assert!(
    upper
      .trigger_entities
      .iter()
      .any(|entity| entity.text == "12345678Z"
        && entity.label == "national identification number")
  );
}

#[test]
fn prepared_search_trims_party_position_before_triggered_address() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("sídlo"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedSearchSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("sídlo"),
        label: String::from("address"),
        strategy: TriggerStrategy::Address {
          max_chars: Some(120),
        },
        validations: Vec::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: vec![String::from("prodávajícího")],
      legal_form_suffixes: Vec::new(),
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .detect_static_entities(
      "Místem předání je sídlo prodávajícího Na Květnici 1657/16, 140 00 Praha 4.",
    )
    .unwrap();

  assert!(
    result
      .trigger_entities
      .iter()
      .any(|entity| entity.label == "address"
        && entity.text == "Na Květnici 1657/16, 140 00 Praha 4")
  );
}

#[test]
fn prepared_search_extracts_money_from_anchored_data() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    monetary_data: Some(MonetaryData {
      currencies: CurrencyData {
        codes: vec![String::from("USD"), String::from("EUR")],
        symbols: vec![String::from("$")],
        local_names: vec![String::from("Kč"), String::from("korun českých")],
      },
      amount_words: AmountWordsData {
        written_amount_patterns: vec![],
        magnitude_suffixes: vec![MagnitudeSuffixData {
          words: vec![String::from("million")],
          abbreviations_case_insensitive: vec![],
          abbreviations_case_sensitive: vec![],
        }],
        share_quantity_terms: vec![],
      },
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .detect_static_entities(
      "Fees are USD 1,250,000.00, $450,000, 25 million EUR and 275 000 Kč.",
    )
    .unwrap();
  let entities = result
    .anchored_entities
    .iter()
    .map(|entity| entity.text.as_str())
    .collect::<Vec<_>>();

  assert_eq!(
    entities,
    [
      "USD 1,250,000.00",
      "$450,000",
      "25 million EUR",
      "275 000 Kč",
    ],
  );
}

#[test]
fn prepared_search_extends_money_to_written_amount_parenthetical() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    monetary_data: Some(MonetaryData {
      currencies: CurrencyData {
        codes: vec![],
        symbols: vec![],
        local_names: vec![String::from("Kč")],
      },
      amount_words: AmountWordsData {
        written_amount_patterns: vec![WrittenAmountPatternData {
          keywords: vec![String::from("slovy")],
        }],
        magnitude_suffixes: vec![],
        share_quantity_terms: vec![],
      },
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .detect_static_entities(
      "Smluvní pokuta je 50.000,- Kč (slovy: padesát tisíc korun českých).",
    )
    .unwrap();
  let entities = result
    .anchored_entities
    .iter()
    .map(|entity| entity.text.as_str())
    .collect::<Vec<_>>();

  assert_eq!(
    entities,
    ["50.000,- Kč (slovy: padesát tisíc korun českých)"],
  );
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
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: false,
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
    trigger_data: None,
    legal_form_data: None,
    address_seed_data: None,
    date_data: None,
    monetary_data: None,
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
fn prepared_search_applies_threshold_before_merge() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![
      SearchPattern::Regex(String::from("Acme")),
      SearchPattern::Regex(String::from(r"Acme s\.r\.o\.")),
    ],
    regex_options: SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: true,
      },
      ..SearchOptions::default()
    },
    threshold: 0.5,
    slices: PreparedSearchSlices {
      regex: PatternSlice { start: 0, end: 2 },
      ..PreparedSearchSlices::default()
    },
    regex_meta: vec![
      RegexMatchMeta::new("organization", 0.9),
      RegexMatchMeta::new("organization", 0.4),
    ],
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities("Acme s.r.o. signed.", &OperatorConfig::default())
    .unwrap();

  assert_eq!(
    result.redaction.redacted_text,
    "[ORGANIZATION_1] s.r.o. signed."
  );
  assert_eq!(result.resolved_entities.len(), 1);
  assert_eq!(result.resolved_entities[0].text, "Acme");
}

#[test]
fn prepared_search_applies_allowed_labels_before_redaction() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::Regex(String::from("Alice"))],
    allowed_labels: vec![String::from("date")],
    slices: PreparedSearchSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("person", 1.0)],
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities("Alice signed.", &OperatorConfig::default())
    .unwrap();

  assert_eq!(result.redaction.redacted_text, "Alice signed.");
  assert!(result.resolved_entities.is_empty());
}

#[test]
fn prepared_search_keeps_person_name_particles_after_trigger() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Pan"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedSearchSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("Pan"),
        label: String::from("person"),
        strategy: TriggerStrategy::ToEndOfLine,
        validations: vec![TriggerValidation::StartsUppercase],
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let with_apostrophe = prepared
    .detect_static_entities("Pan Jean d'Arc přijel pozdě.")
    .unwrap();
  assert!(
    with_apostrophe
      .trigger_entities
      .iter()
      .any(|entity| entity.text == "Jean d'Arc")
  );

  let with_particle = prepared
    .detect_static_entities("Pan João dos Santos přijel pozdě.")
    .unwrap();
  assert!(
    with_particle
      .trigger_entities
      .iter()
      .any(|entity| entity.text == "João dos Santos")
  );

  let trailing_particle = prepared
    .detect_static_entities("Pan Novák von tady odešel.")
    .unwrap();
  assert!(
    trailing_particle
      .trigger_entities
      .iter()
      .any(|entity| entity.text == "Novák")
  );
  assert!(
    trailing_particle
      .trigger_entities
      .iter()
      .all(|entity| !entity.text.contains("von"))
  );
}

#[test]
fn prepared_search_reports_static_redaction_diagnostics() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
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
    slices: PreparedSearchSlices {
      regex: PatternSlice { start: 0, end: 1 },
      gazetteer: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("registration number", 0.9)],
    custom_regex_meta: vec![],
    deny_list_data: None,
    gazetteer_data: Some(GazetteerMatchData {
      labels: vec![String::from("organization")],
      is_fuzzy: vec![false],
    }),
    country_data: None,
    trigger_data: None,
    legal_form_data: None,
    address_seed_data: None,
    date_data: None,
    monetary_data: None,
  })
  .unwrap();

  let result = prepared
    .redact_static_entities_with_diagnostics(
      "Acme s.r.o. filed AB1234.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert_eq!(
    result.result.redaction.redacted_text,
    "[ORGANIZATION_1] filed [REGISTRATION_NUMBER_1]."
  );
  assert!(result.diagnostics.events.iter().any(|event| {
    event.stage == DiagnosticStage::SearchRegex
      && event.kind == DiagnosticEventKind::StageSummary
      && event.count == Some(1)
  }));
  assert!(result.diagnostics.events.iter().any(|event| {
    event.stage == DiagnosticStage::Sanitize
      && event.kind == DiagnosticEventKind::Entity
      && event.label.as_deref() == Some("organization")
      && event.span_valid == Some(true)
  }));
  assert!(
    result
      .diagnostics
      .events
      .iter()
      .all(|event| event.text.is_none())
  );
  assert!(result.diagnostics.events.iter().any(|event| {
    event.stage == DiagnosticStage::Redaction
      && event.kind == DiagnosticEventKind::StageSummary
      && event.count == Some(2)
  }));
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
    allowed_labels: vec![],
    threshold: 0.0,
    slices: PreparedSearchSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    regex_meta: vec![],
    custom_regex_meta: vec![],
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("matter")]].into(),
      custom_labels: vec![vec![String::from("matter")]].into(),
      originals: vec![String::from("Secret Code")],
      sources: vec![vec![String::from("custom-deny-list")]].into(),
      filters: None,
    }),
    gazetteer_data: None,
    country_data: None,
    trigger_data: None,
    legal_form_data: None,
    address_seed_data: None,
    date_data: None,
    monetary_data: None,
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
  let error = PreparedSearch::new(PreparedSearchConfig {
    literal_patterns: vec![SearchPattern::Literal(String::from("Secret"))],
    ..empty_config(PreparedSearchSlices {
      deny_list: unsupported,
      ..PreparedSearchSlices::default()
    })
  })
  .err()
  .expect("unsupported slice should be rejected");

  assert_eq!(error, Error::UnsupportedStaticSlice { slice: "deny_list" });
}

#[test]
fn prepared_search_requires_gazetteer_metadata_for_gazetteer_slice() {
  let error = PreparedSearch::new(PreparedSearchConfig {
    literal_patterns: vec![SearchPattern::Literal(String::from("Acme"))],
    ..empty_config(PreparedSearchSlices {
      gazetteer: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    })
  })
  .err()
  .expect("gazetteer slice should require metadata");

  assert_eq!(
    error,
    Error::MissingStaticData {
      field: "gazetteer_data"
    }
  );
}

#[test]
fn prepared_search_rejects_truncated_country_metadata() {
  let error = PreparedSearch::new(PreparedSearchConfig {
    literal_patterns: vec![SearchPattern::Literal(String::from("Turkey"))],
    country_data: Some(CountryMatchData { labels: Vec::new() }),
    ..empty_config(PreparedSearchSlices {
      countries: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    })
  })
  .err()
  .expect("truncated country metadata should be rejected");

  assert_eq!(
    error,
    Error::StaticDataLengthMismatch {
      field: "country_data.labels",
      expected: 1,
      actual: 0
    }
  );
}

#[test]
fn prepared_search_rejects_missing_regex_metadata() {
  let error = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\bID\d+\b"))],
    slices: PreparedSearchSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    ..empty_config(PreparedSearchSlices::default())
  })
  .err()
  .expect("regex slice should require parallel metadata");

  assert_eq!(
    error,
    Error::StaticDataLengthMismatch {
      field: "regex_meta",
      expected: 1,
      actual: 0
    }
  );
}

#[test]
fn prepared_search_rejects_literal_slices_outside_patterns() {
  let error = PreparedSearch::new(empty_config(PreparedSearchSlices {
    gazetteer: PatternSlice { start: 0, end: 1 },
    ..PreparedSearchSlices::default()
  }))
  .err()
  .expect("slice outside the literal pattern table should be rejected");

  assert!(
    matches!(
      error,
      Error::InvalidStaticData {
        field: "slices.gazetteer",
        ..
      }
    ),
    "unexpected error: {error}"
  );
}

#[test]
fn prepared_search_requires_address_seed_data_for_street_types() {
  let error = PreparedSearch::new(PreparedSearchConfig {
    literal_patterns: vec![SearchPattern::Literal(String::from("Street"))],
    ..empty_config(PreparedSearchSlices {
      street_types: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    })
  })
  .err()
  .expect("street types should require address seed data");

  assert_eq!(
    error,
    Error::MissingStaticData {
      field: "address_seed_data"
    }
  );
}

#[test]
fn prepared_search_expands_address_seeds_from_street_type_slice() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    literal_patterns: vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Boston"),
        case_insensitive: Some(true),
        whole_words: Some(true),
      },
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Street"),
        case_insensitive: Some(true),
        whole_words: Some(true),
      },
    ],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedSearchSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      street_types: PatternSlice { start: 1, end: 2 },
      ..PreparedSearchSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Boston")],
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Send notices to 100 Main Street, Boston, MA 02101-1234.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "address"
        && entity.text == "100 Main Street, Boston, MA 02101-1234")
  );
}

#[test]
fn prepared_search_expands_address_seeds_from_city_and_postal_code() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Brno"),
      case_insensitive: Some(true),
      whole_words: Some(true),
    }],
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
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Brno")],
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Sídlo společnosti je Kamínky 302/16, Brno 634 00.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "address"
        && entity.text == "Kamínky 302/16, Brno 634 00")
  );
}

#[test]
fn prepared_search_expands_compound_german_street_addresses() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Wiesbaden"),
      case_insensitive: Some(true),
      whole_words: Some(true),
    }],
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
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Düsseldorf")],
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "wohnhaft Schadowstraße 11, 40212 Düsseldorf.",
      &OperatorConfig::default(),
    )
    .unwrap();
  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "address"
        && entity.text == "Schadowstraße 11, 40212 Düsseldorf")
  );
}

#[test]
fn prepared_search_expands_plain_postal_city_addresses() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("geboren am"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Düsseldorf"),
      case_insensitive: Some(true),
      whole_words: Some(true),
    }],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedSearchSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("geboren am"),
        label: String::from("date of birth"),
        strategy: TriggerStrategy::NWords { count: 3 },
        validations: Vec::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
    }),
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Wiesbaden")],
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "(2) Frau Karoline M. Brentano,\n    geboren am 09. Juli 1982,\n    wohnhaft Bismarckring 18, 65183 Wiesbaden,\n    Steuer-ID: 78 123 456 789",
      &OperatorConfig::default(),
    )
    .unwrap();
  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "address"
        && entity.text == "Bismarckring 18, 65183 Wiesbaden")
  );
}

#[test]
fn prepared_search_stops_address_before_notice_copy_instruction() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    literal_patterns: vec![
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Wilmington"),
        case_insensitive: Some(true),
        whole_words: Some(true),
      },
      SearchPattern::LiteralWithOptions {
        pattern: String::from("Street"),
        case_insensitive: Some(true),
        whole_words: Some(true),
      },
    ],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedSearchSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      street_types: PatternSlice { start: 1, end: 2 },
      ..PreparedSearchSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Wilmington")],
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData {
      boundary_words: vec![String::from("with a copy")],
      br_cep_cue_words: Vec::new(),
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "1209 Orange Street, Wilmington, DE 19801; with a copy to general counsel.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "address"
        && entity.text == "1209 Orange Street, Wilmington, DE 19801")
  );
  assert!(
    result
      .resolved_entities
      .iter()
      .all(|entity| !entity.text.contains("with a copy"))
  );
}

#[test]
fn prepared_search_splits_address_seed_clusters_at_paragraph_breaks() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Brno"),
      case_insensitive: Some(true),
      whole_words: Some(true),
    }],
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
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Brno")],
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Kamínky 5, Brno 634 00\n\nIČ: 48511229\n\nKamínky 302/16, Brno 634 00.",
      &OperatorConfig::default(),
    )
    .unwrap();

  assert!(
    result
      .resolved_entities
      .iter()
      .any(|entity| entity.label == "address"
        && entity.text == "Kamínky 302/16, Brno 634 00")
  );
}

#[test]
fn prepared_search_stops_address_seed_expansion_at_legal_prose() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Liberec"),
      case_insensitive: Some(true),
      whole_words: Some(true),
    }],
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
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Liberec")],
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData {
      boundary_words: vec![String::from("pokud")],
      br_cep_cue_words: Vec::new(),
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Fakturu zašlete na Náspu 5, 460 01 Liberec, pokud nebude dohodnuto jinak. Přílohou bude seznam.",
      &OperatorConfig::default(),
    )
    .unwrap();

  let addresses = result
    .resolved_entities
    .iter()
    .filter(|entity| entity.label == "address")
    .map(|entity| entity.text.as_str())
    .collect::<Vec<_>>();
  assert!(addresses.contains(&"Náspu 5, 460 01 Liberec"));
  assert!(!addresses.iter().any(|text| text.contains("pokud")));
  assert!(!addresses.iter().any(|text| text.contains("Přílohou")));
}

#[test]
fn prepared_search_does_not_cluster_address_seed_inside_register_span() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"Handelsregister des Amtsgerichts Düsseldorf unter HRB \d+",
    ))],
    regex_meta: vec![RegexMatchMeta::new("registration number", 0.9)],
    regex_options: SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: false,
      },
      ..SearchOptions::default()
    },
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Düsseldorf"),
      case_insensitive: Some(true),
      whole_words: Some(true),
    }],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedSearchSlices {
      regex: PatternSlice { start: 0, end: 1 },
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Düsseldorf")],
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    address_seed_data: Some(AddressSeedData {
      boundary_words: vec![String::from("eingetragen")],
      br_cep_cue_words: Vec::new(),
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let result = prepared
    .redact_static_entities(
      "Sitz: Königsallee 27, 40212 Düsseldorf,\n    eingetragen im Handelsregister des Amtsgerichts Düsseldorf unter HRB 78219.",
      &OperatorConfig::default(),
    )
    .unwrap();

  let addresses = result
    .resolved_entities
    .iter()
    .filter(|entity| entity.label == "address")
    .map(|entity| entity.text.as_str())
    .collect::<Vec<_>>();
  assert!(addresses.contains(&"Königsallee 27, 40212 Düsseldorf"));
  assert!(!addresses.iter().any(|text| text.contains("Sitz:")));
  assert!(
    !addresses
      .iter()
      .any(|text| text.contains("Handelsregister"))
  );
}

#[test]
fn prepared_search_redacts_curated_deny_list_entities() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Prague"),
      case_insensitive: Some(true),
      whole_words: Some(true),
    }],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Prague")],
      sources: vec![vec![String::from("city")]].into(),
      filters: Some(DenyListFilterData::default()),
    }),
    ..empty_config(PreparedSearchSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    })
  })
  .unwrap();

  let result = prepared
    .redact_static_entities("Prague filed.", &OperatorConfig::default())
    .unwrap();

  assert_eq!(result.redaction.redacted_text, "[ADDRESS_1] filed.");
}

#[test]
fn prepared_search_rejects_curated_deny_list_without_filters() {
  let error = PreparedSearch::new(PreparedSearchConfig {
    literal_patterns: vec![SearchPattern::Literal(String::from("Prague"))],
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("address")]].into(),
      custom_labels: vec![vec![]].into(),
      originals: vec![String::from("Prague")],
      sources: vec![vec![String::from("city")]].into(),
      filters: None,
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
    Error::MissingStaticData {
      field: "deny_list.filters"
    }
  );
}

#[test]
fn prepared_search_rejects_truncated_deny_list_data() {
  let error = PreparedSearch::new(PreparedSearchConfig {
    literal_patterns: vec![SearchPattern::Literal(String::from("Secret Code"))],
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("matter")]].into(),
      custom_labels: vec![].into(),
      originals: vec![String::from("Secret Code")],
      sources: vec![vec![String::from("custom-deny-list")]].into(),
      filters: None,
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

#[test]
fn prepared_search_detects_non_english_legal_form_entities() {
  let prepared = legal_form_prepared_search(vec!["a.s.", "a. s."]);

  let result = prepared
    .detect_static_entities("Smlouvu podepsaly Pražské služby, a.s. dnes.")
    .unwrap();

  assert_eq!(result.legal_form_entities.len(), 1);
  assert_eq!(result.legal_form_entities[0].text, "Pražské služby, a.s.");
  assert_eq!(
    result.legal_form_entities[0].source,
    DetectionSource::LegalForm
  );
}

#[test]
fn prepared_search_keeps_indented_line_wrapped_legal_form_suffix() {
  let prepared = legal_form_prepared_search(vec!["Co.", "LLC"]);

  let result = prepared
    .detect_static_entities(
      "The underwriter is Goldman Sachs & Co.\n  LLC, joint book-runner.",
    )
    .unwrap();

  assert_eq!(result.legal_form_entities.len(), 1);
  assert_eq!(
    result.legal_form_entities[0].text,
    "Goldman Sachs & Co.\n  LLC"
  );
}

#[test]
fn prepared_search_splits_embedded_legal_form_lists() {
  let prepared = legal_form_prepared_search(vec!["LLC", "Inc."]);

  let result = prepared
    .detect_static_entities(
      "The parties include Acme LLC, Beta Inc. and others.",
    )
    .unwrap();
  let texts = result
    .legal_form_entities
    .iter()
    .map(|entity| entity.text.as_str())
    .collect::<Vec<_>>();

  assert_eq!(texts, vec!["Acme LLC", "Beta Inc."]);
}

#[test]
fn prepared_search_rejects_dotted_citation_legal_form_substrings() {
  let prepared = legal_form_prepared_search(vec!["S.C."]);

  let result = prepared
    .detect_static_entities("See 18 U.S.C. Section 1833(b) for civil immunity.")
    .unwrap();

  assert!(result.legal_form_entities.is_empty());
}
