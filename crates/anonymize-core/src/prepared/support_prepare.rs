use std::time::Instant;

use crate::address_context::{AddressContextData, PreparedAddressContextData};
use crate::address_seeds::{AddressSeedData, PreparedAddressSeedData};
use crate::coreference::{CoreferenceData, PreparedCoreferenceData};
use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::hotwords::{HotwordRuleData, PreparedHotwordData};
use crate::legal_forms::{LegalFormData, PreparedLegalFormData};
use crate::name_corpus::{
  NameCorpusData, PreparedNameCorpusData as PreparedNames,
};
use crate::signatures::{PreparedSignatureData, SignatureData};
use crate::triggers::{PreparedTriggerData, TriggerData};
use crate::types::{Error, Result};
use crate::zones::{PreparedZoneData, ZoneData};

use super::PreparedSearchConfig;
use super::phase::record_prepare_stage_elapsed;
use super::timing::elapsed_us;

pub(super) struct SupportDataInput {
  hotwords: Option<HotwordRuleData>,
  triggers: Option<TriggerData>,
  legal_forms: Option<LegalFormData>,
  address_seed: Option<AddressSeedData>,
  zones: Option<ZoneData>,
  address_context: Option<AddressContextData>,
  coreference: Option<CoreferenceData>,
  name_corpus: Option<NameCorpusData>,
  signature: Option<SignatureData>,
}

pub(super) struct PreparedSupportData {
  pub(super) hotwords: Option<PreparedHotwordData>,
  pub(super) triggers: Option<PreparedTriggerData>,
  pub(super) legal_forms: Option<PreparedLegalFormData>,
  pub(super) address_seed: Option<PreparedAddressSeedData>,
  pub(super) zones: Option<PreparedZoneData>,
  pub(super) address_context: Option<PreparedAddressContextData>,
  pub(super) coreference: Option<PreparedCoreferenceData>,
  pub(super) names: Option<PreparedNames>,
  pub(super) signature: Option<PreparedSignatureData>,
  pub(super) count: usize,
}

struct TimedSupportData<T> {
  data: T,
  len: usize,
  elapsed_us: u64,
}

pub(super) const fn take_support_input(
  config: &mut PreparedSearchConfig,
) -> SupportDataInput {
  SupportDataInput {
    hotwords: config.hotword_data.take(),
    triggers: config.trigger_data.take(),
    legal_forms: config.legal_form_data.take(),
    address_seed: config.address_seed_data.take(),
    zones: config.zone_data.take(),
    address_context: config.address_context_data.take(),
    coreference: config.coreference_data.take(),
    name_corpus: config.name_corpus_data.take(),
    signature: config.signature_data.take(),
  }
}

pub(super) fn prepare_support_data(
  input: SupportDataInput,
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
) -> Result<PreparedSupportData> {
  let prepared = std::thread::scope(|scope| {
    let hotwords = scope.spawn(|| prepare_timed_hotword_data(input.hotwords));
    let triggers = scope.spawn(|| prepare_timed_trigger_data(input.triggers));
    let legal_forms =
      scope.spawn(|| Ok(prepare_timed_legal_form_data(input.legal_forms)));
    let address_seed =
      scope.spawn(|| prepare_timed_address_seed_data(input.address_seed));
    let zones = scope.spawn(|| prepare_timed_zone_data(input.zones.as_ref()));
    let address_context =
      scope.spawn(|| prepare_timed_address_context_data(input.address_context));
    let coreference =
      scope.spawn(|| prepare_timed_coreference_data(input.coreference));
    let names =
      scope.spawn(|| Ok(prepare_timed_name_corpus_data(input.name_corpus)));
    let signature =
      scope.spawn(|| Ok(prepare_timed_signature_data(input.signature)));

    Ok(ParallelPreparedSupportData {
      hotwords: join_support_data(hotwords, "hotword_data")?,
      triggers: join_support_data(triggers, "trigger_data")?,
      legal_forms: join_support_data(legal_forms, "legal_form_data")?,
      address_seed: join_support_data(address_seed, "address_seed_data")?,
      zones: join_support_data(zones, "zone_data")?,
      address_context: join_support_data(
        address_context,
        "address_context_data",
      )?,
      coreference: join_support_data(coreference, "coreference_data")?,
      names: join_support_data(names, "name_corpus_data")?,
      signature: join_support_data(signature, "signature_data")?,
    })
  })?;

  record_parallel_support_data(diagnostics, &prepared);
  Ok(parallel_support_data_into_prepared(prepared))
}

