use stella_anonymize_core::{
  DiagnosticEventKind, DiagnosticStage, FuzzySearchOptions,
  LiteralSearchOptions, OperatorConfig, PatternSlice, PreparedEngine,
  PreparedEngineConfig, PreparedEngineSlices, PreparedSearch, RegexMatchMeta,
  RegexSearchOptions, Result as CoreResult, SearchOptions, SearchPattern,
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

#[test]
fn prepared_engine_builder_accepts_optional_artifacts() -> CoreResult<()> {
  let config = prepared_engine_config();
  let artifacts = PreparedEngine::prepare_artifacts(config.clone())?;
  let artifact_view = artifacts.as_view();
  let direct = PreparedEngine::prepare().config(config.clone()).call()?;
  let prepared = PreparedEngine::prepare()
    .config(config)
    .artifacts(&artifact_view)
    .call()?;

  assert_eq!(
    prepared.find_matches("Matter AB1234")?,
    direct.find_matches("Matter AB1234")?
  );
  Ok(())
}

#[test]
fn prepared_engine_diagnostics_builder_reports_prepare_stages() -> CoreResult<()>
{
  let result = PreparedEngine::prepare_with_diagnostics()
    .config(prepared_engine_config())
    .call()?;

  assert!(result.diagnostics.events.iter().any(|event| {
    event.stage == DiagnosticStage::PrepareTotal
      && event.kind == DiagnosticEventKind::StageSummary
  }));
  Ok(())
}

#[test]
fn prepared_search_alias_keeps_existing_constructor_surface() -> CoreResult<()>
{
  let prepared: PreparedSearch = PreparedSearch::new(prepared_engine_config())?;

  assert_eq!(prepared.find_matches("Matter AB1234")?.regex.len(), 1);
  Ok(())
}

fn prepared_engine_config() -> PreparedEngineConfig {
  PreparedEngineConfig {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\b[A-Z]{2}\d{4}\b",
    ))],
    regex_options: SearchOptions::default(),
    regex_meta: vec![RegexMatchMeta::new("matter", 0.9)],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    custom_regex_patterns: vec![],
    literal_patterns: vec![],
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions::default(),
    allowed_labels: vec![],
    threshold: 0.0,
    confidence_boost: false,
    custom_regex_meta: vec![],
    deny_list_data: None,
    false_positive_filters: None,
    gazetteer_data: None,
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
  }
}
