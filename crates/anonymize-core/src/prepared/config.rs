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

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct PreparedEngineConfig {
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
  pub slices: PreparedEngineSlices,
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

pub type PreparedSearchConfig = PreparedEngineConfig;
pub type PreparedSearchSlices = PreparedEngineSlices;
