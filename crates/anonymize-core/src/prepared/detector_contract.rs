use std::collections::BTreeSet;

use crate::address_seeds::AddressSeedDetection;
use crate::address_seeds::PreparedAddressSeedData;
use crate::dates::PreparedDateData;
use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::legal_forms::PreparedLegalFormData;
use crate::legal_forms::process_legal_form_matches;
use crate::money::PreparedMonetaryData;
use crate::name_corpus::{NameCorpusDetection, PreparedNameCorpusData};
use crate::processors::{
  CountryMatchData, DenyListMatchData, GazetteerMatchData, PatternSlice,
  RegexMatchMeta, process_country_matches, process_deny_list_matches,
  process_gazetteer_matches, process_regex_matches,
};
use crate::resolution::PipelineEntity;
use crate::signatures::{PreparedSignatureData, detect_signatures};
use crate::triggers::{PreparedTriggerData, process_trigger_matches};
use crate::types::{Error, Result, SearchMatch};

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
  TitleTokens,
  SignatureData,
  LegalFormData,
  NameCorpusData,
  AddressSeedData,
  ContextEntities,
  DenyListEntities,
}

impl StaticDetectorInput {
  pub(super) const fn is_growing(self) -> bool {
    matches!(
      self,
      Self::FullText
        | Self::RegexMatches
        | Self::CustomRegexMatches
        | Self::LiteralMatches
        | Self::ContextEntities
        | Self::DenyListEntities
    )
  }

