use crate::address_context::AddressContextData;
use crate::address_seeds::AddressSeedData;
use crate::coreference::CoreferenceData;
use crate::dates::DateData;
use crate::diagnostics::{DiagnosticEvent, StaticRedactionDiagnostics};
use crate::hotwords::HotwordRuleData;
use crate::legal_forms::LegalFormData;
use crate::money::MonetaryData;
use crate::name_corpus::NameCorpusData;
use crate::processors::{
  CountryMatchData, DenyListFilterData, DenyListMatchData, GazetteerMatchData,
  PatternSlice, RegexMatchMeta,
};
use crate::search::{SearchOptions, SearchPattern};
use crate::signatures::SignatureData;
use crate::triggers::TriggerData;
use crate::types::{OperatorConfig, Result};
use crate::zones::ZoneData;

mod artifacts;
mod config_validation;
mod detection_phase;
mod diagnostic_stream;
mod engine_state;
mod entity_filter;
mod index_builder;
mod index_patterns;
mod index_prepare;
mod phase;
mod prepare_phase;
mod redaction_phase;
mod resolution_phase;
mod results;
mod search_matcher;
mod search_phase;
mod support_prepare;
mod support_slots;
mod timing;

pub use artifacts::{PreparedSearchArtifacts, PreparedSearchArtifactsView};
use diagnostic_stream::DiagnosticEventStream;
use engine_state::{PipelinePolicy, PreparedStaticData, SearchIndexes};
pub use results::{
  PreparedSearchBuildResult, PreparedSearchMatches, StaticDetectionResult,
  StaticRedactionDiagnosticResult, StaticRedactionResult,
};

pub struct PreparedSearch {
  indexes: SearchIndexes,
  policy: PipelinePolicy,
  data: PreparedStaticData,
}

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct PreparedSearchSlices {
  pub regex: PatternSlice,
  pub custom_regex: PatternSlice,
  pub legal_forms: PatternSlice,
  pub triggers: PatternSlice,
  pub deny_list: PatternSlice,
  pub street_types: PatternSlice,
  pub gazetteer: PatternSlice,
  pub countries: PatternSlice,
  pub hotwords: PatternSlice,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct PreparedSearchConfig {
  pub regex_patterns: Vec<SearchPattern>,
  pub custom_regex_patterns: Vec<SearchPattern>,
  pub literal_patterns: Vec<SearchPattern>,
  pub regex_options: SearchOptions,
  pub custom_regex_options: SearchOptions,
  pub literal_options: SearchOptions,
  #[serde(default)]
  pub allowed_labels: Vec<String>,
  #[serde(default)]
  pub threshold: f64,
  #[serde(default)]
  pub confidence_boost: bool,
  pub slices: PreparedSearchSlices,
  pub regex_meta: Vec<RegexMatchMeta>,
  pub custom_regex_meta: Vec<RegexMatchMeta>,
  pub deny_list_data: Option<DenyListMatchData>,
  #[serde(default)]
  pub false_positive_filters: Option<DenyListFilterData>,
  pub gazetteer_data: Option<GazetteerMatchData>,
  pub country_data: Option<CountryMatchData>,
  #[serde(default)]
  pub hotword_data: Option<HotwordRuleData>,
  pub trigger_data: Option<TriggerData>,
  pub legal_form_data: Option<LegalFormData>,
  pub address_seed_data: Option<AddressSeedData>,
  #[serde(default)]
  pub zone_data: Option<ZoneData>,
  #[serde(default)]
  pub address_context_data: Option<AddressContextData>,
  #[serde(default)]
  pub coreference_data: Option<CoreferenceData>,
  #[serde(default)]
  pub name_corpus_data: Option<NameCorpusData>,
  #[serde(default)]
  pub signature_data: Option<SignatureData>,
  pub date_data: Option<DateData>,
  pub monetary_data: Option<MonetaryData>,
}

impl PreparedSearch {
  pub fn redact_static_entities(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
  ) -> Result<StaticRedactionResult> {
    let mut event_stream = DiagnosticEventStream::none();
    self.redact_static_entities_inner(
      full_text,
      operators,
      None,
      &mut event_stream,
    )
  }

  pub fn redact_static_entities_with_diagnostics(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
  ) -> Result<StaticRedactionDiagnosticResult> {
    let mut diagnostics = StaticRedactionDiagnostics::default();
    let mut event_stream = DiagnosticEventStream::none();
    let result = self.redact_static_entities_inner(
      full_text,
      operators,
      Some(&mut diagnostics),
      &mut event_stream,
    )?;

    Ok(StaticRedactionDiagnosticResult {
      result,
      diagnostics,
    })
  }

  pub fn redact_static_entities_with_summary_diagnostics(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
  ) -> Result<StaticRedactionDiagnosticResult> {
    let mut diagnostics = StaticRedactionDiagnostics::summary();
    let mut event_stream = DiagnosticEventStream::none();
    let result = self.redact_static_entities_inner(
      full_text,
      operators,
      Some(&mut diagnostics),
      &mut event_stream,
    )?;

    Ok(StaticRedactionDiagnosticResult {
      result,
      diagnostics,
    })
  }

  pub fn redact_static_entities_with_diagnostics_observer<F>(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
    mut observer: F,
  ) -> Result<StaticRedactionDiagnosticResult>
  where
    F: FnMut(&[DiagnosticEvent]) -> Result<()>,
  {
    let mut diagnostics = StaticRedactionDiagnostics::default();
    let mut event_stream = DiagnosticEventStream::observed(&mut observer);
    let result = self.redact_static_entities_inner(
      full_text,
      operators,
      Some(&mut diagnostics),
      &mut event_stream,
    )?;

    Ok(StaticRedactionDiagnosticResult {
      result,
      diagnostics,
    })
  }
}
