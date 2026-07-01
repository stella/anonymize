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
  pub(super) const COUNT: usize = 11;

  pub(super) const ORDER: [Self; Self::COUNT] = [
    Self::Regex,
    Self::CustomRegex,
    Self::DenyList,
    Self::Gazetteer,
    Self::Country,
    Self::Anchored,
    Self::Trigger,
    Self::Signature,
    Self::LegalForm,
    Self::NameCorpus,
    Self::AddressSeed,
  ];

  pub(super) const fn index(self) -> usize {
    match self {
      Self::Regex => 0,
      Self::CustomRegex => 1,
      Self::DenyList => 2,
      Self::Gazetteer => 3,
      Self::Country => 4,
      Self::Anchored => 5,
      Self::Trigger => 6,
      Self::Signature => 7,
      Self::LegalForm => 8,
      Self::NameCorpus => 9,
      Self::AddressSeed => 10,
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
  stage: DiagnosticStage,
  declared_inputs: &'static [StaticDetectorInput],
  dependencies: &'static [StaticDetectorId],
  support_resources: &'static [SupportResourceId],
}

impl StaticDetectorSpec {
  pub(super) const fn define(
    id: StaticDetectorId,
    stage: DiagnosticStage,
  ) -> Self {
    Self {
      id,
      stage,
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
    self.stage
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

pub(super) type StaticDetectFn = for<'a, 'p, 'd> fn(
  &StaticDetectorContext<'a>,
  &'p StaticEntityPasses,
  StaticDetectorDiagnostics<'d>,
) -> Result<TimedEntities>;

#[derive(Clone, Copy)]
pub(super) struct StaticDetectorRule {
  spec: StaticDetectorSpec,
  detect: StaticDetectFn,
}

impl StaticDetectorRule {
  pub(super) const fn declare(
    spec: StaticDetectorSpec,
    detect: StaticDetectFn,
  ) -> Self {
    Self { spec, detect }
  }

  pub(super) const fn spec(self) -> StaticDetectorSpec {
    self.spec
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
    stage: $stage:expr;
    inputs: $inputs:expr;
    $(after: $dependencies:expr;)?
    $(uses: $resources:expr;)?
    detect: $detect:path $(;)?
  ) => {
    $visibility const $name:
      $crate::prepared::detector_contract::StaticDetectorRule =
      $crate::prepared::detector_contract::StaticDetectorRule::declare(
        $crate::prepared::detector_contract::StaticDetectorSpec::define(
          $id,
          $stage,
        )
          .requires($inputs)
          $(.after($dependencies))?
          $(.uses($resources))?,
        $detect,
      );
  };
}

pub(super) use static_detector_rule;
