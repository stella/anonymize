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
  required_inputs: &'static [StaticDetectorInput],
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
      required_inputs: &[],
      dependencies: &[],
      support_resources: &[],
    }
  }

  pub(super) const fn requires(
    mut self,
    required_inputs: &'static [StaticDetectorInput],
  ) -> Self {
    self.required_inputs = required_inputs;
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

  pub(super) const fn required_inputs(self) -> &'static [StaticDetectorInput] {
    self.required_inputs
  }

  pub(super) const fn dependencies(self) -> &'static [StaticDetectorId] {
    self.dependencies
  }

  pub(super) const fn support_resources(self) -> &'static [SupportResourceId] {
    self.support_resources
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