  const fn bit(self) -> u32 {
    match self {
      Self::FullText => 1 << 0,
      Self::RegexMatches => 1 << 1,
      Self::CustomRegexMatches => 1 << 2,
      Self::LiteralMatches => 1 << 3,
      Self::RegexMeta => 1 << 4,
      Self::CustomRegexMeta => 1 << 5,
      Self::DenyListData => 1 << 6,
      Self::GazetteerData => 1 << 7,
      Self::CountryData => 1 << 8,
      Self::DateData => 1 << 9,
      Self::MonetaryData => 1 << 10,
      Self::TriggerData => 1 << 11,
      Self::TitleTokens => 1 << 12,
      Self::SignatureData => 1 << 13,
      Self::LegalFormData => 1 << 14,
      Self::NameCorpusData => 1 << 15,
      Self::AddressSeedData => 1 << 16,
      Self::ContextEntities => 1 << 17,
      Self::DenyListEntities => 1 << 18,
    }
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct StaticDetectorComplexity {
  additive_mask: u32,
  domain_count: u32,
}

impl StaticDetectorComplexity {
  #[allow(clippy::indexing_slicing)]
  pub(super) const fn additive(
    additive_domains: &'static [StaticDetectorInput],
  ) -> Self {
    let mut additive_mask = 0;
    let mut domain_count = 0_u32;
    let mut index = 0;
    while index < additive_domains.len() {
      // SAFETY: the loop condition proves `index` is within the slice.
      additive_mask |= additive_domains[index].bit();
      domain_count = domain_count.saturating_add(1);
      index = index.saturating_add(1);
    }
    Self {
      additive_mask,
      domain_count,
    }
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct StaticDetectorSpec {
  id: StaticDetectorId,
  diagnostic_stage: DiagnosticStage,
  declared_inputs: &'static [StaticDetectorInput],
  dependencies: &'static [StaticDetectorId],
  support_resources: &'static [SupportResourceId],
  complexity: StaticDetectorComplexity,
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
      complexity: StaticDetectorComplexity::additive(&[]),
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

  pub(super) const fn scales_additively_in(
    mut self,
    domains: &'static [StaticDetectorInput],
  ) -> Self {
    self.complexity = StaticDetectorComplexity::additive(domains);
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

  pub(super) fn complexity_covers_growing_inputs(self) -> bool {
    let expected_mask = self
      .declared_inputs
      .iter()
      .copied()
      .filter(|input| input.is_growing())
      .fold(0_u32, |mask, input| mask | input.bit());
    self.complexity.additive_mask == expected_mask
      && self.complexity.domain_count == expected_mask.count_ones()
  }

  pub(super) fn validate_complexity(self) -> Result<()> {
    if self.complexity_covers_growing_inputs() {
      return Ok(());
    }
    Err(Error::InvalidStaticData {
      field: "detector complexity contract",
      reason: format!(
        "detector {:?} must declare each growing input exactly once as an additive scaling domain",
        self.id,
      ),
    })
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

  #[cfg(test)]
  fn require_dependency(self, detector: StaticDetectorId) -> Result<()> {
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

  pub(super) fn regex_is_active(&self) -> Result<bool> {
    Ok(!self.regex_matches()?.is_empty() && !self.regex_meta()?.is_empty())
  }

  pub(super) fn detect_regex(&self) -> Result<Vec<PipelineEntity>> {
    process_regex_matches(
      self.regex_matches()?,
      self.regex_slice()?,
      self.full_text()?,
      self.regex_meta()?,
    )
  }

  pub(super) fn custom_regex_is_active(&self) -> Result<bool> {
    Ok(
      !self.custom_regex_matches()?.is_empty()
        && !self.custom_regex_meta()?.is_empty(),
    )
  }

  pub(super) fn detect_custom_regex(&self) -> Result<Vec<PipelineEntity>> {
    process_regex_matches(
      self.custom_regex_matches()?,
      self.custom_regex_slice()?,
      self.full_text()?,
      self.custom_regex_meta()?,
    )
  }

  pub(super) fn deny_list_is_active(&self) -> Result<bool> {
    Ok(!self.literal_matches()?.is_empty() && self.deny_list_data()?.is_some())
  }

  pub(super) fn detect_deny_list(&self) -> Result<Vec<PipelineEntity>> {
    let Some(data) = self.deny_list_data()? else {
      return Ok(Vec::new());
    };
    process_deny_list_matches(
      self.literal_matches()?,
      self.deny_list_slice()?,
      self.full_text()?,
      data,
    )
  }

  pub(super) fn gazetteer_is_active(&self) -> Result<bool> {
    Ok(!self.literal_matches()?.is_empty() && self.gazetteer_data()?.is_some())
  }

  pub(super) fn detect_gazetteer(&self) -> Result<Vec<PipelineEntity>> {
    let Some(data) = self.gazetteer_data()? else {
      return Ok(Vec::new());
    };
    process_gazetteer_matches(
      self.literal_matches()?,
      self.gazetteer_slice()?,
      self.full_text()?,
      data,
    )
  }

  pub(super) fn country_is_active(&self) -> Result<bool> {
    Ok(!self.literal_matches()?.is_empty() && self.country_data()?.is_some())
  }

  pub(super) fn detect_country(&self) -> Result<Vec<PipelineEntity>> {
    let Some(data) = self.country_data()? else {
      return Ok(Vec::new());
    };
    process_country_matches(
      self.literal_matches()?,
      self.countries_slice()?,
      self.full_text()?,
      data,
    )
  }

  pub(super) fn anchored_is_active(&self) -> Result<bool> {
    Ok(
      self.date_data()?.is_some()
        || (self.monetary_extraction()? && self.monetary_data()?.is_some()),
    )
  }

  pub(super) fn detect_anchored(&self) -> Result<Vec<PipelineEntity>> {
    let mut entities = Vec::new();
    if let Some(data) = self.date_data()? {
      entities.extend(data.process(self.full_text()?)?);
    }
    if self.monetary_extraction()?
      && let Some(data) = self.monetary_data()?
    {
      entities.extend(data.process(self.full_text()?)?);
    }
    Ok(entities)
  }

  pub(super) fn trigger_is_active(&self) -> Result<bool> {
    Ok(!self.regex_matches()?.is_empty() && self.trigger_data()?.is_some())
  }

  pub(super) fn detect_trigger(
    &self,
    diagnostics: StaticDetectorDiagnostics<'_>,
  ) -> Result<Vec<PipelineEntity>> {
    let Some(data) = self.trigger_data()? else {
      return Ok(Vec::new());
    };
    let empty_title_tokens = BTreeSet::new();
    process_trigger_matches(
      self.regex_matches()?,
      self.triggers_slice()?,
      self.full_text()?,
      data,
      self.title_tokens()?.unwrap_or(&empty_title_tokens),
      diagnostics,
    )
  }

  pub(super) fn signature_is_active(&self) -> Result<bool> {
    Ok(self.signature_data()?.is_some())
  }

  pub(super) fn detect_signature(&self) -> Result<Vec<PipelineEntity>> {
    Ok(
      self
        .signature_data()?
        .map_or_else(Vec::new, |data| detect_signatures(self.full_text, data)),
    )
  }

  pub(super) fn legal_form_is_active(&self) -> Result<bool> {
    Ok(!self.regex_matches()?.is_empty() && self.legal_form_data()?.is_some())
  }

  pub(super) fn detect_legal_form(&self) -> Result<Vec<PipelineEntity>> {
    let Some(data) = self.legal_form_data()? else {
      return Ok(Vec::new());
    };
    process_legal_form_matches(
      self.regex_matches()?,
      self.legal_forms_slice()?,
      self.full_text()?,
      data,
    )
  }

  pub(super) fn name_corpus_is_active(&self) -> Result<bool> {
    Ok(self.name_corpus_data()?.is_some())
  }

  pub(super) fn detect_name_corpus(
    &self,
    dependencies: DetectorDependencies<'_>,
  ) -> Result<NameCorpusDetection> {
    let Some(data) = self.name_corpus_data()? else {
      return Ok(NameCorpusDetection::default());
    };
    data.detect_configured_profiled(
      self.full_text()?,
      dependencies.entities(StaticDetectorId::DenyList)?,
    )
  }

  pub(super) fn address_seed_is_active(&self) -> Result<bool> {
    Ok(self.address_seed_data()?.is_some())
  }

  pub(super) fn detect_address_seed(
    &self,
    dependencies: DetectorDependencies<'_>,
  ) -> Result<(AddressSeedDetection, usize)> {
    let Some(data) = self.address_seed_data()? else {
      return Ok((AddressSeedDetection::default(), 0));
    };
    let entities = dependencies.collect();
    let count = entities.len();
    let detection = data.process_profiled(
      self.literal_matches()?,
      self.street_types_slice()?,
      self.full_text()?,
      &entities,
    )?;
    Ok((detection, count))
  }

  pub(super) const fn input_bytes(&self) -> usize {
    self.full_text.len()
  }

  fn full_text(&self) -> Result<&'a str> {
    self.require(StaticDetectorInput::FullText)?;
    Ok(self.full_text)
  }

  fn regex_matches(&self) -> Result<&'a [SearchMatch]> {
    self.require(StaticDetectorInput::RegexMatches)?;
    Ok(&self.matches.regex)
  }

  fn custom_regex_matches(&self) -> Result<&'a [SearchMatch]> {
    self.require(StaticDetectorInput::CustomRegexMatches)?;
    Ok(&self.matches.custom_regex)
  }

  fn literal_matches(&self) -> Result<&'a [SearchMatch]> {
    self.require(StaticDetectorInput::LiteralMatches)?;
    Ok(&self.matches.literal)
  }

  fn regex_meta(&self) -> Result<&'a [RegexMatchMeta]> {
    self.require(StaticDetectorInput::RegexMeta)?;
    Ok(&self.engine.policy.regex_meta)
  }

  fn custom_regex_meta(&self) -> Result<&'a [RegexMatchMeta]> {
    self.require(StaticDetectorInput::CustomRegexMeta)?;
    Ok(&self.engine.policy.custom_regex_meta)
  }

  fn regex_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::RegexMatches)?;
    Ok(self.engine.policy.slices.regex)
  }

  fn custom_regex_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::CustomRegexMatches)?;
    Ok(self.engine.policy.slices.custom_regex)
  }

  fn deny_list_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::DenyListData)?;
    Ok(self.engine.policy.slices.deny_list)
  }

  fn gazetteer_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::GazetteerData)?;
    Ok(self.engine.policy.slices.gazetteer)
  }

  fn countries_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::CountryData)?;
    Ok(self.engine.policy.slices.countries)
  }

  fn triggers_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::TriggerData)?;
    Ok(self.engine.policy.slices.triggers)
  }

  fn legal_forms_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::LegalFormData)?;
    Ok(self.engine.policy.slices.legal_forms)
  }

  fn street_types_slice(&self) -> Result<PatternSlice> {
    self.require(StaticDetectorInput::AddressSeedData)?;
    Ok(self.engine.policy.slices.street_types)
  }

  fn deny_list_data(&self) -> Result<Option<&'a DenyListMatchData>> {
    self.require(StaticDetectorInput::DenyListData)?;
    Ok(self.engine.data.deny_list.as_ref())
  }

  fn gazetteer_data(&self) -> Result<Option<&'a GazetteerMatchData>> {
    self.require(StaticDetectorInput::GazetteerData)?;
    Ok(self.engine.data.gazetteer.as_ref())
  }

  fn country_data(&self) -> Result<Option<&'a CountryMatchData>> {
    self.require(StaticDetectorInput::CountryData)?;
    Ok(self.engine.data.countries.as_ref())
  }

  fn date_data(&self) -> Result<Option<&'a PreparedDateData>> {
    self.require(StaticDetectorInput::DateData)?;
    Ok(self.engine.data.dates.as_ref())
  }

  fn monetary_data(&self) -> Result<Option<&'a PreparedMonetaryData>> {
    self.require(StaticDetectorInput::MonetaryData)?;
    Ok(self.engine.data.monetary.as_ref())
  }

  fn monetary_extraction(&self) -> Result<bool> {
    self.require(StaticDetectorInput::MonetaryData)?;
    Ok(self.engine.policy.monetary_extraction)
  }

  fn trigger_data(&self) -> Result<Option<&'a PreparedTriggerData>> {
    self.require(StaticDetectorInput::TriggerData)?;
    Ok(self.engine.data.triggers.as_ref())
  }

  fn title_tokens(&self) -> Result<Option<&'a BTreeSet<String>>> {
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

  fn signature_data(&self) -> Result<Option<&'a PreparedSignatureData>> {
    self.require(StaticDetectorInput::SignatureData)?;
    Ok(self.engine.data.signatures.as_ref())
  }

  fn legal_form_data(&self) -> Result<Option<&'a PreparedLegalFormData>> {
    self.require(StaticDetectorInput::LegalFormData)?;
    Ok(self.engine.data.legal_forms.as_ref())
  }

  fn name_corpus_data(&self) -> Result<Option<&'a PreparedNameCorpusData>> {
    self.require(StaticDetectorInput::NameCorpusData)?;
    Ok(self.engine.data.name_corpus.as_ref())
  }

  fn address_seed_data(&self) -> Result<Option<&'a PreparedAddressSeedData>> {
    self.require(StaticDetectorInput::AddressSeedData)?;
    Ok(self.engine.data.address_seed.as_ref())
  }

  fn require(&self, input: StaticDetectorInput) -> Result<()> {
    self.spec.require_input(input)
  }
}