fn record_parallel_support_data(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  prepared: &ParallelPreparedSupportData,
) {
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareHotwordData,
    prepared.hotwords.len,
    prepared.hotwords.elapsed_us,
  );
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareTriggerData,
    prepared.triggers.len,
    prepared.triggers.elapsed_us,
  );
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareLegalFormData,
    prepared.legal_forms.len,
    prepared.legal_forms.elapsed_us,
  );
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareAddressSeedData,
    prepared.address_seed.len,
    prepared.address_seed.elapsed_us,
  );
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareZoneData,
    prepared.zones.len,
    prepared.zones.elapsed_us,
  );
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareAddressContextData,
    prepared.address_context.len,
    prepared.address_context.elapsed_us,
  );
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareCoreferenceData,
    prepared.coreference.len,
    prepared.coreference.elapsed_us,
  );
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareNameCorpusData,
    prepared.names.len,
    prepared.names.elapsed_us,
  );
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareSignatureData,
    prepared.signature.len,
    prepared.signature.elapsed_us,
  );
}

fn parallel_support_data_into_prepared(
  prepared: ParallelPreparedSupportData,
) -> PreparedSupportData {
  let count = [
    prepared.hotwords.len,
    prepared.triggers.len,
    prepared.legal_forms.len,
    prepared.address_seed.len,
    prepared.zones.len,
    prepared.address_context.len,
    prepared.coreference.len,
    prepared.names.len,
    prepared.signature.len,
  ]
  .into_iter()
  .fold(0usize, usize::saturating_add);

  PreparedSupportData {
    hotwords: prepared.hotwords.data,
    triggers: prepared.triggers.data,
    legal_forms: prepared.legal_forms.data,
    address_seed: prepared.address_seed.data,
    zones: prepared.zones.data,
    address_context: prepared.address_context.data,
    coreference: prepared.coreference.data,
    names: prepared.names.data,
    signature: prepared.signature.data,
    count,
  }
}

struct ParallelPreparedSupportData {
  hotwords: TimedSupportData<Option<PreparedHotwordData>>,
  triggers: TimedSupportData<Option<PreparedTriggerData>>,
  legal_forms: TimedSupportData<Option<PreparedLegalFormData>>,
  address_seed: TimedSupportData<Option<PreparedAddressSeedData>>,
  zones: TimedSupportData<Option<PreparedZoneData>>,
  address_context: TimedSupportData<Option<PreparedAddressContextData>>,
  coreference: TimedSupportData<Option<PreparedCoreferenceData>>,
  names: TimedSupportData<Option<PreparedNames>>,
  signature: TimedSupportData<Option<PreparedSignatureData>>,
}

fn prepare_timed_hotword_data(
  data: Option<HotwordRuleData>,
) -> Result<TimedSupportData<Option<PreparedHotwordData>>> {
  let len = hotword_data_len(data.as_ref());
  let start = Instant::now();
  let data = prepare_hotword_data(data)?;
  Ok(TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  })
}

fn prepare_timed_trigger_data(
  data: Option<TriggerData>,
) -> Result<TimedSupportData<Option<PreparedTriggerData>>> {
  let len = trigger_data_len(data.as_ref());
  let start = Instant::now();
  let data = prepare_trigger_data(data)?;
  Ok(TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  })
}

fn prepare_timed_legal_form_data(
  data: Option<LegalFormData>,
) -> TimedSupportData<Option<PreparedLegalFormData>> {
  let len = legal_form_data_len(data.as_ref());
  let start = Instant::now();
  let data = data.map(PreparedLegalFormData::new);
  TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  }
}

fn prepare_timed_address_seed_data(
  data: Option<AddressSeedData>,
) -> Result<TimedSupportData<Option<PreparedAddressSeedData>>> {
  let len = address_seed_data_len(data.as_ref());
  let start = Instant::now();
  let data = prepare_address_seed_data(data)?;
  Ok(TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  })
}

fn prepare_timed_zone_data(
  data: Option<&ZoneData>,
) -> Result<TimedSupportData<Option<PreparedZoneData>>> {
  let len = zone_data_len(data);
  let start = Instant::now();
  let data = prepare_zone_data(data)?;
  Ok(TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  })
}

fn prepare_timed_address_context_data(
  data: Option<AddressContextData>,
) -> Result<TimedSupportData<Option<PreparedAddressContextData>>> {
  let len = address_context_data_len(data.as_ref());
  let start = Instant::now();
  let data = prepare_address_context_data(data)?;
  Ok(TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  })
}

fn prepare_timed_coreference_data(
  data: Option<CoreferenceData>,
) -> Result<TimedSupportData<Option<PreparedCoreferenceData>>> {
  let len = coreference_data_len(data.as_ref());
  let start = Instant::now();
  let data = prepare_coreference_data(data)?;
  Ok(TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  })
}

fn prepare_timed_name_corpus_data(
  data: Option<NameCorpusData>,
) -> TimedSupportData<Option<PreparedNames>> {
  let len = name_corpus_data_len(data.as_ref());
  let start = Instant::now();
  let data = data.map(PreparedNames::new);
  TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  }
}

fn prepare_timed_signature_data(
  data: Option<SignatureData>,
) -> TimedSupportData<Option<PreparedSignatureData>> {
  let len = signature_data_len(data.as_ref());
  let start = Instant::now();
  let data = data.map(PreparedSignatureData::new);
  TimedSupportData {
    data,
    len,
    elapsed_us: elapsed_us(start),
  }
}

