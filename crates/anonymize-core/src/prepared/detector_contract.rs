use std::collections::BTreeSet;

use crate::address_seeds::PreparedAddressSeedData;
use crate::dates::PreparedDateData;
use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::legal_forms::PreparedLegalFormData;
use crate::money::PreparedMonetaryData;
use crate::name_corpus::PreparedNameCorpusData;
use crate::processors::{
  CountryMatchData, DenyListMatchData, GazetteerMatchData, PatternSlice,
  RegexMatchMeta,
};
use crate::signatures::PreparedSignatureData;
use crate::triggers::PreparedTriggerData;
use crate::types::{Error, Result, SearchMatch};

use super::PreparedEngine;
use super::results::PreparedEngineMatches;
use super::support_resources::SupportResourceId;
use super::timing::{DetectorDependencies, StaticEntityPasses, TimedEntities};

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
  TitleTokens,
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
  diagnostic_stage: DiagnosticStage,
  declared_inputs: &'static [StaticDetectorInput],
  dependencies: &'static [StaticDetectorId],
  support_resources: &'static [SupportResourceId],
}

impl StaticDetectorSpec {
  pub(super) const fn define(
    id: StaticDetectorId,
    diagnostic_stage: DiagnosticStage,
  ) -> Self {
    Self {
      id,
      diagnostic_stage,
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
    self.diagnostic_stage
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

  fn require_input(self, input: StaticDetectorInput) -> Result<()> {
    if self.declares_input(input) {
      return Ok(());
    }
    Err(Error::InvalidStaticData {
      field: "detector rule inputs",
      reason: format!(
        "detector {:?} accessed undeclared input {input:?}",
        self.id,
      ),
    })
  }

  pub(super) fn require_dependency(
    self,
    detector: StaticDetectorId,
  ) -> Result<()> {
    if self.dependencies.contains(&detector) {
      return Ok(());
    }
    Err(Error::InvalidStaticData {
      field: "detector rule dependencies",
      reason: format!(
        "detector {:?} accessed undeclared dependency {detector:?}",
        self.id,
      ),
    })
  }
}

pub(super) struct StaticDetectorContext<'a> {
  spec: StaticDetectorSpec,
  engine: &'a PreparedEngine,
  matches: &'a PreparedEngineMatches,
  full_text: &'a str,
}

impl<'a> StaticDetectorContext<'a> {
  pub(super) const fn new(
    spec: StaticDetectorSpec,
    engine: &'a PreparedEngine,
    matches: &'a PreparedEngineMatches,
    full_text: &'a str,
  ) -> Self {
    Self {
      spec,
      engine,
      matches,
      full_text,
    }
  }

  pub(super) fn full_text(&self) -> Result<&'a str> {
    self.require(StaticDetectorInput::FullText)?;
    Ok(self.full_text)
  }

