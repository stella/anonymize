//! Stage-1 native-config assembler.
//!
//! Ports `buildNativeStaticSearchBundle` /
//! `buildNativeStaticConfig` from
//! `packages/anonymize/src/build-unified-search.ts` into Rust. Slice A laid the
//! foundation (trivial, data-independent fields); slice B ports the
//! copy-through and templating data fields (signature, monetary, date, zone,
//! address-context, address-seed, country, hotword). Each field ported here
//! moves from [`FIELDS_PENDING`] to [`FIELDS_IMPLEMENTED`] and is compared by
//! the golden parity harness.
//!
//! The assembler lives in this crate rather than `stella-anonymize-core`
//! because the output type [`BindingPreparedSearchConfig`] is defined here, and
//! the core crate cannot depend on this crate without a cycle. The input
//! structs and embedded data tree it operates on live in
//! `stella_anonymize_core::assemble`.

mod address;
mod coreference;
mod country;
mod dates;
mod gazetteer;
mod hotwords;
mod language;
mod legal_forms;
mod monetary;
mod regex;
mod signature;
mod zones;

use stella_anonymize_core::assemble::{
  AssembleError, CustomRegexPattern, Dictionaries, GazetteerEntry,
  PipelineConfig, PreparedArtifactPolicy,
};

use crate::{
  BindingNameCorpusMode, BindingPreparedArtifactPolicy,
  BindingPreparedSearchConfig, BindingRegexArtifactPolicy,
  BindingRegexMatchMeta, BindingSearchOptions, BindingSearchPattern,
};

/// `DEFAULT_CUSTOM_REGEX_SCORE`: the score a caller-supplied regex without an
/// explicit score gets in `customRegexMeta`.
const DEFAULT_CUSTOM_REGEX_SCORE: f64 = 0.9;

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
  "signature_data",
  "monetary_data",
  "date_data",
  "zone_data",
  "address_context_data",
  "address_seed_data",
  "country_data",
  "hotword_data",
  "custom_regex_meta",
  "regex_meta",
  "legal_form_data",
  "gazetteer_data",
  "coreference_data",
];

/// Fields still left at their `Default` value, to be filled by later slices.
///
/// `regex_patterns` is a special case: the assembler populates it with the
/// static + signing PREFIX (everything up to the trigger-phrase tail, which
/// belongs to the trigger slice). It stays here because the field is not yet
/// complete; the parity harness compares the prefix separately rather than the
/// whole array.
pub const FIELDS_PENDING: &[&str] = &[
  "regex_patterns",
  "literal_patterns",
  "literal_options",
  "literal_patterns_from_deny_list_data",
  "slices",
  "deny_list_data",
  "false_positive_filters",
  "trigger_data",
  "name_corpus_data",
];

/// Gating context shared by every field builder.
///
/// Mirrors the locals computed at the top of `buildUnifiedSearchSources`:
/// content-language scope, the hotword-expanded search labels, and the derived
/// allowed-label set.
struct AssembleContext<'a> {
  config: &'a PipelineConfig,
  /// `configuredContentLanguages(config)`: `None` means "all languages".
  content_languages: Option<Vec<String>>,
  /// `createAllowedLabelSet(searchLabels)`: `None` means "no filter".
  allowed_labels: Option<Vec<String>>,
}

impl AssembleContext<'_> {
  /// Mirrors `labelIsAllowed`: an absent set means every label is allowed.
  fn label_allowed(&self, label: &str) -> bool {
    self
      .allowed_labels
      .as_ref()
      .is_none_or(|labels| labels.iter().any(|allowed| allowed == label))
  }

  const fn enable_regex(&self) -> bool {
    self.config.enable_regex
  }

  const fn enable_trigger_phrases(&self) -> bool {
    self.config.enable_trigger_phrases
  }

  /// `regexMonetaryEnabled`: regex on and the monetary label allowed.
  fn regex_monetary_enabled(&self) -> bool {
    self.enable_regex() && self.label_allowed("monetary amount")
  }
}

