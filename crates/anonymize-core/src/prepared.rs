use std::time::Instant;

use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::normalize::normalize_for_search_with_byte_map;
use crate::processors::{
  CountryMatchData, DenyListMatchData, GazetteerMatchData, PatternSlice,
  RegexMatchMeta, ensure_supported_deny_list_sources, process_country_matches,
  process_deny_list_matches, process_gazetteer_matches, process_regex_matches,
};
use crate::redact::redact_text;
use crate::resolution::{
  PipelineEntity, enforce_boundary_consistency, merge_and_dedup,
  sanitize_entities_with_source,
};
use crate::search::{SearchIndex, SearchOptions, SearchPattern};
use crate::types::{
  Entity, EntityKind, Error, OperatorConfig, RedactionResult, Result,
  SearchMatch,
};

pub struct PreparedSearch {
  regex: SearchIndex,
  custom_regex: SearchIndex,
  literals: SearchIndex,
  slices: PreparedSearchSlices,
  regex_meta: Vec<RegexMatchMeta>,
  custom_regex_meta: Vec<RegexMatchMeta>,
  deny_list_data: Option<DenyListMatchData>,
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
  pub deny_list_data: Option<DenyListMatchData>,
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
  pub deny_list_entities: Vec<PipelineEntity>,
  pub gazetteer_entities: Vec<PipelineEntity>,
  pub country_entities: Vec<PipelineEntity>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StaticRedactionResult {
  pub detections: StaticDetectionResult,
  pub resolved_entities: Vec<PipelineEntity>,
  pub redaction: RedactionResult,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StaticRedactionDiagnosticResult {
  pub result: StaticRedactionResult,
  pub diagnostics: StaticRedactionDiagnostics,
}

pub struct PreparedSearchBuildResult {
  pub prepared: PreparedSearch,
  pub diagnostics: StaticRedactionDiagnostics,
}

impl PreparedSearch {
  pub fn new(config: PreparedSearchConfig) -> Result<Self> {
    Self::new_inner(config, None)
  }

  pub fn new_with_diagnostics(
    config: PreparedSearchConfig,
  ) -> Result<PreparedSearchBuildResult> {
    let mut diagnostics = StaticRedactionDiagnostics::default();
    let prepared = Self::new_inner(config, Some(&mut diagnostics))?;

    Ok(PreparedSearchBuildResult {
      prepared,
      diagnostics,
    })
  }

  fn new_inner(
    config: PreparedSearchConfig,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<Self> {
    let total_start = Instant::now();
    validate_supported_config(&config)?;
    let regex_len = config.regex_patterns.len();
    let custom_regex_len = config.custom_regex_patterns.len();
    let literal_len = config.literal_patterns.len();

    let regex_start = Instant::now();
    let regex = SearchIndex::new(config.regex_patterns, config.regex_options)?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_stage(
        DiagnosticStage::PrepareRegex,
        Some(regex_len),
        Some(elapsed_us(regex_start)),
        None,
      );
    }

    let custom_regex_start = Instant::now();
    let custom_regex = SearchIndex::new(
      config.custom_regex_patterns,
      config.custom_regex_options,
    )?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_stage(
        DiagnosticStage::PrepareCustomRegex,
        Some(custom_regex_len),
        Some(elapsed_us(custom_regex_start)),
        None,
      );
    }

    let literal_start = Instant::now();
    let literals =
      SearchIndex::new(config.literal_patterns, config.literal_options)?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_stage(
        DiagnosticStage::PrepareLiteral,
        Some(literal_len),
        Some(elapsed_us(literal_start)),
        None,
      );
      diagnostics.record_stage(
        DiagnosticStage::PrepareTotal,
        Some(
          regex_len
            .saturating_add(custom_regex_len)
            .saturating_add(literal_len),
        ),
        Some(elapsed_us(total_start)),
        None,
      );
    }

    Ok(Self {
      regex,
      custom_regex,
      literals,
      slices: config.slices,
      regex_meta: config.regex_meta,
      custom_regex_meta: config.custom_regex_meta,
      deny_list_data: config.deny_list_data,
      gazetteer_data: config.gazetteer_data,
      country_data: config.country_data,
    })
  }

  pub fn find_matches(&self, full_text: &str) -> Result<PreparedSearchMatches> {
    self.find_matches_inner(full_text, None)
  }