  pub(super) fn regex_matches(&self) -> Result<&'a [SearchMatch]> {
    self.require(StaticDetectorInput::RegexMatches)?;
    Ok(&self.matches.regex)
  }

  pub(super) fn custom_regex_matches(&self) -> Result<&'a [SearchMatch]> {
    self.require(StaticDetectorInput::CustomRegexMatches)?;
    Ok(&self.matches.custom_regex)
  }

  pub(super) fn literal_matches(&self) -> Result<&'a [SearchMatch]> {
    self.require(StaticDetectorInput::LiteralMatches)?;
    Ok(&self.matches.literal)
  }

  pub(super) fn regex_meta(&self) -> Result<&'a [RegexMatchMeta]> {
    self.require(StaticDetectorInput::RegexMeta)?;
    Ok(&self.engine.policy.regex_meta)
  }

  pub(super) fn custom_regex_meta(&self) -> Result<&'a [RegexMatchMeta]> {
    self.require(StaticDetectorInput::CustomRegexMeta)?;
    Ok(&self.engine.policy.custom_regex_meta)
  }

  pub(super) fn regex_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::RegexMatches)?;
    Ok(self.engine.policy.slices.regex)
  }

  pub(super) fn custom_regex_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::CustomRegexMatches)?;
    Ok(self.engine.policy.slices.custom_regex)
  }

  pub(super) fn deny_list_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::DenyListData)?;
    Ok(self.engine.policy.slices.deny_list)
  }

  pub(super) fn gazetteer_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::GazetteerData)?;
    Ok(self.engine.policy.slices.gazetteer)
  }

  pub(super) fn countries_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::CountryData)?;
    Ok(self.engine.policy.slices.countries)
  }

  pub(super) fn triggers_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::TriggerData)?;
    Ok(self.engine.policy.slices.triggers)
  }

  pub(super) fn legal_forms_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::LegalFormData)?;
    Ok(self.engine.policy.slices.legal_forms)
  }

  pub(super) fn street_types_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::AddressSeedData)?;
    Ok(self.engine.policy.slices.street_types)
  }

  pub(super) fn deny_list_data(&self) -> Result<Option<&'a DenyListMatchData>> {
    self.require(StaticDetectorInput::DenyListData)?;
    Ok(self.engine.data.deny_list.as_ref())
  }

  pub(super) fn gazetteer_data(
    &self,
  ) -> Result<Option<&'a GazetteerMatchData>> {
    self.require(StaticDetectorInput::GazetteerData)?;
    Ok(self.engine.data.gazetteer.as_ref())
  }

  pub(super) fn country_data(&self) -> Result<Option<&'a CountryMatchData>> {
    self.require(StaticDetectorInput::CountryData)?;
    Ok(self.engine.data.countries.as_ref())
  }

  pub(super) fn date_data(&self) -> Result<Option<&'a PreparedDateData>> {
    self.require(StaticDetectorInput::DateData)?;
    Ok(self.engine.data.dates.as_ref())
  }

  pub(super) fn monetary_data(
    &self,
  ) -> Result<Option<&'a PreparedMonetaryData>> {
    self.require(StaticDetectorInput::MonetaryData)?;
    Ok(self.engine.data.monetary.as_ref())
  }

  pub(super) fn monetary_extraction(&self) -> Result<bool> {
    self.require(StaticDetectorInput::MonetaryData)?;
    Ok(self.engine.policy.monetary_extraction)
  }

  pub(super) fn trigger_data(&self) -> Result<Option<&'a PreparedTriggerData>> {
    self.require(StaticDetectorInput::TriggerData)?;
    Ok(self.engine.data.triggers.as_ref())
  }

  pub(super) fn title_tokens(&self) -> Result<Option<&'a BTreeSet<String>>> {
    self.require(StaticDetectorInput::TitleTokens)?;
    Ok(
      self
        .engine
        .data
        .false_positive_filters
        .as_ref()
        .map(|filters| &filters.title_tokens),
    )
  }

  pub(super) fn signature_data(
    &self,
  ) -> Result<Option<&'a PreparedSignatureData>> {
    self.require(StaticDetectorInput::SignatureData)?;
    Ok(self.engine.data.signatures.as_ref())
  }

  pub(super) fn legal_form_data(
    &self,
  ) -> Result<Option<&'a PreparedLegalFormData>> {
    self.require(StaticDetectorInput::LegalFormData)?;
    Ok(self.engine.data.legal_forms.as_ref())
  }

  pub(super) fn name_corpus_data(
    &self,
  ) -> Result<Option<&'a PreparedNameCorpusData>> {
    self.require(StaticDetectorInput::NameCorpusData)?;
    Ok(self.engine.data.name_corpus.as_ref())
  }

  pub(super) fn address_seed_data(
    &self,
  ) -> Result<Option<&'a PreparedAddressSeedData>> {
    self.require(StaticDetectorInput::AddressSeedData)?;
    Ok(self.engine.data.address_seed.as_ref())
  }

  fn require(&self, input: StaticDetectorInput) -> Result<()> {
    self.spec.require_input(input)
  }
}

pub(super) type StaticDetectorDiagnostics<'d> =
  Option<&'d mut StaticRedactionDiagnostics>;

