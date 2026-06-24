use crate::normalize::normalize_for_search;
use crate::processors::{
  CountryMatchData, GazetteerMatchData, PatternSlice, RegexMatchMeta,
  process_country_matches, process_gazetteer_matches, process_regex_matches,
};
use crate::redact::redact_text;
use crate::resolution::{
  PipelineEntity, enforce_boundary_consistency, merge_and_dedup,
  sanitize_entities,
};
use crate::search::{SearchIndex, SearchOptions, SearchPattern};
use crate::types::{
  Entity, EntityKind, OperatorConfig, RedactionResult, Result, SearchMatch,
};

pub struct PreparedSearch {
  regex: SearchIndex,
  custom_regex: SearchIndex,
  literals: SearchIndex,
  slices: PreparedSearchSlices,
  regex_meta: Vec<RegexMatchMeta>,
  custom_regex_meta: Vec<RegexMatchMeta>,
  gazetteer_data: Option<GazetteerMatchData>,
  country_data: Option<CountryMatchData>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PreparedSearchSlices {
  pub regex: PatternSlice,
  pub custom_regex: PatternSlice,
  pub legal_forms: PatternSlice,
  pub triggers: PatternSlice,
  pub deny_list: PatternSlice,
  pub street_types: PatternSlice,
  pub gazetteer: PatternSlice,
  pub countries: PatternSlice,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedSearchConfig {
  pub regex_patterns: Vec<SearchPattern>,
  pub custom_regex_patterns: Vec<SearchPattern>,
  pub literal_patterns: Vec<SearchPattern>,
  pub regex_options: SearchOptions,
  pub custom_regex_options: SearchOptions,
  pub literal_options: SearchOptions,
  pub slices: PreparedSearchSlices,
  pub regex_meta: Vec<RegexMatchMeta>,
  pub custom_regex_meta: Vec<RegexMatchMeta>,
  pub gazetteer_data: Option<GazetteerMatchData>,
  pub country_data: Option<CountryMatchData>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedSearchMatches {
  pub regex: Vec<SearchMatch>,
  pub custom_regex: Vec<SearchMatch>,
  pub literal: Vec<SearchMatch>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StaticDetectionResult {
  pub matches: PreparedSearchMatches,
  pub regex_entities: Vec<PipelineEntity>,
  pub custom_regex_entities: Vec<PipelineEntity>,
  pub gazetteer_entities: Vec<PipelineEntity>,
  pub country_entities: Vec<PipelineEntity>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StaticRedactionResult {
  pub detections: StaticDetectionResult,
  pub resolved_entities: Vec<PipelineEntity>,
  pub redaction: RedactionResult,
}

impl PreparedSearch {
  pub fn new(config: PreparedSearchConfig) -> Result<Self> {
    Ok(Self {
      regex: SearchIndex::new(config.regex_patterns, config.regex_options)?,
      custom_regex: SearchIndex::new(
        config.custom_regex_patterns,
        config.custom_regex_options,
      )?,
      literals: SearchIndex::new(
        config.literal_patterns,
        config.literal_options,
      )?,
      slices: config.slices,
      regex_meta: config.regex_meta,
      custom_regex_meta: config.custom_regex_meta,
      gazetteer_data: config.gazetteer_data,
      country_data: config.country_data,
    })
  }

  pub fn find_matches(&self, full_text: &str) -> Result<PreparedSearchMatches> {
    let normalized = normalize_for_search(full_text);

    Ok(PreparedSearchMatches {
      regex: self.regex.find_iter(full_text)?,
      custom_regex: self.custom_regex.find_iter(full_text)?,
      literal: self.literals.find_iter(&normalized)?,
    })
  }

  pub fn detect_static_entities(
    &self,
    full_text: &str,
  ) -> Result<StaticDetectionResult> {
    let matches = self.find_matches(full_text)?;
    let regex_entities = process_regex_matches(
      &matches.regex,
      self.slices.regex,
      full_text,
      &self.regex_meta,
    )?;
    let custom_regex_entities = process_regex_matches(
      &matches.custom_regex,
      self.slices.custom_regex,
      full_text,
      &self.custom_regex_meta,
    )?;
    let gazetteer_entities = if let Some(data) = &self.gazetteer_data {
      process_gazetteer_matches(
        &matches.literal,
        self.slices.gazetteer,
        full_text,
        data,
      )?
    } else {
      Vec::new()
    };
    let country_entities = if let Some(data) = &self.country_data {
      process_country_matches(
        &matches.literal,
        self.slices.countries,
        full_text,
        data,
      )?
    } else {
      Vec::new()
    };

    Ok(StaticDetectionResult {
      matches,
      regex_entities,
      custom_regex_entities,
      gazetteer_entities,
      country_entities,
    })
  }

  pub fn redact_static_entities(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
  ) -> Result<StaticRedactionResult> {
    let detections = self.detect_static_entities(full_text)?;
    let raw_entities = detections.all_entities();
    let merged = merge_and_dedup(&raw_entities);
    let consistent = enforce_boundary_consistency(&merged, full_text)?;
    let resolved_entities = sanitize_entities(&consistent);
    let redaction_entities = resolved_entities
      .iter()
      .map(to_redaction_entity)
      .collect::<Vec<_>>();
    let redaction = redact_text(full_text, &redaction_entities, operators)?;

    Ok(StaticRedactionResult {
      detections,
      resolved_entities,
      redaction,
    })
  }
}

impl StaticDetectionResult {
  #[must_use]
  pub fn all_entities(&self) -> Vec<PipelineEntity> {
    let capacity = self
      .regex_entities
      .len()
      .saturating_add(self.custom_regex_entities.len())
      .saturating_add(self.gazetteer_entities.len())
      .saturating_add(self.country_entities.len());
    let mut entities = Vec::with_capacity(capacity);
    entities.extend(self.regex_entities.iter().cloned());
    entities.extend(self.custom_regex_entities.iter().cloned());
    entities.extend(self.gazetteer_entities.iter().cloned());
    entities.extend(self.country_entities.iter().cloned());
    entities
  }
}

fn to_redaction_entity(entity: &PipelineEntity) -> Entity {
  match &entity.kind {
    EntityKind::Detected => Entity::detected(
      entity.start,
      entity.end,
      entity.label.clone(),
      entity.text.clone(),
    ),
    EntityKind::Coreference { source_text } => Entity::coreference(
      entity.start,
      entity.end,
      entity.label.clone(),
      entity.text.clone(),
      source_text.clone(),
    ),
  }
}
