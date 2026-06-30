use crate::address_context::PreparedAddressContextData;
use crate::address_seeds::PreparedAddressSeedData;
use crate::coreference::PreparedCoreferenceData;
use crate::dates::PreparedDateData;
use crate::hotwords::PreparedHotwordData;
use crate::legal_forms::PreparedLegalFormData;
use crate::money::PreparedMonetaryData;
use crate::name_corpus::PreparedNameCorpusData as PreparedNames;
use crate::processors::{
  CountryMatchData, DenyListFilterData, DenyListMatchData, GazetteerMatchData,
  RegexMatchMeta,
};
use crate::search::SearchIndex;
use crate::signatures::PreparedSignatureData;
use crate::triggers::PreparedTriggerData;
use crate::zones::PreparedZoneData;

use super::PreparedEngineSlices;

pub(super) struct SearchIndexes {
  pub(super) regex: SearchIndex,
  pub(super) custom_regex: SearchIndex,
  pub(super) legal_forms: SearchIndex,
  pub(super) triggers: SearchIndex,
  pub(super) literals: SearchIndex,
}

pub(super) struct PipelinePolicy {
  pub(super) allowed_labels: Vec<String>,
  pub(super) threshold: f64,
  pub(super) confidence_boost: bool,
  pub(super) slices: PreparedEngineSlices,
  pub(super) regex_meta: Vec<RegexMatchMeta>,
  pub(super) custom_regex_meta: Vec<RegexMatchMeta>,
  pub(super) monetary_extraction: bool,
}

pub(super) struct PreparedStaticData {
  pub(super) deny_list: Option<DenyListMatchData>,
  pub(super) false_positive_filters: Option<DenyListFilterData>,
  pub(super) gazetteer: Option<GazetteerMatchData>,
  pub(super) countries: Option<CountryMatchData>,
  pub(super) hotwords: Option<PreparedHotwordData>,
  pub(super) triggers: Option<PreparedTriggerData>,
  pub(super) legal_forms: Option<PreparedLegalFormData>,
  pub(super) address_seed: Option<PreparedAddressSeedData>,
  pub(super) zones: Option<PreparedZoneData>,
  pub(super) address_context: Option<PreparedAddressContextData>,
  pub(super) coreference: Option<PreparedCoreferenceData>,
  pub(super) name_corpus: Option<PreparedNames>,
  pub(super) signatures: Option<PreparedSignatureData>,
  pub(super) dates: Option<PreparedDateData>,
  pub(super) monetary: Option<PreparedMonetaryData>,
}