#[derive(Clone, Copy)]
pub(super) struct DetectorDependencies<'a> {
  detector: StaticDetectorId,
  declared: &'static [StaticDetectorId],
  passes: &'a StaticEntityPasses,
}

impl<'a> DetectorDependencies<'a> {
  const fn new(
    spec: StaticDetectorSpec,
    passes: &'a StaticEntityPasses,
  ) -> Self {
    Self {
      detector: spec.id(),
      declared: spec.dependencies(),
      passes,
    }
  }

  fn entities(
    self,
    detector: StaticDetectorId,
  ) -> Result<&'a [PipelineEntity]> {
    if !self.declared.contains(&detector) {
      return Err(Error::InvalidStaticData {
        field: "detector rule dependencies",
        reason: format!(
          "detector {:?} accessed undeclared dependency {detector:?}",
          self.detector,
        ),
      });
    }
    Ok(self.passes.entities(detector))
  }

  fn collect(self) -> Vec<PipelineEntity> {
    let dependencies = self.declared;
    let capacity = dependencies
      .iter()
      .map(|detector| self.passes.entities(*detector).len())
      .fold(0usize, usize::saturating_add);
    let mut entities = Vec::with_capacity(capacity);
    for detector in dependencies {
      entities.extend(self.passes.entities(*detector).iter().cloned());
    }
    entities
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
        scales: $scales:expr;
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
            .scales_additively_in($scales)
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

  #[test]
  fn missing_growing_complexity_domain_is_rejected() {
    let result = StaticDetectorSpec::define(
      StaticDetectorId::Regex,
      DiagnosticStage::EntityRegex,
    )
    .requires(&[
      StaticDetectorInput::RegexMatches,
      StaticDetectorInput::FullText,
    ])
    .scales_additively_in(&[StaticDetectorInput::RegexMatches])
    .validate_complexity();
    assert!(result.is_err(), "missing scaling domain must fail closed");
  }

  #[test]
  fn duplicate_complexity_domain_is_rejected() {
    let result = StaticDetectorSpec::define(
      StaticDetectorId::Signature,
      DiagnosticStage::EntitySignature,
    )
    .requires(&[StaticDetectorInput::FullText])
    .scales_additively_in(&[
      StaticDetectorInput::FullText,
      StaticDetectorInput::FullText,
    ])
    .validate_complexity();
    assert!(result.is_err(), "duplicate scaling domain must fail closed");
  }
}