pub(super) type StaticDetectorActiveFn =
  for<'a> fn(&StaticDetectorContext<'a>) -> Result<bool>;

pub(super) type StaticDetectFn = for<'a, 'p, 'd> fn(
  &StaticDetectorContext<'a>,
  DetectorDependencies<'p>,
  StaticDetectorDiagnostics<'d>,
) -> Result<TimedEntities>;

#[derive(Clone, Copy)]
pub(super) struct StaticDetectorModule {
  name: &'static str,
  rules: &'static [StaticDetectorRule],
}

impl StaticDetectorModule {
  pub(super) const fn declare(
    name: &'static str,
    rules: &'static [StaticDetectorRule],
  ) -> Self {
    Self { name, rules }
  }

  pub(super) const fn name(self) -> &'static str {
    self.name
  }

  pub(super) const fn rules(self) -> &'static [StaticDetectorRule] {
    self.rules
  }

  pub(super) const fn is_empty(self) -> bool {
    self.rules.is_empty()
  }
}

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

  pub(super) fn is_active(
    self,
    context: &StaticDetectorContext<'_>,
  ) -> Result<bool> {
    (self.is_active)(context)
  }

  pub(super) fn detect(
    self,
    context: &StaticDetectorContext<'_>,
    passes: &StaticEntityPasses,
    diagnostics: StaticDetectorDiagnostics<'_>,
  ) -> Result<TimedEntities> {
    (self.detect)(
      context,
      DetectorDependencies::new(self.spec, passes),
      diagnostics,
    )
  }
}

macro_rules! static_detector_rules {
  (
    $visibility:vis const $rules_name:ident;
    $(
      $rule_name:ident {
        id: $id:expr;
        stage: $stage:expr;
        inputs: $inputs:expr;
        $(after: $dependencies:expr;)?
        $(uses: $resources:expr;)?
        active: $is_active:path;
        detect: $detect:path $(;)?
      }
    )+
  ) => {
    $(
      $visibility const $rule_name:
        $crate::prepared::detector_contract::StaticDetectorRule =
        $crate::prepared::detector_contract::StaticDetectorRule::declare(
          $crate::prepared::detector_contract::StaticDetectorSpec::define(
            $id,
            $stage,
          )
            .requires($inputs)
            $(.after($dependencies))?
            $(.uses($resources))?,
          $is_active,
          $detect,
        );
    )+

    $visibility const $rules_name:
      &[$crate::prepared::detector_contract::StaticDetectorRule] =
      &[$($rule_name),+];
  };
}

macro_rules! static_detector_modules {
  (
    $visibility:vis const $modules_name:ident;
    $(
      mod $module:ident;
    )+
  ) => {
    $(mod $module;)+

    $visibility const $modules_name:
      &[$crate::prepared::detector_contract::StaticDetectorModule] =
      &[
        $(
          $crate::prepared::detector_contract::StaticDetectorModule::declare(
            stringify!($module),
            $module::RULES,
          ),
        )+
      ];
  };
}

pub(super) use static_detector_modules;
pub(super) use static_detector_rules;

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn undeclared_input_access_is_rejected() {
    let result = StaticDetectorSpec::define(
      StaticDetectorId::Regex,
      DiagnosticStage::EntityRegex,
    )
    .requires(&[StaticDetectorInput::RegexMatches])
    .require_input(StaticDetectorInput::FullText);
    assert!(result.is_err(), "undeclared input must fail closed");
    let Some(error) = result.err() else {
      return;
    };
    assert!(error.to_string().contains("undeclared input FullText"));
  }

  #[test]
  fn undeclared_dependency_access_is_rejected() {
    let result = StaticDetectorSpec::define(
      StaticDetectorId::NameCorpus,
      DiagnosticStage::EntityNameCorpus,
    )
    .require_dependency(StaticDetectorId::DenyList);
    assert!(result.is_err(), "undeclared dependency must fail closed");
    let Some(error) = result.err() else {
      return;
    };
    assert!(error.to_string().contains("undeclared dependency DenyList"));
  }
}