fn join_support_data<T>(
  handle: std::thread::ScopedJoinHandle<'_, Result<TimedSupportData<T>>>,
  field: &'static str,
) -> Result<TimedSupportData<T>> {
  handle.join().map_err(|_| Error::InvalidStaticData {
    field,
    reason: "support data builder panicked".to_owned(),
  })?
}

fn hotword_data_len(data: Option<&HotwordRuleData>) -> usize {
  data.map_or(0, |data| data.rules.len())
}

fn trigger_data_len(data: Option<&TriggerData>) -> usize {
  data.map_or(0, |data| data.rules.len())
}

fn legal_form_data_len(data: Option<&LegalFormData>) -> usize {
  data.map_or(0, |data| {
    [
      data.suffixes.len(),
      data.normalized_boundary_suffixes.len(),
      data.normalized_in_name_words.len(),
      data.normalized_suffix_words.len(),
      data.role_heads.len(),
      data.sentence_verb_indicators.len(),
      data.clause_noun_heads.len(),
      data.connector_prose_heads.len(),
      data.structural_single_cap_prefixes.len(),
      data.leading_clause_phrases.len(),
      data.leading_clause_direct_prefixes.len(),
      data.connector_words.len(),
      data.and_connector_words.len(),
      data.in_name_prepositions.len(),
      data.company_suffix_words.len(),
      data.comma_gated_direct_prefixes.len(),
    ]
    .into_iter()
    .fold(0usize, usize::saturating_add)
  })
}

fn address_seed_data_len(data: Option<&AddressSeedData>) -> usize {
  data.map_or(0, |data| {
    data
      .boundary_words
      .len()
      .saturating_add(data.br_cep_cue_words.len())
      .saturating_add(data.unit_abbreviations.len())
  })
}

fn zone_data_len(data: Option<&ZoneData>) -> usize {
  data.map_or(0, |data| {
    data
      .section_heading_patterns
      .len()
      .saturating_add(data.signing_clauses.len())
  })
}

fn address_context_data_len(data: Option<&AddressContextData>) -> usize {
  data.map_or(0, |data| {
    data
      .address_prepositions
      .len()
      .saturating_add(data.temporal_prepositions.len())
      .saturating_add(data.street_abbreviations.len())
      .saturating_add(data.bare_house_stopwords.len())
  })
}

fn coreference_data_len(data: Option<&CoreferenceData>) -> usize {
  data.map_or(0, |data| {
    data
      .definition_patterns
      .len()
      .saturating_add(data.role_stop_terms.len())
      .saturating_add(data.legal_form_aliases.len())
      .saturating_add(data.organization_suffixes.len())
      .saturating_add(data.organization_determiners.len())
  })
}

fn name_corpus_data_len(data: Option<&NameCorpusData>) -> usize {
  data.map_or(0, |data| {
    [
      data.first_names.len(),
      data.surnames.len(),
      data.title_tokens.len(),
      data.title_abbreviations.len(),
      data.excluded_words.len(),
      data.common_words.len(),
      data.non_western_names.len(),
      data.excluded_all_caps.len(),
      data.ja_suffixes.len(),
      data.arabic_connectors.len(),
      data.relation_connectors.len(),
      data.hyphenated_prefixes.len(),
      data.cjk_non_person_terms.len(),
      data.cjk_surname_starters.len(),
      data.organization_terms.len(),
    ]
    .into_iter()
    .fold(0usize, usize::saturating_add)
  })
}

fn signature_data_len(data: Option<&SignatureData>) -> usize {
  data.map_or(0, |data| {
    [
      data.labels.len(),
      data.witness_phrases.len(),
      data.name_particles.len(),
      data.post_nominal_suffixes.len(),
      data.organization_suffixes.len(),
      data.image_stub_prefixes.len(),
    ]
    .into_iter()
    .fold(0usize, usize::saturating_add)
  })
}

fn prepare_address_seed_data(
  data: Option<AddressSeedData>,
) -> Result<Option<PreparedAddressSeedData>> {
  data.map(PreparedAddressSeedData::new).transpose()
}

fn prepare_hotword_data(
  data: Option<HotwordRuleData>,
) -> Result<Option<PreparedHotwordData>> {
  data.map(PreparedHotwordData::new).transpose()
}

fn prepare_trigger_data(
  data: Option<TriggerData>,
) -> Result<Option<PreparedTriggerData>> {
  data.map(PreparedTriggerData::new).transpose()
}

fn prepare_address_context_data(
  data: Option<AddressContextData>,
) -> Result<Option<PreparedAddressContextData>> {
  data.map(PreparedAddressContextData::new).transpose()
}

fn prepare_zone_data(
  data: Option<&ZoneData>,
) -> Result<Option<PreparedZoneData>> {
  data.map(PreparedZoneData::new).transpose()
}

fn prepare_coreference_data(
  data: Option<CoreferenceData>,
) -> Result<Option<PreparedCoreferenceData>> {
  data.map(PreparedCoreferenceData::new).transpose()
}