  fn find_matches_inner(
    &self,
    full_text: &str,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<PreparedSearchMatches> {
    let total_start = Instant::now();
    let normalize_start = Instant::now();
    let normalized = normalize_for_search_with_byte_map(full_text)?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_stage(
        DiagnosticStage::Normalize,
        None,
        Some(elapsed_us(normalize_start)),
        Some(full_text.len()),
      );
    }

    let regex_start = Instant::now();
    let regex = self.regex.find_iter(full_text)?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_search_matches(
        DiagnosticStage::SearchRegex,
        &regex,
        full_text,
        Some(elapsed_us(regex_start)),
      );
    }

    let custom_regex_start = Instant::now();
    let custom_regex = self.custom_regex.find_iter(full_text)?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_search_matches(
        DiagnosticStage::SearchCustomRegex,
        &custom_regex,
        full_text,
        Some(elapsed_us(custom_regex_start)),
      );
    }

    let literal_start = Instant::now();
    let literal = self
      .literals
      .find_iter(normalized.as_str())?
      .into_iter()
      .map(|found| remap_normalized_match(&normalized, found))
      .collect::<Result<Vec<_>>>()?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_search_matches(
        DiagnosticStage::SearchLiteral,
        &literal,
        full_text,
        Some(elapsed_us(literal_start)),
      );
      diagnostics.record_stage(
        DiagnosticStage::FindMatches,
        Some(
          regex
            .len()
            .saturating_add(custom_regex.len())
            .saturating_add(literal.len()),
        ),
        Some(elapsed_us(total_start)),
        Some(full_text.len()),
      );
    }

    Ok(PreparedSearchMatches {
      regex,
      custom_regex,
      literal,
    })
  }

  pub fn detect_static_entities(
    &self,
    full_text: &str,
  ) -> Result<StaticDetectionResult> {
    self.detect_static_entities_inner(full_text, None)
  }

  fn detect_static_entities_inner(
    &self,
    full_text: &str,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<StaticDetectionResult> {
    let matches =
      self.find_matches_inner(full_text, diagnostics.as_deref_mut())?;

    let regex_start = Instant::now();
    let regex_entities = process_regex_matches(
      &matches.regex,
      self.slices.regex,
      full_text,
      &self.regex_meta,
    )?;
    let regex_elapsed_us = elapsed_us(regex_start);

    let custom_regex_start = Instant::now();
    let custom_regex_entities = process_regex_matches(
      &matches.custom_regex,
      self.slices.custom_regex,
      full_text,
      &self.custom_regex_meta,
    )?;
    let custom_regex_elapsed_us = elapsed_us(custom_regex_start);

    let deny_list_start = Instant::now();
    let deny_list_entities = if let Some(data) = &self.deny_list_data {
      process_deny_list_matches(
        &matches.literal,
        self.slices.deny_list,
        full_text,
        data,
      )?
    } else {
      Vec::new()
    };
    let deny_list_elapsed_us = elapsed_us(deny_list_start);

    let gazetteer_start = Instant::now();
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
    let gazetteer_elapsed_us = elapsed_us(gazetteer_start);

    let country_start = Instant::now();
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
    let country_elapsed_us = elapsed_us(country_start);

    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_entities(
        DiagnosticStage::EntityRegex,
        &regex_entities,
        full_text,
        Some(regex_elapsed_us),
      );
      diagnostics.record_entities(
        DiagnosticStage::EntityCustomRegex,
        &custom_regex_entities,
        full_text,
        Some(custom_regex_elapsed_us),
      );
      diagnostics.record_entities(
        DiagnosticStage::EntityDenyList,
        &deny_list_entities,
        full_text,
        Some(deny_list_elapsed_us),
      );
      diagnostics.record_entities(
        DiagnosticStage::EntityGazetteer,
        &gazetteer_entities,
        full_text,
        Some(gazetteer_elapsed_us),
      );
      diagnostics.record_entities(
        DiagnosticStage::EntityCountry,
        &country_entities,
        full_text,
        Some(country_elapsed_us),
      );
    }

    Ok(StaticDetectionResult {
      matches,
      regex_entities,
      custom_regex_entities,
      deny_list_entities,
      gazetteer_entities,
      country_entities,
    })
  }

  pub fn redact_static_entities(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
  ) -> Result<StaticRedactionResult> {
    self.redact_static_entities_inner(full_text, operators, None)
  }

  pub fn redact_static_entities_with_diagnostics(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
  ) -> Result<StaticRedactionDiagnosticResult> {
    let mut diagnostics = StaticRedactionDiagnostics::default();
    let result = self.redact_static_entities_inner(
      full_text,
      operators,
      Some(&mut diagnostics),
    )?;

    Ok(StaticRedactionDiagnosticResult {
      result,
      diagnostics,
    })
  }

  fn redact_static_entities_inner(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<StaticRedactionResult> {
    let detections = self
      .detect_static_entities_inner(full_text, diagnostics.as_deref_mut())?;
    let raw_entities = detections.all_entities();
    let merge_start = Instant::now();
    let merged = merge_and_dedup(&raw_entities);
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_entities(
        DiagnosticStage::Merge,
        &merged,
        full_text,
        Some(elapsed_us(merge_start)),
      );
    }
    let boundary_start = Instant::now();
    let consistent = enforce_boundary_consistency(&merged, full_text)?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_entities(
        DiagnosticStage::Boundary,
        &consistent,
        full_text,
        Some(elapsed_us(boundary_start)),
      );
    }
    let sanitize_start = Instant::now();
    let resolved_entities =
      sanitize_entities_with_source(&consistent, full_text)?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_entities(
        DiagnosticStage::Sanitize,
        &resolved_entities,
        full_text,
        Some(elapsed_us(sanitize_start)),
      );
    }
    let redaction_entities = resolved_entities
      .iter()
      .map(to_redaction_entity)
      .collect::<Vec<_>>();
    let redaction_start = Instant::now();
    let redaction = redact_text(full_text, &redaction_entities, operators)?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_redaction(
        &redaction,
        Some(elapsed_us(redaction_start)),
        full_text.len(),
      );
    }

    Ok(StaticRedactionResult {
      detections,
      resolved_entities,
      redaction,
    })
  }
}