/// Assembles a prepared static-search config from a pipeline config,
/// dictionaries, and gazetteer entries.
///
/// # Errors
///
/// Returns [`AssembleError`] when an embedded data file needed by a ported
/// field fails to parse.
pub fn assemble_static_search_config(
  config: &PipelineConfig,
  _dictionaries: Option<&Dictionaries>,
  gazetteer: &[GazetteerEntry],
) -> Result<BindingPreparedSearchConfig, AssembleError> {
  // `enableHotwordRules === true` loads the rule set; it feeds both the
  // hotword_data field and the label expansion that gates every other field.
  let hotword_rules = if config.enable_hotword_rules == Some(true) {
    hotwords::load_hotword_rules()?
  } else {
    Vec::new()
  };
  let search_labels = if config.enable_hotword_rules == Some(true) {
    hotwords::expand_labels_for_hotword_rule_set(&config.labels, &hotword_rules)
  } else {
    config.labels.clone()
  };
  let ctx = AssembleContext {
    config,
    content_languages: language::configured_content_languages(config),
    allowed_labels: allowed_label_set(&search_labels),
  };

  let regex = regex::build_regex(&ctx)?;

  Ok(BindingPreparedSearchConfig {
    custom_regex_patterns: assemble_custom_regex_patterns(&ctx),
    custom_regex_meta: assemble_custom_regex_meta(&ctx),
    regex_patterns: regex.patterns,
    regex_meta: regex.meta,
    legal_form_data: legal_forms::build_legal_form_data(&ctx)?,
    allowed_labels: config.labels.clone(),
    threshold: config.threshold,
    confidence_boost: config.enable_confidence_boost,
    regex_options: Some(regex_options_template()),
    custom_regex_options: Some(custom_regex_options_template()),
    name_corpus_mode: name_corpus_mode(config),
    signature_data: Some(signature::build_signature_data()?),
    monetary_data: monetary::build_monetary_data(&ctx)?,
    date_data: dates::build_date_data(&ctx)?,
    zone_data: zones::build_zone_data(&ctx)?,
    address_context_data: address::build_address_context_data(&ctx)?,
    address_seed_data: address::build_address_seed_data(&ctx)?,
    country_data: country::build_country_data(&ctx)?,
    hotword_data: hotwords::build_hotword_data(&hotword_rules),
    gazetteer_data: gazetteer::build_gazetteer_data(&ctx, gazetteer),
    coreference_data: coreference::build_coreference_data(&ctx)?,
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
  ctx: &AssembleContext<'_>,
) -> Vec<BindingSearchPattern> {
  if !ctx.config.enable_regex {
    return Vec::new();
  }
  let Some(customs) = ctx.config.custom_regexes.as_ref() else {
    return Vec::new();
  };
  customs
    .iter()
    .filter(|entry| ctx.label_allowed(entry.label.as_str()))
    .map(custom_regex_pattern)
    .collect()
}

/// Mirrors `customRegexMeta.map(toNativeRegexMeta)`. Caller-supplied regexes
/// never carry a validator, so this reduces to the label, the score (defaulting
/// to [`DEFAULT_CUSTOM_REGEX_SCORE`]), and the `custom-regex` source detail.
fn assemble_custom_regex_meta(
  ctx: &AssembleContext<'_>,
) -> Vec<BindingRegexMatchMeta> {
  if !ctx.config.enable_regex {
    return Vec::new();
  }
  let Some(customs) = ctx.config.custom_regexes.as_ref() else {
    return Vec::new();
  };
  customs
    .iter()
    .filter(|entry| ctx.label_allowed(entry.label.as_str()))
    .map(|entry| BindingRegexMatchMeta {
      label: entry.label.clone(),
      score: entry.score.unwrap_or(DEFAULT_CUSTOM_REGEX_SCORE),
      source_detail: Some("custom-regex".to_string()),
      ..BindingRegexMatchMeta::default()
    })
    .collect()
}

/// Mirrors `createAllowedLabelSet`: an empty label list means "no filter".
///
/// The labels passed in are the hotword-expanded `searchLabels`, so
/// custom-regex gating stays consistent with the TypeScript source even when
/// `enableHotwordRules` reclassifies labels.
fn allowed_label_set(labels: &[String]) -> Option<Vec<String>> {
  if labels.is_empty() {
    return None;
  }
  Some(labels.to_vec())
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
