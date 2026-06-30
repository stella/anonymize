use crate::address_context::AddressContextData;
use crate::address_seeds::AddressSeedData;
use crate::coreference::CoreferenceData;
use crate::dates::DateData;
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
use crate::zones::ZoneData;

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct PreparedEngineSlices {
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

#[derive(
  bon::Builder,
  Clone,
  Debug,
  Default,
  PartialEq,
  serde::Deserialize,
  serde::Serialize,
)]
pub struct PreparedEngineSearchConfig {
  #[builder(default)]
  pub regex_patterns: Vec<SearchPattern>,
  #[builder(default)]
  pub custom_regex_patterns: Vec<SearchPattern>,
  #[builder(default)]
  pub literal_patterns: Vec<SearchPattern>,
  #[builder(default)]
  pub regex_options: SearchOptions,
  #[builder(default)]
  pub custom_regex_options: SearchOptions,
  #[builder(default)]
  pub literal_options: SearchOptions,
  #[builder(default)]
  pub slices: PreparedEngineSlices,
  #[builder(default)]
  pub regex_meta: Vec<RegexMatchMeta>,
  #[builder(default)]
  pub custom_regex_meta: Vec<RegexMatchMeta>,
}

#[derive(
  bon::Builder,
  Clone,
  Debug,
  Default,
  PartialEq,
  serde::Deserialize,
  serde::Serialize,
)]
pub struct PreparedEnginePolicyConfig {
  #[serde(default)]
  #[builder(default)]
  pub allowed_labels: Vec<String>,
  #[serde(default)]
  #[builder(default)]
  pub threshold: f64,
  #[serde(default)]
  #[builder(default)]
  pub confidence_boost: bool,
}

#[derive(
  bon::Builder,
  Clone,
  Debug,
  Default,
  PartialEq,
  serde::Deserialize,
  serde::Serialize,
)]
pub struct PreparedEngineDetectorConfig {
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

#[derive(
  bon::Builder,
  Clone,
  Debug,
  Default,
  PartialEq,
  serde::Deserialize,
  serde::Serialize,
)]
pub struct PreparedEngineConfig {
  #[builder(default)]
  pub search: PreparedEngineSearchConfig,
  #[builder(default)]
  pub policy: PreparedEnginePolicyConfig,
  #[builder(default)]
  pub detectors: PreparedEngineDetectorConfig,
}