fn elapsed_us(start: Instant) -> u64 {
  let micros = start.elapsed().as_micros();
  u64::try_from(micros).unwrap_or(u64::MAX)
}

fn remap_normalized_match(
  normalized: &crate::normalize::NormalizedSearchText,
  found: SearchMatch,
) -> Result<SearchMatch> {
  let (start, end) = normalized.map_span(found.start(), found.end())?;
  Ok(found.with_span(start, end))
}

fn validate_supported_config(config: &PreparedSearchConfig) -> Result<()> {
  reject_unsupported_slice(config.slices.legal_forms, "legal_forms")?;
  reject_unsupported_slice(config.slices.triggers, "triggers")?;
  validate_deny_list_config(config)?;
  reject_unsupported_slice(config.slices.street_types, "street_types")
}

const fn reject_unsupported_slice(
  slice: PatternSlice,
  name: &'static str,
) -> Result<()> {
  if slice.is_empty() {
    return Ok(());
  }

  Err(Error::UnsupportedStaticSlice { slice: name })
}

fn validate_deny_list_config(config: &PreparedSearchConfig) -> Result<()> {
  if config.slices.deny_list.is_empty() {
    return Ok(());
  }

  let Some(data) = &config.deny_list_data else {
    return Err(Error::UnsupportedStaticSlice { slice: "deny_list" });
  };

  validate_static_data_length(
    "deny_list.labels",
    config.slices.deny_list,
    data.labels.len(),
  )?;
  validate_static_data_length(
    "deny_list.custom_labels",
    config.slices.deny_list,
    data.custom_labels.len(),
  )?;
  validate_static_data_length(
    "deny_list.originals",
    config.slices.deny_list,
    data.originals.len(),
  )?;
  validate_static_data_length(
    "deny_list.sources",
    config.slices.deny_list,
    data.sources.len(),
  )?;
  ensure_supported_deny_list_sources(data)
}

fn validate_static_data_length(
  field: &'static str,
  slice: PatternSlice,
  actual: usize,
) -> Result<()> {
  let expected = usize::try_from(slice.len()).map_err(|_| {
    Error::StaticDataLengthMismatch {
      field,
      expected: usize::MAX,
      actual,
    }
  })?;
  if actual == expected {
    return Ok(());
  }

  Err(Error::StaticDataLengthMismatch {
    field,
    expected,
    actual,
  })
}

impl StaticDetectionResult {
  #[must_use]
  pub fn all_entities(&self) -> Vec<PipelineEntity> {
    let capacity = self
      .regex_entities
      .len()
      .saturating_add(self.custom_regex_entities.len())
      .saturating_add(self.deny_list_entities.len())
      .saturating_add(self.gazetteer_entities.len())
      .saturating_add(self.country_entities.len());
    let mut entities = Vec::with_capacity(capacity);
    entities.extend(self.regex_entities.iter().cloned());
    entities.extend(self.custom_regex_entities.iter().cloned());
    entities.extend(self.deny_list_entities.iter().cloned());
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
