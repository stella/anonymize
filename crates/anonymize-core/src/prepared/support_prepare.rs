use crate::address_context::{AddressContextData, PreparedAddressContextData};
use crate::address_seeds::{AddressSeedData, PreparedAddressSeedData};
use crate::coreference::{CoreferenceData, PreparedCoreferenceData};
use crate::diagnostics::StaticRedactionDiagnostics;
use crate::hotwords::{HotwordRuleData, PreparedHotwordData};
use crate::legal_forms::{LegalFormData, PreparedLegalFormData};
use crate::name_corpus::{
  NameCorpusData, PreparedNameCorpusData as PreparedNames,
};
use crate::signatures::{PreparedSignatureData, SignatureData};
use crate::triggers::{PreparedTriggerData, TriggerData};
use crate::types::Result;
use crate::zones::{PreparedZoneData, ZoneData};

use super::PreparedEngineDetectorConfig;
use super::phase::record_prepare_stage_elapsed;
use super::support_resources::{SupportResourceId, SupportResourceSpec};
use super::support_slots::{
  TimedSupportData, join_support_data, prepare_timed_address_context_data,
  prepare_timed_address_seed_data, prepare_timed_coreference_data,
  prepare_timed_hotword_data, prepare_timed_legal_form_data,
  prepare_timed_name_corpus_data, prepare_timed_signature_data,
  prepare_timed_trigger_data, prepare_timed_zone_data,
};

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

pub(super) const fn take_support_input(
  config: &mut PreparedEngineDetectorConfig,
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
      hotwords: join_support_data(
        hotwords,
        SupportResourceId::Hotwords.spec().config_field(),
      )?,
      triggers: join_support_data(
        triggers,
        SupportResourceId::Triggers.spec().config_field(),
      )?,
      legal_forms: join_support_data(
        legal_forms,
        SupportResourceId::LegalForms.spec().config_field(),
      )?,
      address_seed: join_support_data(
        address_seed,
        SupportResourceId::AddressSeed.spec().config_field(),
      )?,
      zones: join_support_data(
        zones,
        SupportResourceId::Zones.spec().config_field(),
      )?,
      address_context: join_support_data(
        address_context,
        SupportResourceId::AddressContext.spec().config_field(),
      )?,
      coreference: join_support_data(
        coreference,
        SupportResourceId::Coreference.spec().config_field(),
      )?,
      names: join_support_data(
        names,
        SupportResourceId::NameCorpus.spec().config_field(),
      )?,
      signature: join_support_data(
        signature,
        SupportResourceId::Signature.spec().config_field(),
      )?,
    })
  })?;

  record_parallel_support_data(diagnostics, &prepared);
  Ok(parallel_support_data_into_prepared(prepared))
}

fn record_parallel_support_data(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  prepared: &ParallelPreparedSupportData,
) {
  for metric in prepared.metrics() {
    record_prepare_stage_elapsed(
      diagnostics,
      metric.resource.diagnostic_stage(),
      metric.count,
      metric.elapsed_us,
    );
  }
}

fn parallel_support_data_into_prepared(
  prepared: ParallelPreparedSupportData,
) -> PreparedSupportData {
  let count = prepared.total_count();

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

impl ParallelPreparedSupportData {
  const fn metrics(&self) -> [SupportPrepareMetric; SupportResourceId::COUNT] {
    [
      SupportPrepareMetric::from_timed(
        SupportResourceId::Hotwords.spec(),
        &self.hotwords,
      ),
      SupportPrepareMetric::from_timed(
        SupportResourceId::Triggers.spec(),
        &self.triggers,
      ),
      SupportPrepareMetric::from_timed(
        SupportResourceId::LegalForms.spec(),
        &self.legal_forms,
      ),
      SupportPrepareMetric::from_timed(
        SupportResourceId::AddressSeed.spec(),
        &self.address_seed,
      ),
      SupportPrepareMetric::from_timed(
        SupportResourceId::Zones.spec(),
        &self.zones,
      ),
      SupportPrepareMetric::from_timed(
        SupportResourceId::AddressContext.spec(),
        &self.address_context,
      ),
      SupportPrepareMetric::from_timed(
        SupportResourceId::Coreference.spec(),
        &self.coreference,
      ),
      SupportPrepareMetric::from_timed(
        SupportResourceId::NameCorpus.spec(),
        &self.names,
      ),
      SupportPrepareMetric::from_timed(
        SupportResourceId::Signature.spec(),
        &self.signature,
      ),
    ]
  }

  fn total_count(&self) -> usize {
    self
      .metrics()
      .into_iter()
      .map(|metric| metric.count)
      .fold(0usize, usize::saturating_add)
  }
}

#[derive(Clone, Copy)]
struct SupportPrepareMetric {
  resource: SupportResourceSpec,
  count: usize,
  elapsed_us: u64,
}

impl SupportPrepareMetric {
  const fn from_timed<T>(
    resource: SupportResourceSpec,
    timed: &TimedSupportData<T>,
  ) -> Self {
    Self {
      resource,
      count: timed.len,
      elapsed_us: timed.elapsed_us,
    }
  }
}
