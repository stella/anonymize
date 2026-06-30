use crate::address_context::{AddressContextData, PreparedAddressContextData};
use crate::address_seeds::{AddressSeedData, PreparedAddressSeedData};
use crate::coreference::{CoreferenceData, PreparedCoreferenceData};
use crate::dates::{DateData, PreparedDateData};
use crate::diagnostics::{DiagnosticEvent, StaticRedactionDiagnostics};
use crate::hotwords::{HotwordRuleData, PreparedHotwordData};
use crate::legal_forms::{LegalFormData, PreparedLegalFormData};
use crate::money::{MonetaryData, PreparedMonetaryData};
use crate::name_corpus::{
  NameCorpusData, PreparedNameCorpusData as PreparedNames,
};
use crate::processors::{
  CountryMatchData, DenyListFilterData, DenyListMatchData, GazetteerMatchData,
  PatternSlice, RegexMatchMeta,
};
use crate::search::{SearchIndex, SearchOptions, SearchPattern};
use crate::signatures::{PreparedSignatureData, SignatureData};
use crate::triggers::{PreparedTriggerData, TriggerData};
use crate::types::{OperatorConfig, Result};
use crate::zones::{PreparedZoneData, ZoneData};

mod artifacts;
mod config_validation;
mod detection_phase;
mod diagnostic_stream;
mod entity_filter;
mod index_prepare;
mod phase;
mod prepare_phase;
mod redaction_phase;
mod resolution_phase;
mod results;
mod search_matcher;
mod search_phase;
mod support_prepare;
mod timing;

pub use artifacts::{PreparedSearchArtifacts, PreparedSearchArtifactsView};
use diagnostic_stream::DiagnosticEventStream;
pub use results::{
  PreparedSearchBuildResult, PreparedSearchMatches, StaticDetectionResult,
  StaticRedactionDiagnosticResult, StaticRedactionResult,
};

pub struct PreparedSearch {
  regex: SearchIndex,
  custom_regex: SearchIndex,
  legal_forms: SearchIndex,
  triggers: SearchIndex,
  literals: SearchIndex,
  allowed_labels: Vec<String>,
  threshold: f64,
  confidence_boost: bool,
  slices: PreparedSearchSlices,
  regex_meta: Vec<RegexMatchMeta>,
  custom_regex_meta: Vec<RegexMatchMeta>,
  deny_list_data: Option<DenyListMatchData>,
  false_positive_filters: Option<DenyListFilterData>,
  gazetteer_data: Option<GazetteerMatchData>,
  country_data: Option<CountryMatchData>,
  hotword_data: Option<PreparedHotwordData>,
  trigger_data: Option<PreparedTriggerData>,
  legal_form_data: Option<PreparedLegalFormData>,
  address_seed_data: Option<PreparedAddressSeedData>,
  zone_data: Option<PreparedZoneData>,
  address_context_data: Option<PreparedAddressContextData>,
  coreference_data: Option<PreparedCoreferenceData>,
  name_corpus_data: Option<PreparedNames>,
  signature_data: Option<PreparedSignatureData>,
  date_data: Option<PreparedDateData>,
  monetary_data: Option<PreparedMonetaryData>,
  monetary_extraction: bool,
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
