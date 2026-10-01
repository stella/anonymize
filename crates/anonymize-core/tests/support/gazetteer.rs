//! Shared real-engine harness for integration properties and fuzzing.

use stella_anonymize_adapter_contract::{
  assemble_static_search_config, prepared_search_config_from_binding,
};
use stella_anonymize_core::PreparedEngine;
use stella_anonymize_core::assemble::{
  GazetteerEntry, GazetteerSource, PipelineConfig,
};

pub(crate) fn engine(
  entries: &[String],
  language: &str,
) -> Result<PreparedEngine, String> {
  let config = PipelineConfig {
    threshold: 0.0,
    enable_trigger_phrases: false,
    enable_regex: false,
    languages: Some(vec![language.to_owned()]),
    language: None,
    enable_legal_forms: Some(false),
    enable_name_corpus: false,
    name_corpus_languages: None,
    enable_deny_list: false,
    deny_list_countries: None,
    deny_list_regions: None,
    deny_list_exclude_categories: None,
    custom_deny_list: None,
    custom_regexes: None,
    enable_gazetteer: true,
    enable_countries: Some(false),
    enable_confidence_boost: false,
    enable_coreference: false,
    enable_zone_classification: Some(false),
    enable_hotword_rules: Some(false),
    standalone_street_detection: Default::default(),
    labels: vec![],
    workspace_id: "property-test".to_owned(),
    dictionaries: None,
  };
  let entries = entries
    .iter()
    .enumerate()
    .map(|(index, canonical)| GazetteerEntry {
      id: format!("entry-{index}"),
      canonical: canonical.clone(),
      label: "organization".to_owned(),
      variants: vec![],
      workspace_id: config.workspace_id.clone(),
      created_at: 0,
      source: GazetteerSource::Manual,
    })
    .collect::<Vec<_>>();
  let binding = assemble_static_search_config(&config, None, &entries)
    .map_err(|error| error.to_string())?;
  let config = prepared_search_config_from_binding(binding)
    .map_err(|error| error.to_string())?;
  PreparedEngine::new(config).map_err(|error| error.to_string())
}
