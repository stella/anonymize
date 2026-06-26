use stella_anonymize_core::{
  FuzzySearchOptions, LiteralSearchOptions, OperatorConfig, RegexSearchOptions,
  SearchOptions,
};

#[test]
fn search_options_builder_preserves_defaults() {
  let options = SearchOptions::builder()
    .literal(
      LiteralSearchOptions::builder()
        .case_insensitive(true)
        .build(),
    )
    .build();

  assert!(options.literal.case_insensitive);
  assert!(!options.literal.whole_words);
  assert_eq!(options.regex, RegexSearchOptions::default());
  assert_eq!(options.fuzzy, FuzzySearchOptions::default());
}

#[test]
fn fuzzy_options_builder_preserves_whole_word_default() {
  let options = FuzzySearchOptions::builder()
    .normalize_diacritics(true)
    .build();

  assert!(!options.case_insensitive);
  assert!(options.whole_words);
  assert!(options.normalize_diacritics);
}

#[test]
fn operator_config_builder_preserves_redaction_default() {
  let config = OperatorConfig::builder().build();

  assert!(config.operators.is_empty());
  assert_eq!(config.redact_string, "[REDACTED]");
}
