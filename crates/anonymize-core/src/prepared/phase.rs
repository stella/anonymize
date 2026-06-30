use std::time::Instant;

use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::resolution::PipelineEntity;
use crate::types::Result;

use super::diagnostic_stream::DiagnosticEventStream;
use super::timing::{TimedEntities, elapsed_us};

#[derive(Clone, Copy)]
pub(super) struct PhaseTimer {
  start: Instant,
}

impl PhaseTimer {
  pub(super) fn start() -> Self {
    Self {
      start: Instant::now(),
    }
  }

  pub(super) fn elapsed_us(self) -> u64 {
    elapsed_us(self.start)
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ResolverStep {
  AddressContext,
  Merge,
  Boundary,
  Sanitize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DetectorPass {
  Regex,
  CustomRegex,
  DenyList,
  Gazetteer,
  Country,
  Anchored,
  Trigger,
  Signature,
  LegalForm,
  NameCorpus,
  AddressSeed,
}

impl DetectorPass {
  const fn diagnostic_stage(self) -> DiagnosticStage {
    match self {
      Self::Regex => DiagnosticStage::EntityRegex,
      Self::CustomRegex => DiagnosticStage::EntityCustomRegex,
      Self::DenyList => DiagnosticStage::EntityDenyList,
      Self::Gazetteer => DiagnosticStage::EntityGazetteer,
      Self::Country => DiagnosticStage::EntityCountry,
      Self::Anchored => DiagnosticStage::EntityAnchored,
      Self::Trigger => DiagnosticStage::EntityTrigger,
      Self::Signature => DiagnosticStage::EntitySignature,
      Self::LegalForm => DiagnosticStage::EntityLegalForm,
      Self::NameCorpus => DiagnosticStage::EntityNameCorpus,
      Self::AddressSeed => DiagnosticStage::EntityAddressSeed,
    }
  }
}

impl ResolverStep {
  const fn diagnostic_stage(self) -> DiagnosticStage {
    match self {
      Self::AddressContext => DiagnosticStage::EntityAddressContext,
      Self::Merge => DiagnosticStage::Merge,
      Self::Boundary => DiagnosticStage::Boundary,
      Self::Sanitize => DiagnosticStage::Sanitize,
    }
  }
}

pub(super) fn record_detector_entities(
  diagnostics: &mut StaticRedactionDiagnostics,
  pass: DetectorPass,
  timed: &TimedEntities,
  full_text: &str,
) {
  diagnostics.record_entities(
    pass.diagnostic_stage(),
    &timed.entities,
    full_text,
    Some(timed.elapsed_us),
  );
}

pub(super) fn record_resolver_entities(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  event_stream: &mut DiagnosticEventStream<'_>,
  step: ResolverStep,
  entities: &[PipelineEntity],
  full_text: &str,
  timer: PhaseTimer,
) -> Result<()> {
  record_entities(
    diagnostics,
    step.diagnostic_stage(),
    entities,
    full_text,
    timer,
  );
  observe_diagnostic_stream(diagnostics, event_stream)
}

pub(super) fn record_entities(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  stage: DiagnosticStage,
  entities: &[PipelineEntity],
  full_text: &str,
  timer: PhaseTimer,
) {
  if let Some(diagnostics) = diagnostics {
    diagnostics.record_entities(
      stage,
      entities,
      full_text,
      Some(timer.elapsed_us()),
    );
  }
}

pub(super) fn record_count_stage(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  stage: DiagnosticStage,
  count: usize,
  input_bytes: usize,
  timer: PhaseTimer,
) {
  if let Some(diagnostics) = diagnostics {
    diagnostics.record_stage(
      stage,
      Some(count),
      Some(timer.elapsed_us()),
      Some(input_bytes),
    );
  }
}

pub(super) fn observe_diagnostic_stream(
  diagnostics: &Option<&mut StaticRedactionDiagnostics>,
  event_stream: &mut DiagnosticEventStream<'_>,
) -> Result<()> {
  event_stream.observe(diagnostics.as_ref().map(|value| &**value))
}
