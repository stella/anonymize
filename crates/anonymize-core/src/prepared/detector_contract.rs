use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::types::Result;

use super::PreparedEngine;
use super::results::PreparedEngineMatches;
use super::support_resources::SupportResourceId;
use super::timing::{StaticEntityPasses, TimedEntities};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum StaticDetectorId {
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

impl StaticDetectorId {
  pub(super) const fn diagnostic_stage(self) -> DiagnosticStage {
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum StaticDetectorInput {
  FullText,
  RegexMatches,
  CustomRegexMatches,
  LiteralMatches,
  RegexMeta,
  CustomRegexMeta,
  DenyListData,
  GazetteerData,
  CountryData,
  DateData,
  MonetaryData,
  TriggerData,
  SignatureData,
  LegalFormData,
  NameCorpusData,
  AddressSeedData,
  ContextEntities,
  DenyListEntities,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct StaticDetectorSpec {
  id: StaticDetectorId,
  declared_inputs: &'static [StaticDetectorInput],
  dependencies: &'static [StaticDetectorId],
  support_resources: &'static [SupportResourceId],
}

impl StaticDetectorSpec {
  pub(super) const fn define(id: StaticDetectorId) -> Self {
    Self {
      id,
      declared_inputs: &[],
      dependencies: &[],
      support_resources: &[],
    }
  }

  pub(super) const fn requires(
    mut self,
    declared_inputs: &'static [StaticDetectorInput],
  ) -> Self {
    self.declared_inputs = declared_inputs;
    self
  }

  pub(super) const fn after(
    mut self,
    dependencies: &'static [StaticDetectorId],
  ) -> Self {
    self.dependencies = dependencies;
    self
  }

  pub(super) const fn uses(
    mut self,
    support_resources: &'static [SupportResourceId],
  ) -> Self {
    self.support_resources = support_resources;
    self
  }

  pub(super) const fn id(self) -> StaticDetectorId {
    self.id
  }

  pub(super) const fn diagnostic_stage(self) -> DiagnosticStage {
    self.id.diagnostic_stage()
  }

  #[cfg(test)]
  pub(super) const fn declared_inputs(self) -> &'static [StaticDetectorInput] {
    self.declared_inputs
  }

  pub(super) const fn dependencies(self) -> &'static [StaticDetectorId] {
    self.dependencies
  }

  pub(super) const fn support_resources(self) -> &'static [SupportResourceId] {
    self.support_resources
  }

  pub(super) fn has_declared_inputs(self) -> bool {
    !self.declared_inputs.is_empty()
      || self
        .support_resources
        .iter()
        .any(|resource| resource.spec().detector_input().is_some())
  }

  pub(super) fn declares_input(self, input: StaticDetectorInput) -> bool {
    self.declared_inputs.contains(&input)
      || self
        .support_resources
        .iter()
        .any(|resource| resource.spec().detector_input() == Some(input))
  }
}

pub(super) struct StaticDetectorContext<'a> {
  pub(super) engine: &'a PreparedEngine,
  pub(super) matches: &'a PreparedEngineMatches,
  pub(super) full_text: &'a str,
}

pub(super) type StaticDetectorDiagnostics<'d> =
  Option<&'d mut StaticRedactionDiagnostics>;

pub(super) type StaticDetectorActiveFn =
  for<'a> fn(&StaticDetectorContext<'a>) -> bool;

pub(super) type StaticDetectFn = for<'a, 'p, 'd> fn(
  &StaticDetectorContext<'a>,
  &'p StaticEntityPasses,
  StaticDetectorDiagnostics<'d>,
) -> Result<TimedEntities>;

#[derive(Clone, Copy)]
pub(super) struct StaticDetectorRule {
  spec: StaticDetectorSpec,
  is_active: StaticDetectorActiveFn,
  detect: StaticDetectFn,
}

impl StaticDetectorRule {
  pub(super) const fn declare(
    spec: StaticDetectorSpec,
    is_active: StaticDetectorActiveFn,
    detect: StaticDetectFn,
  ) -> Self {
    Self {
      spec,
      is_active,
      detect,
    }
  }

  pub(super) const fn spec(self) -> StaticDetectorSpec {
    self.spec
  }

  pub(super) fn is_active(self, context: &StaticDetectorContext<'_>) -> bool {
    (self.is_active)(context)
  }

  pub(super) fn detect(
    self,
    context: &StaticDetectorContext<'_>,
    passes: &StaticEntityPasses,
    diagnostics: StaticDetectorDiagnostics<'_>,
  ) -> Result<TimedEntities> {
    (self.detect)(context, passes, diagnostics)
  }
}

macro_rules! static_detector_rule {
  (
    $visibility:vis const $name:ident;
    id: $id:expr;
    inputs: $inputs:expr;
    $(after: $dependencies:expr;)?
    $(uses: $resources:expr;)?
    active: $is_active:path;
    detect: $detect:path $(;)?
  ) => {
    $visibility const $name:
      $crate::prepared::detector_contract::StaticDetectorRule =
      $crate::prepared::detector_contract::StaticDetectorRule::declare(
        $crate::prepared::detector_contract::StaticDetectorSpec::define($id)
          .requires($inputs)
          $(.after($dependencies))?
          $(.uses($resources))?,
        $is_active,
        $detect,
      );
  };
}

pub(super) use static_detector_rule;
