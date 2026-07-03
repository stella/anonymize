//! Stage-1 native-config assembler.
//!
//! Ports `buildNativeStaticSearchBundle` /
//! `buildNativeStaticConfig` from
//! `packages/anonymize/src/build-unified-search.ts` into Rust. This is slice A
//! (foundation): it fills only the trivial, data-independent fields of
//! [`BindingPreparedSearchConfig`] and leaves every heavier field at its
//! `Default`. Later slices tick fields off [`FIELDS_PENDING`].
//!
//! The assembler lives in this crate rather than `stella-anonymize-core`
//! because the output type [`BindingPreparedSearchConfig`] is defined here, and
//! the core crate cannot depend on this crate without a cycle. The input
//! structs and embedded data tree it operates on live in
//! `stella_anonymize_core::assemble`.

use std::collections::HashSet;

use stella_anonymize_core::assemble::{
  AssembleError, CustomRegexPattern, Dictionaries, GazetteerEntry,
  PipelineConfig, PreparedArtifactPolicy,
};

use crate::{
  BindingNameCorpusMode, BindingPreparedArtifactPolicy,
  BindingPreparedSearchConfig, BindingRegexArtifactPolicy,
  BindingSearchOptions, BindingSearchPattern,
};

/// Fields of [`BindingPreparedSearchConfig`] this slice fills from the inputs.
///
/// `name_corpus_mode` is computed here from `enable_deny_list`, but the
/// TypeScript source only *emits* it when name-corpus data is present. Because
/// that data is not yet assembled, the parity harness does not compare
/// `name_corpus_mode`; it moves to fully verified once the name-corpus slice
/// lands.
pub const FIELDS_IMPLEMENTED: &[&str] = &[
  "allowed_labels",
  "threshold",
  "confidence_boost",
  "custom_regex_patterns",
  "regex_options",
  "custom_regex_options",
  "name_corpus_mode",
];

/// Fields still left at their `Default` value, to be filled by later slices.
pub const FIELDS_PENDING: &[&str] = &[
  "regex_patterns",
  "literal_patterns",
  "literal_options",
  "literal_patterns_from_deny_list_data",
  "slices",
  "regex_meta",
  "custom_regex_meta",
  "deny_list_data",
  "false_positive_filters",
  "gazetteer_data",
  "country_data",
  "hotword_data",
  "trigger_data",
  "legal_form_data",
  "address_seed_data",
  "zone_data",
  "address_context_data",
  "coreference_data",
  "name_corpus_data",
  "signature_data",
  "date_data",
  "monetary_data",
];

/// Assembles a prepared static-search config from a pipeline config,
/// dictionaries, and gazetteer entries.
///
/// Slice A fills the trivial fields listed in [`FIELDS_IMPLEMENTED`]; the
/// dictionaries and gazetteer inputs are accepted for signature stability but
/// only consumed by later slices.
///
/// # Errors
///
/// Currently infallible, but returns [`AssembleError`] so later slices can
/// surface data-parse failures without changing the signature.
#[allow(clippy::unnecessary_wraps)] // later slices parse embedded data fallibly.
pub fn assemble_static_search_config(
  config: &PipelineConfig,
  _dictionaries: Option<&Dictionaries>,
  _gazetteer: &[GazetteerEntry],
) -> Result<BindingPreparedSearchConfig, AssembleError> {
  Ok(BindingPreparedSearchConfig {
    custom_regex_patterns: assemble_custom_regex_patterns(config),
    allowed_labels: config.labels.clone(),
    threshold: config.threshold,
    confidence_boost: config.enable_confidence_boost,
    regex_options: Some(regex_options_template()),
    custom_regex_options: Some(custom_regex_options_template()),
    name_corpus_mode: name_corpus_mode(config),
    ..BindingPreparedSearchConfig::default()
  })
}

const fn name_corpus_mode(config: &PipelineConfig) -> BindingNameCorpusMode {
  if config.enable_deny_list {
    BindingNameCorpusMode::Supplemental
  } else {
    BindingNameCorpusMode::Full
  }
}

fn regex_options_template() -> BindingSearchOptions {
  BindingSearchOptions {
    literal_case_insensitive: Some(true),
    literal_whole_words: Some(false),
    regex_whole_words: Some(false),
    regex_artifact_policy: Some(BindingRegexArtifactPolicy::Omit),
    ..BindingSearchOptions::default()
  }
}

fn custom_regex_options_template() -> BindingSearchOptions {
  BindingSearchOptions {
    regex_whole_words: Some(false),
    regex_overlap_all: Some(true),
    regex_artifact_policy: Some(BindingRegexArtifactPolicy::Omit),
    ..BindingSearchOptions::default()
  }
}

fn assemble_custom_regex_patterns(
  config: &PipelineConfig,
) -> Vec<BindingSearchPattern> {
  if !config.enable_regex {
    return Vec::new();
  }
  let Some(customs) = config.custom_regexes.as_ref() else {
    return Vec::new();
  };
  let allowed = allowed_label_set(&config.labels);
  customs
    .iter()
    .filter(|entry| label_allowed(entry.label.as_str(), allowed.as_ref()))
    .map(custom_regex_pattern)
    .collect()
}

/// Mirrors `createAllowedLabelSet`: an empty label list means "no filter".
///
/// NOTE: the TypeScript source expands the label set for hotword rules before
/// filtering custom regexes. Slice A filters against `config.labels` directly;
/// results diverge only when `enable_hotword_rules` is set *and* a custom regex
/// label is reachable only via that expansion. Later slices close this gap.
fn allowed_label_set(labels: &[String]) -> Option<HashSet<&str>> {
  if labels.is_empty() {
    return None;
  }
  Some(labels.iter().map(String::as_str).collect())
}

fn label_allowed(label: &str, allowed: Option<&HashSet<&str>>) -> bool {
  allowed.is_none_or(|set| set.contains(label))
}

fn custom_regex_pattern(entry: &CustomRegexPattern) -> BindingSearchPattern {
  BindingSearchPattern {
    kind: "regex".to_string(),
    pattern: entry.pattern.clone(),
    distance: None,
    case_insensitive: None,
    whole_words: None,
    lazy: None,
    prefilter_any: None,
    prefilter_case_insensitive: None,
    prefilter_regex: None,
    prefilter_window_bytes: None,
    prepared_artifact_policy: entry
      .prepared_artifact_policy
      .map(map_prepared_artifact_policy),
  }
}

const fn map_prepared_artifact_policy(
  policy: PreparedArtifactPolicy,
) -> BindingPreparedArtifactPolicy {
  match policy {
    PreparedArtifactPolicy::Include => BindingPreparedArtifactPolicy::Include,
    PreparedArtifactPolicy::Omit => BindingPreparedArtifactPolicy::Omit,
  }
}
