use std::time::Instant;

use crate::address_context::{AddressContextData, PreparedAddressContextData};
use crate::address_seeds::{AddressSeedData, PreparedAddressSeedData};
use crate::artifact_bytes::{ArtifactReader, ArtifactWriter};
use crate::byte_offsets::ByteOffsets;
use crate::dates::{DateData, PreparedDateData};
use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::false_positives::filter_entity_false_positives;
use crate::hotwords::{HotwordRuleData, apply_hotword_rules};
use crate::legal_forms::{
  LegalFormData, PreparedLegalFormData, process_legal_form_matches,
};
use crate::money::{MonetaryData, PreparedMonetaryData};
use crate::normalize::{
  NormalizedSearchText, normalize_for_search_with_byte_map,
};
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
use crate::search::{
  LiteralSearchOptions, SearchIndex, SearchIndexArtifacts, SearchOptions,
  SearchPattern,
};
use crate::signatures::detect_signatures;
use crate::triggers::{
  PreparedTriggerData, TriggerData, process_trigger_matches,
};
use crate::types::{
  Entity, EntityKind, Error, OperatorConfig, RedactionResult, Result,
  SearchMatch,
};

const PREPARED_SEARCH_ARTIFACTS_HEADER: [u8; 8] = *b"ANONPSR1";
const PREPARED_SEARCH_ARTIFACTS_VERSION: u32 = 1;
const NEAR_MISS_BAND: f64 = 0.15;
const BOOST_PER_NEIGHBOUR: f64 = 0.05;
const CONTEXT_WINDOW_CHARS: f64 = 150.0;
const HIGH_CONFIDENCE_FLOOR: f64 = 0.9;

pub struct PreparedSearch {
  regex: SearchIndex,
  custom_regex: SearchIndex,
  legal_forms: SearchIndex,
  triggers: SearchIndex,
  literals: SearchIndex,
  allowed_labels: Vec<String>,
  threshold: f64,
  confidence_boost: bool,
  slices: PreparedSearchSlices,
  regex_meta: Vec<RegexMatchMeta>,
  custom_regex_meta: Vec<RegexMatchMeta>,
  deny_list_data: Option<DenyListMatchData>,
  gazetteer_data: Option<GazetteerMatchData>,
  country_data: Option<CountryMatchData>,
  hotword_data: Option<HotwordRuleData>,
  trigger_data: Option<PreparedTriggerData>,
  legal_form_data: Option<PreparedLegalFormData>,
  address_seed_data: Option<PreparedAddressSeedData>,
  address_context_data: Option<PreparedAddressContextData>,
  date_data: Option<PreparedDateData>,
  monetary_data: Option<PreparedMonetaryData>,
}

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct PreparedSearchSlices {
  pub regex: PatternSlice,
  pub custom_regex: PatternSlice,
  pub legal_forms: PatternSlice,
  pub triggers: PatternSlice,
  pub deny_list: PatternSlice,
  pub street_types: PatternSlice,
  pub gazetteer: PatternSlice,
  pub countries: PatternSlice,
  pub hotwords: PatternSlice,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct PreparedSearchConfig {
  pub regex_patterns: Vec<SearchPattern>,
  pub custom_regex_patterns: Vec<SearchPattern>,
  pub literal_patterns: Vec<SearchPattern>,
  pub regex_options: SearchOptions,
  pub custom_regex_options: SearchOptions,
  pub literal_options: SearchOptions,
  #[serde(default)]
  pub allowed_labels: Vec<String>,
  #[serde(default)]
  pub threshold: f64,
  #[serde(default)]
  pub confidence_boost: bool,
  pub slices: PreparedSearchSlices,
  pub regex_meta: Vec<RegexMatchMeta>,
  pub custom_regex_meta: Vec<RegexMatchMeta>,
  pub deny_list_data: Option<DenyListMatchData>,
  pub gazetteer_data: Option<GazetteerMatchData>,
  pub country_data: Option<CountryMatchData>,
  #[serde(default)]
  pub hotword_data: Option<HotwordRuleData>,
  pub trigger_data: Option<TriggerData>,
  pub legal_form_data: Option<LegalFormData>,
  pub address_seed_data: Option<AddressSeedData>,
  #[serde(default)]
  pub address_context_data: Option<AddressContextData>,
  pub date_data: Option<DateData>,
  pub monetary_data: Option<MonetaryData>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PreparedSearchArtifacts {
  pub regex: SearchIndexArtifacts,
  pub custom_regex: SearchIndexArtifacts,
  pub legal_forms: SearchIndexArtifacts,
  pub triggers: SearchIndexArtifacts,
  pub literals: SearchIndexArtifacts,
}

impl PreparedSearchArtifacts {
  pub fn to_bytes(&self) -> Result<Vec<u8>> {
    let mut writer = ArtifactWriter::new(
      PREPARED_SEARCH_ARTIFACTS_HEADER,
      PREPARED_SEARCH_ARTIFACTS_VERSION,
    );
    write_index_artifacts(&mut writer, "prepared.regex", &self.regex)?;
    write_index_artifacts(
      &mut writer,
      "prepared.custom_regex",
      &self.custom_regex,
    )?;
    write_index_artifacts(
      &mut writer,
      "prepared.legal_forms",
      &self.legal_forms,
    )?;
    write_index_artifacts(&mut writer, "prepared.triggers", &self.triggers)?;
    write_index_artifacts(&mut writer, "prepared.literals", &self.literals)?;
    Ok(writer.into_bytes())
  }

  pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
    let mut reader = ArtifactReader::new(
      bytes,
      PREPARED_SEARCH_ARTIFACTS_HEADER,
      PREPARED_SEARCH_ARTIFACTS_VERSION,
      "prepared_search_artifacts",
    )?;
    let artifacts = Self {
      regex: read_index_artifacts(&mut reader)?,
      custom_regex: read_index_artifacts(&mut reader)?,
      legal_forms: read_index_artifacts(&mut reader)?,
      triggers: read_index_artifacts(&mut reader)?,
      literals: read_index_artifacts(&mut reader)?,
    };
    reader.finish()?;
    Ok(artifacts)
  }
}

fn write_index_artifacts(
  writer: &mut ArtifactWriter,
  field: &'static str,
  artifacts: &SearchIndexArtifacts,
) -> Result<()> {
  writer.write_len_prefixed_bytes(field, &artifacts.to_bytes()?)
}

fn read_index_artifacts(
  reader: &mut ArtifactReader<'_>,
) -> Result<SearchIndexArtifacts> {
  SearchIndexArtifacts::from_bytes(reader.read_len_prefixed_bytes()?)
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
  pub anchored_entities: Vec<PipelineEntity>,
  pub trigger_entities: Vec<PipelineEntity>,
  pub signature_entities: Vec<PipelineEntity>,
  pub legal_form_entities: Vec<PipelineEntity>,
  pub address_seed_entities: Vec<PipelineEntity>,
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

struct TimedEntities {
  entities: Vec<PipelineEntity>,
  elapsed_us: u64,
}

struct StaticEntityPasses {
  regex: TimedEntities,
  custom_regex: TimedEntities,
  deny_list: TimedEntities,
  gazetteer: TimedEntities,
  country: TimedEntities,
  anchored: TimedEntities,
  trigger: TimedEntities,
  signature: TimedEntities,
  legal_form: TimedEntities,
  address_seed: TimedEntities,
}

pub struct PreparedSearchBuildResult {
  pub prepared: PreparedSearch,
  pub diagnostics: StaticRedactionDiagnostics,
}

struct RegexPatternGroups {
  regex: Vec<SearchPattern>,
  legal_forms: Vec<SearchPattern>,
  triggers: Vec<SearchPattern>,
}

type TimedSearchIndex = (SearchIndex, u64);

struct PreparedSearchIndexes {
  regex: TimedSearchIndex,
  custom_regex: TimedSearchIndex,
  legal_forms: TimedSearchIndex,
  triggers: TimedSearchIndex,
  literals: TimedSearchIndex,
}

struct SearchIndexBuildInputs {
  regex_patterns: Vec<SearchPattern>,
  regex_options: SearchOptions,
  custom_regex_patterns: Vec<SearchPattern>,
  custom_regex_options: SearchOptions,
  legal_form_patterns: Vec<SearchPattern>,
  trigger_patterns: Vec<SearchPattern>,
  literal_patterns: Vec<SearchPattern>,
  literal_options: SearchOptions,
}

#[derive(Clone, Copy)]
struct SearchIndexPrepareMetrics {
  regex: (usize, u64),
  custom_regex: (usize, u64),
  legal_forms: (usize, u64),
  triggers: (usize, u64),
  literals: (usize, u64),
}

impl PreparedSearch {
  pub fn new(config: PreparedSearchConfig) -> Result<Self> {
    Self::new_inner(config, None, None)
  }

  pub fn prepare_artifacts(
    config: PreparedSearchConfig,
  ) -> Result<PreparedSearchArtifacts> {
    validate_supported_config(&config, false)?;
    let regex_groups =
      split_regex_patterns(config.regex_patterns, &config.slices)?;
    Ok(PreparedSearchArtifacts {
      regex: SearchIndex::prepare_artifacts(
        regex_groups.regex,
        config.regex_options,
      )?,
      custom_regex: SearchIndex::prepare_artifacts(
        config.custom_regex_patterns,
        config.custom_regex_options,
      )?,
      legal_forms: SearchIndex::prepare_artifacts(
        regex_groups.legal_forms,
        legal_form_search_options(),
      )?,
      triggers: SearchIndex::prepare_artifacts(
        promote_case_insensitive_literals(regex_groups.triggers),
        trigger_search_options(),
      )?,
      literals: SearchIndex::prepare_artifacts(
        config.literal_patterns,
        config.literal_options,
      )?,
    })
  }

  pub fn new_with_artifacts(
    config: PreparedSearchConfig,
    artifacts: &PreparedSearchArtifacts,
  ) -> Result<Self> {
    Self::new_inner(config, None, Some(artifacts))
  }

  pub fn new_with_artifacts_diagnostics(
    config: PreparedSearchConfig,
    artifacts: &PreparedSearchArtifacts,
  ) -> Result<PreparedSearchBuildResult> {
    let mut diagnostics = StaticRedactionDiagnostics::default();
    let prepared =
      Self::new_inner(config, Some(&mut diagnostics), Some(artifacts))?;

    Ok(PreparedSearchBuildResult {
      prepared,
      diagnostics,
    })
  }

  pub fn new_with_diagnostics(
    config: PreparedSearchConfig,
  ) -> Result<PreparedSearchBuildResult> {
    let mut diagnostics = StaticRedactionDiagnostics::default();
    let prepared = Self::new_inner(config, Some(&mut diagnostics), None)?;

    Ok(PreparedSearchBuildResult {
      prepared,
      diagnostics,
    })
  }

  fn new_inner(
    config: PreparedSearchConfig,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
    artifacts: Option<&PreparedSearchArtifacts>,
  ) -> Result<Self> {
    let total_start = Instant::now();
    let allow_literal_artifacts =
      artifacts.is_some_and(|artifacts| !artifacts.literals.slots.is_empty());
    validate_supported_config(&config, allow_literal_artifacts)?;
    let slices = config.slices.clone();
    let allowed_labels = config.allowed_labels.clone();
    let threshold = config.threshold;
    let confidence_boost = config.confidence_boost;
    let regex_groups = split_regex_patterns(config.regex_patterns, &slices)?;
    let regex_len = regex_groups.regex.len();
    let custom_regex_len = config.custom_regex_patterns.len();
    let anchored_len = anchored_config_len(
      config.date_data.as_ref(),
      config.monetary_data.as_ref(),
    );
    let legal_form_len = regex_groups.legal_forms.len();
    let trigger_len = regex_groups.triggers.len();

    let (date_data, monetary_data) = prepare_anchored_data(
      config.date_data.as_ref(),
      config.monetary_data,
      anchored_len,
      diagnostics.as_deref_mut(),
    )?;

    let indexes = build_search_indexes_for_config(
      regex_groups,
      config.regex_options,
      config.custom_regex_patterns,
      config.custom_regex_options,
      config.literal_patterns,
      config.literal_options,
      artifacts,
    )?;
    let (
      (regex, regex_elapsed),
      (custom_regex, custom_regex_elapsed),
      (legal_forms, legal_forms_elapsed),
      (triggers, triggers_elapsed),
      (literals, literals_elapsed),
    ) = (
      indexes.regex,
      indexes.custom_regex,
      indexes.legal_forms,
      indexes.triggers,
      indexes.literals,
    );
    let literal_len = literals.len();
    record_search_index_prepare_stages(
      &mut diagnostics,
      &SearchIndexPrepareMetrics {
        regex: (regex_len, regex_elapsed),
        custom_regex: (custom_regex_len, custom_regex_elapsed),
        legal_forms: (legal_form_len, legal_forms_elapsed),
        triggers: (trigger_len, triggers_elapsed),
        literals: (literal_len, literals_elapsed),
      },
    );
    record_prepare_total(
      &mut diagnostics,
      [
        regex_len,
        custom_regex_len,
        anchored_len,
        legal_form_len,
        trigger_len,
        literal_len,
      ],
      total_start,
    );

    Ok(Self {
      regex,
      custom_regex,
      legal_forms,
      triggers,
      literals,
      allowed_labels,
      threshold,
      confidence_boost,
      slices,
      regex_meta: config.regex_meta,
      custom_regex_meta: config.custom_regex_meta,
      deny_list_data: config.deny_list_data,
      gazetteer_data: config.gazetteer_data,
      country_data: config.country_data,
      hotword_data: config.hotword_data,
      trigger_data: config
        .trigger_data
        .map(PreparedTriggerData::new)
        .transpose()?,
      legal_form_data: config.legal_form_data.map(PreparedLegalFormData::new),
      address_seed_data: prepare_address_seed_data(config.address_seed_data)?,
      address_context_data: prepare_address_context_data(
        config.address_context_data,
      )?,
      date_data,
      monetary_data,
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
    let regex = offset_matches(
      self.regex.find_iter(full_text)?,
      self.slices.regex.start,
    )?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_search_matches(
        DiagnosticStage::SearchRegex,
        &regex,
        full_text,
        Some(elapsed_us(regex_start)),
      );
    }

    let legal_form_start = Instant::now();
    let legal_forms = normalized_offset_matches(
      &self.legal_forms,
      &normalized,
      self.slices.legal_forms.start,
    )?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_search_matches(
        DiagnosticStage::SearchLegalForm,
        &legal_forms,
        full_text,
        Some(elapsed_us(legal_form_start)),
      );
    }

    let trigger_start = Instant::now();
    let triggers = offset_matches(
      self.triggers.find_iter(full_text)?,
      self.slices.triggers.start,
    )?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_search_matches(
        DiagnosticStage::SearchTrigger,
        &triggers,
        full_text,
        Some(elapsed_us(trigger_start)),
      );
    }

    let custom_regex_start = Instant::now();
    let custom_regex = offset_matches(
      self.custom_regex.find_iter(full_text)?,
      self.slices.custom_regex.start,
    )?;
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
    let regex = combine_regex_matches(regex, legal_forms, triggers);
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
    let passes = self.process_static_entity_passes(
      &matches,
      full_text,
      diagnostics.as_deref_mut(),
    )?;

    if let Some(diagnostics) = &mut diagnostics {
      record_static_entity_diagnostics(diagnostics, full_text, &passes);
    }

    Ok(StaticDetectionResult {
      matches,
      regex_entities: passes.regex.entities,
      custom_regex_entities: passes.custom_regex.entities,
      deny_list_entities: passes.deny_list.entities,
      gazetteer_entities: passes.gazetteer.entities,
      country_entities: passes.country.entities,
      anchored_entities: passes.anchored.entities,
      trigger_entities: passes.trigger.entities,
      signature_entities: passes.signature.entities,
      legal_form_entities: passes.legal_form.entities,
      address_seed_entities: passes.address_seed.entities,
    })
  }

  fn process_static_entity_passes(
    &self,
    matches: &PreparedSearchMatches,
    full_text: &str,
    diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<StaticEntityPasses> {
    let regex_start = Instant::now();
    let regex = TimedEntities {
      entities: process_regex_matches(
        &matches.regex,
        self.slices.regex,
        full_text,
        &self.regex_meta,
      )?,
      elapsed_us: elapsed_us(regex_start),
    };

    let custom_regex_start = Instant::now();
    let custom_regex = TimedEntities {
      entities: process_regex_matches(
        &matches.custom_regex,
        self.slices.custom_regex,
        full_text,
        &self.custom_regex_meta,
      )?,
      elapsed_us: elapsed_us(custom_regex_start),
    };

    let deny_list_start = Instant::now();
    let deny_list = TimedEntities {
      entities: if let Some(data) = &self.deny_list_data {
        process_deny_list_matches(
          &matches.literal,
          self.slices.deny_list,
          full_text,
          data,
        )?
      } else {
        Vec::new()
      },
      elapsed_us: elapsed_us(deny_list_start),
    };

    let gazetteer_start = Instant::now();
    let gazetteer = TimedEntities {
      entities: if let Some(data) = &self.gazetteer_data {
        process_gazetteer_matches(
          &matches.literal,
          self.slices.gazetteer,
          full_text,
          data,
        )?
      } else {
        Vec::new()
      },
      elapsed_us: elapsed_us(gazetteer_start),
    };

    let country = self.process_country_entities(matches, full_text)?;

    let anchored = self.process_anchored_entities(full_text)?;

    let trigger =
      self.process_trigger_entities(matches, full_text, diagnostics)?;

    let signature = process_signature_entities(full_text);

    let legal_form = self.process_legal_form_entities(matches, full_text)?;

    let address_seed = self.process_address_seed_entities(
      matches,
      full_text,
      &[
        &regex.entities,
        &custom_regex.entities,
        &anchored.entities,
        &trigger.entities,
        &signature.entities,
        &legal_form.entities,
        &deny_list.entities,
        &gazetteer.entities,
      ],
    )?;

    Ok(StaticEntityPasses {
      regex,
      custom_regex,
      deny_list,
      gazetteer,
      country,
      anchored,
      trigger,
      signature,
      legal_form,
      address_seed,
    })
  }

  fn process_anchored_entities(
    &self,
    full_text: &str,
  ) -> Result<TimedEntities> {
    let anchored_start = Instant::now();
    let mut entities = Vec::new();
    if let Some(data) = &self.date_data {
      entities.extend(data.process(full_text)?);
    }
    if let Some(data) = &self.monetary_data {
      entities.extend(data.process(full_text)?);
    }

    Ok(TimedEntities {
      entities,
      elapsed_us: elapsed_us(anchored_start),
    })
  }

  fn process_trigger_entities(
    &self,
    matches: &PreparedSearchMatches,
    full_text: &str,
    diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<TimedEntities> {
    let start = Instant::now();
    let entities = if let Some(data) = &self.trigger_data {
      process_trigger_matches(
        &matches.regex,
        self.slices.triggers,
        full_text,
        data,
        diagnostics,
      )?
    } else {
      Vec::new()
    };

    Ok(TimedEntities {
      entities,
      elapsed_us: elapsed_us(start),
    })
  }

  fn process_legal_form_entities(
    &self,
    matches: &PreparedSearchMatches,
    full_text: &str,
  ) -> Result<TimedEntities> {
    let start = Instant::now();
    let entities = if let Some(data) = &self.legal_form_data {
      process_legal_form_matches(
        &matches.regex,
        self.slices.legal_forms,
        full_text,
        data,
      )?
    } else {
      Vec::new()
    };

    Ok(TimedEntities {
      entities,
      elapsed_us: elapsed_us(start),
    })
  }

  fn process_address_seed_entities(
    &self,
    matches: &PreparedSearchMatches,
    full_text: &str,
    context_layers: &[&[PipelineEntity]],
  ) -> Result<TimedEntities> {
    let start = Instant::now();
    let entities = if let Some(data) = &self.address_seed_data {
      let existing_entities = address_seed_context(context_layers);
      data.process(
        &matches.literal,
        self.slices.street_types,
        full_text,
        &existing_entities,
      )?
    } else {
      Vec::new()
    };

    Ok(TimedEntities {
      entities,
      elapsed_us: elapsed_us(start),
    })
  }

  fn process_country_entities(
    &self,
    matches: &PreparedSearchMatches,
    full_text: &str,
  ) -> Result<TimedEntities> {
    let country_start = Instant::now();
    Ok(TimedEntities {
      entities: if let Some(data) = &self.country_data {
        process_country_matches(
          &matches.literal,
          self.slices.countries,
          full_text,
          data,
        )?
      } else {
        Vec::new()
      },
      elapsed_us: elapsed_us(country_start),
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
    let pre_threshold_entities = self.apply_hotword_entities(
      detections.all_entities(),
      full_text,
      &detections.matches.literal,
    )?;
    let mut raw_entities = filter_entities_for_redaction(
      pre_threshold_entities,
      full_text,
      self.threshold,
      self.confidence_boost,
      &self.allowed_labels,
    )?;
    let address_context_start = Instant::now();
    let address_context_entities =
      self.process_address_context_entities(full_text, &raw_entities)?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_entities(
        DiagnosticStage::EntityAddressContext,
        &address_context_entities,
        full_text,
        Some(elapsed_us(address_context_start)),
      );
    }
    raw_entities.extend(address_context_entities);
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
    let sanitized_entities =
      sanitize_entities_with_source(&consistent, full_text)?;
    let resolved_entities = filter_entities_for_config(
      filter_entity_false_positives(
        sanitized_entities,
        full_text,
        self
          .deny_list_data
          .as_ref()
          .and_then(|data| data.filters.as_ref()),
      )?,
      self.threshold,
      &self.allowed_labels,
    );
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

  fn apply_hotword_entities(
    &self,
    entities: Vec<PipelineEntity>,
    full_text: &str,
    literal_matches: &[SearchMatch],
  ) -> Result<Vec<PipelineEntity>> {
    let Some(data) = &self.hotword_data else {
      return Ok(entities);
    };
    apply_hotword_rules(
      entities,
      full_text,
      literal_matches,
      self.slices.hotwords,
      data,
      &self.allowed_labels,
    )
  }

  fn process_address_context_entities(
    &self,
    full_text: &str,
    existing_entities: &[PipelineEntity],
  ) -> Result<Vec<PipelineEntity>> {
    if !label_is_allowed("address", &self.allowed_labels) {
      return Ok(Vec::new());
    }
    let Some(data) = &self.address_context_data else {
      return Ok(Vec::new());
    };
    data.process(full_text, existing_entities)
  }
}

fn process_signature_entities(full_text: &str) -> TimedEntities {
  let start = Instant::now();
  TimedEntities {
    entities: detect_signatures(full_text),
    elapsed_us: elapsed_us(start),
  }
}

fn filter_entities_for_config(
  entities: Vec<PipelineEntity>,
  threshold: f64,
  allowed_labels: &[String],
) -> Vec<PipelineEntity> {
  filter_entities_for_threshold(
    filter_entities_for_labels(entities, allowed_labels),
    threshold,
  )
}

fn filter_entities_for_redaction(
  entities: Vec<PipelineEntity>,
  full_text: &str,
  threshold: f64,
  confidence_boost: bool,
  allowed_labels: &[String],
) -> Result<Vec<PipelineEntity>> {
  let entities = filter_entities_for_labels(entities, allowed_labels);
  if confidence_boost {
    return boost_near_miss_entities(entities, full_text, threshold);
  }
  Ok(filter_entities_for_threshold(entities, threshold))
}

fn filter_entities_for_labels(
  entities: Vec<PipelineEntity>,
  allowed_labels: &[String],
) -> Vec<PipelineEntity> {
  entities
    .into_iter()
    .filter(|entity| {
      allowed_labels.is_empty()
        || allowed_labels.iter().any(|label| label == &entity.label)
    })
    .collect()
}

fn label_is_allowed(label: &str, allowed_labels: &[String]) -> bool {
  allowed_labels.is_empty()
    || allowed_labels.iter().any(|allowed| allowed == label)
}

fn filter_entities_for_threshold(
  entities: Vec<PipelineEntity>,
  threshold: f64,
) -> Vec<PipelineEntity> {
  entities
    .into_iter()
    .filter(|entity| entity.score >= threshold)
    .collect()
}

fn boost_near_miss_entities(
  entities: Vec<PipelineEntity>,
  full_text: &str,
  threshold: f64,
) -> Result<Vec<PipelineEntity>> {
  let near_miss_floor = f64::max(0.0, threshold - NEAR_MISS_BAND);
  let byte_offsets = ByteOffsets::new(full_text);
  let text_offsets = TextOffsetMap::new(full_text);
  let anchors = entities
    .iter()
    .filter(|entity| entity.score >= HIGH_CONFIDENCE_FLOOR)
    .map(|entity| entity_midpoint(entity, &byte_offsets, &text_offsets))
    .collect::<Result<Vec<_>>>()?;

  let mut boosted = Vec::with_capacity(entities.len());
  for mut entity in entities {
    if entity.score >= threshold {
      boosted.push(entity);
      continue;
    }
    if entity.score < near_miss_floor {
      continue;
    }

    let midpoint = entity_midpoint(&entity, &byte_offsets, &text_offsets)?;
    let neighbours = anchors
      .iter()
      .filter(|anchor| (midpoint - **anchor).abs() <= CONTEXT_WINDOW_CHARS)
      .count();
    let neighbour_count = u32::try_from(neighbours).unwrap_or(u32::MAX);
    let boosted_score =
      f64::from(neighbour_count).mul_add(BOOST_PER_NEIGHBOUR, entity.score);
    if boosted_score < threshold {
      continue;
    }

    entity.score = f64::min(1.0, boosted_score);
    boosted.push(entity);
  }

  Ok(boosted)
}

fn entity_midpoint(
  entity: &PipelineEntity,
  byte_offsets: &ByteOffsets<'_>,
  text_offsets: &TextOffsetMap,
) -> Result<f64> {
  let start = text_offsets.offset_for(byte_offsets, entity.start)?;
  let end = text_offsets.offset_for(byte_offsets, entity.end)?;
  Ok(f64::midpoint(start, end))
}

struct TextOffsetMap {
  byte_offsets: Vec<usize>,
}

impl TextOffsetMap {
  fn new(full_text: &str) -> Self {
    let mut byte_offsets = full_text
      .char_indices()
      .map(|(byte_offset, _)| byte_offset)
      .collect::<Vec<_>>();
    byte_offsets.push(full_text.len());
    Self { byte_offsets }
  }

  fn offset_for(
    &self,
    byte_offsets: &ByteOffsets<'_>,
    offset: u32,
  ) -> Result<f64> {
    let byte_offset = byte_offsets.validate_offset(offset)?;
    let index = self
      .byte_offsets
      .binary_search(&byte_offset)
      .map_err(|_| Error::ByteOffsetInsideCodepoint { offset })?;
    let index = u32::try_from(index)
      .map_err(|_| Error::ByteOffsetOutOfBounds { offset: u32::MAX })?;
    Ok(f64::from(index))
  }
}

fn record_static_entity_diagnostics(
  diagnostics: &mut StaticRedactionDiagnostics,
  full_text: &str,
  passes: &StaticEntityPasses,
) {
  diagnostics.record_entities(
    DiagnosticStage::EntityRegex,
    &passes.regex.entities,
    full_text,
    Some(passes.regex.elapsed_us),
  );
  diagnostics.record_entities(
    DiagnosticStage::EntityCustomRegex,
    &passes.custom_regex.entities,
    full_text,
    Some(passes.custom_regex.elapsed_us),
  );
  diagnostics.record_entities(
    DiagnosticStage::EntityDenyList,
    &passes.deny_list.entities,
    full_text,
    Some(passes.deny_list.elapsed_us),
  );
  diagnostics.record_entities(
    DiagnosticStage::EntityGazetteer,
    &passes.gazetteer.entities,
    full_text,
    Some(passes.gazetteer.elapsed_us),
  );
  diagnostics.record_entities(
    DiagnosticStage::EntityCountry,
    &passes.country.entities,
    full_text,
    Some(passes.country.elapsed_us),
  );
  diagnostics.record_entities(
    DiagnosticStage::EntityAnchored,
    &passes.anchored.entities,
    full_text,
    Some(passes.anchored.elapsed_us),
  );
  diagnostics.record_entities(
    DiagnosticStage::EntityTrigger,
    &passes.trigger.entities,
    full_text,
    Some(passes.trigger.elapsed_us),
  );
  diagnostics.record_entities(
    DiagnosticStage::EntitySignature,
    &passes.signature.entities,
    full_text,
    Some(passes.signature.elapsed_us),
  );
  diagnostics.record_entities(
    DiagnosticStage::EntityLegalForm,
    &passes.legal_form.entities,
    full_text,
    Some(passes.legal_form.elapsed_us),
  );
  diagnostics.record_entities(
    DiagnosticStage::EntityAddressSeed,
    &passes.address_seed.entities,
    full_text,
    Some(passes.address_seed.elapsed_us),
  );
}

fn address_seed_context(layers: &[&[PipelineEntity]]) -> Vec<PipelineEntity> {
  let capacity = layers
    .iter()
    .map(|layer| layer.len())
    .fold(0usize, usize::saturating_add);
  let mut entities = Vec::with_capacity(capacity);
  for layer in layers {
    entities.extend(layer.iter().cloned());
  }
  entities
}

fn elapsed_us(start: Instant) -> u64 {
  let micros = start.elapsed().as_micros();
  u64::try_from(micros).unwrap_or(u64::MAX)
}

fn build_search_indexes_for_config(
  regex_groups: RegexPatternGroups,
  regex_options: SearchOptions,
  custom_regex_patterns: Vec<SearchPattern>,
  custom_regex_options: SearchOptions,
  literal_patterns: Vec<SearchPattern>,
  literal_options: SearchOptions,
  artifacts: Option<&PreparedSearchArtifacts>,
) -> Result<PreparedSearchIndexes> {
  build_search_indexes(
    SearchIndexBuildInputs {
      regex_patterns: regex_groups.regex,
      regex_options,
      custom_regex_patterns,
      custom_regex_options,
      legal_form_patterns: regex_groups.legal_forms,
      trigger_patterns: promote_case_insensitive_literals(
        regex_groups.triggers,
      ),
      literal_patterns,
      literal_options,
    },
    artifacts,
  )
}

fn build_search_indexes(
  inputs: SearchIndexBuildInputs,
  artifacts: Option<&PreparedSearchArtifacts>,
) -> Result<PreparedSearchIndexes> {
  let SearchIndexBuildInputs {
    regex_patterns,
    regex_options,
    custom_regex_patterns,
    custom_regex_options,
    legal_form_patterns,
    trigger_patterns,
    literal_patterns,
    literal_options,
  } = inputs;

  let regex_artifacts = artifacts.map(|value| &value.regex);
  let custom_regex_artifacts = artifacts.map(|value| &value.custom_regex);
  let legal_form_artifacts = artifacts.map(|value| &value.legal_forms);
  let trigger_artifacts = artifacts.map(|value| &value.triggers);
  let literal_artifacts = artifacts.map(|value| &value.literals);

  std::thread::scope(|scope| {
    let regex = scope.spawn(move || {
      build_search_index(regex_patterns, regex_options, regex_artifacts)
    });
    let custom_regex = scope.spawn(move || {
      build_search_index(
        custom_regex_patterns,
        custom_regex_options,
        custom_regex_artifacts,
      )
    });
    let legal_forms = scope.spawn(move || {
      build_search_index(
        legal_form_patterns,
        legal_form_search_options(),
        legal_form_artifacts,
      )
    });
    let triggers = scope.spawn(move || {
      build_search_index(
        trigger_patterns,
        trigger_search_options(),
        trigger_artifacts,
      )
    });
    let literals = scope.spawn(move || {
      build_search_index(literal_patterns, literal_options, literal_artifacts)
    });

    Ok(PreparedSearchIndexes {
      regex: join_search_index(regex, "regex")?,
      custom_regex: join_search_index(custom_regex, "custom_regex")?,
      legal_forms: join_search_index(legal_forms, "legal_forms")?,
      triggers: join_search_index(triggers, "triggers")?,
      literals: join_search_index(literals, "literals")?,
    })
  })
}

fn build_search_index(
  patterns: Vec<SearchPattern>,
  options: SearchOptions,
  artifacts: Option<&SearchIndexArtifacts>,
) -> Result<TimedSearchIndex> {
  let start = Instant::now();
  let search = if let Some(artifacts) = artifacts {
    SearchIndex::new_with_artifacts(patterns, options, artifacts)?
  } else {
    SearchIndex::new(patterns, options)?
  };
  Ok((search, elapsed_us(start)))
}

fn join_search_index(
  handle: std::thread::ScopedJoinHandle<'_, Result<TimedSearchIndex>>,
  field: &'static str,
) -> Result<TimedSearchIndex> {
  handle.join().map_err(|_| Error::InvalidStaticData {
    field,
    reason: "search index builder panicked".to_owned(),
  })?
}

fn record_prepare_stage_elapsed(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  stage: DiagnosticStage,
  count: usize,
  elapsed_us: u64,
) {
  if let Some(diagnostics) = diagnostics {
    diagnostics.record_stage(stage, Some(count), Some(elapsed_us), None);
  }
}

fn record_search_index_prepare_stages(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  metrics: &SearchIndexPrepareMetrics,
) {
  let stages = [
    (DiagnosticStage::PrepareRegex, metrics.regex),
    (DiagnosticStage::PrepareCustomRegex, metrics.custom_regex),
    (DiagnosticStage::PrepareLegalFormSearch, metrics.legal_forms),
    (DiagnosticStage::PrepareTriggerSearch, metrics.triggers),
    (DiagnosticStage::PrepareLiteral, metrics.literals),
  ];
  for (stage, (count, elapsed)) in stages {
    record_prepare_stage_elapsed(diagnostics, stage, count, elapsed);
  }
}

fn record_prepare_total(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  counts: [usize; 6],
  start: Instant,
) {
  let Some(diagnostics) = diagnostics else {
    return;
  };
  let count = counts.into_iter().fold(0usize, usize::saturating_add);
  diagnostics.record_stage(
    DiagnosticStage::PrepareTotal,
    Some(count),
    Some(elapsed_us(start)),
    None,
  );
}

fn anchored_config_len(
  date_data: Option<&DateData>,
  monetary_data: Option<&MonetaryData>,
) -> usize {
  let date_len = date_data.map_or(0, |data| {
    data.month_names_by_language.values().map(Vec::len).sum()
  });
  let monetary_len = monetary_data.map_or(0, |data| {
    data
      .currencies
      .codes
      .len()
      .saturating_add(data.currencies.symbols.len())
      .saturating_add(data.currencies.local_names.len())
  });
  date_len.saturating_add(monetary_len)
}

fn prepare_anchored_data(
  date_data: Option<&DateData>,
  monetary_data: Option<MonetaryData>,
  anchored_len: usize,
  diagnostics: Option<&mut StaticRedactionDiagnostics>,
) -> Result<(Option<PreparedDateData>, Option<PreparedMonetaryData>)> {
  let anchored_start = Instant::now();
  let prepared_date = if let Some(data) = date_data {
    PreparedDateData::new(data)?
  } else {
    None
  };
  let prepared_monetary = if let Some(data) = monetary_data {
    PreparedMonetaryData::new(data)?
  } else {
    None
  };

  if let Some(diagnostics) = diagnostics {
    diagnostics.record_stage(
      DiagnosticStage::PrepareAnchored,
      Some(anchored_len),
      Some(elapsed_us(anchored_start)),
      None,
    );
  }

  Ok((prepared_date, prepared_monetary))
}

fn prepare_address_seed_data(
  data: Option<AddressSeedData>,
) -> Result<Option<PreparedAddressSeedData>> {
  data.map(PreparedAddressSeedData::new).transpose()
}

fn prepare_address_context_data(
  data: Option<AddressContextData>,
) -> Result<Option<PreparedAddressContextData>> {
  data.map(PreparedAddressContextData::new).transpose()
}

fn split_regex_patterns(
  patterns: Vec<SearchPattern>,
  slices: &PreparedSearchSlices,
) -> Result<RegexPatternGroups> {
  let mut regex = Vec::new();
  let mut legal_forms = Vec::new();
  let mut triggers = Vec::new();

  for (index, pattern) in patterns.into_iter().enumerate() {
    let pattern_index = u32::try_from(index)
      .map_err(|_| Error::PatternIndexOutOfRange { index })?;
    if slices.legal_forms.contains(pattern_index) {
      legal_forms.push(pattern);
      continue;
    }
    if slices.triggers.contains(pattern_index) {
      triggers.push(pattern);
      continue;
    }
    regex.push(pattern);
  }

  Ok(RegexPatternGroups {
    regex,
    legal_forms,
    triggers,
  })
}

fn legal_form_search_options() -> SearchOptions {
  SearchOptions::default()
}

fn trigger_search_options() -> SearchOptions {
  SearchOptions {
    literal: LiteralSearchOptions {
      case_insensitive: true,
      whole_words: false,
    },
    ..SearchOptions::default()
  }
}

fn promote_case_insensitive_literals(
  patterns: Vec<SearchPattern>,
) -> Vec<SearchPattern> {
  patterns
    .into_iter()
    .map(|entry| match entry {
      SearchPattern::LiteralWithOptions {
        pattern: value,
        case_insensitive: Some(true),
        whole_words,
      } if whole_words != Some(true) => SearchPattern::Literal(value),
      other => other,
    })
    .collect()
}

fn offset_matches(
  matches: Vec<SearchMatch>,
  offset: u32,
) -> Result<Vec<SearchMatch>> {
  if offset == 0 {
    return Ok(matches);
  }

  matches
    .into_iter()
    .map(|found| offset_match(found, offset))
    .collect()
}

fn normalized_offset_matches(
  search: &SearchIndex,
  normalized: &NormalizedSearchText,
  offset: u32,
) -> Result<Vec<SearchMatch>> {
  search
    .find_iter(normalized.as_str())?
    .into_iter()
    .map(|found| remap_normalized_match(normalized, found))
    .map(|found| found.and_then(|value| offset_match(value, offset)))
    .collect()
}

fn offset_match(found: SearchMatch, offset: u32) -> Result<SearchMatch> {
  let pattern = found.pattern().checked_add(offset).ok_or_else(|| {
    Error::PatternIndexNotAddressable {
      pattern: found.pattern(),
    }
  })?;

  Ok(match found {
    SearchMatch::Literal { start, end, .. } => SearchMatch::Literal {
      pattern,
      start,
      end,
    },
    SearchMatch::Regex { start, end, .. } => SearchMatch::Regex {
      pattern,
      start,
      end,
    },
    SearchMatch::Fuzzy {
      start,
      end,
      distance,
      ..
    } => SearchMatch::Fuzzy {
      pattern,
      start,
      end,
      distance,
    },
  })
}

fn combine_regex_matches(
  mut regex: Vec<SearchMatch>,
  legal_forms: Vec<SearchMatch>,
  triggers: Vec<SearchMatch>,
) -> Vec<SearchMatch> {
  regex.extend(legal_forms);
  regex.extend(triggers);
  sort_matches(&mut regex);
  regex
}

fn sort_matches(matches: &mut [SearchMatch]) {
  matches.sort_by(|left, right| {
    left
      .start()
      .cmp(&right.start())
      .then_with(|| left.end().cmp(&right.end()))
      .then_with(|| left.pattern().cmp(&right.pattern()))
  });
}

fn remap_normalized_match(
  normalized: &NormalizedSearchText,
  found: SearchMatch,
) -> Result<SearchMatch> {
  let (start, end) = normalized.map_span(found.start(), found.end())?;
  Ok(found.with_span(start, end))
}

fn validate_supported_config(
  config: &PreparedSearchConfig,
  allow_literal_artifacts: bool,
) -> Result<()> {
  validate_search_config(config, allow_literal_artifacts)?;
  validate_legal_form_config(config)?;
  validate_trigger_config(config)?;
  validate_deny_list_config(config)?;
  validate_gazetteer_config(config)?;
  validate_country_config(config)?;
  validate_hotword_config(config)?;
  validate_address_seed_config(config)
}

fn validate_search_config(
  config: &PreparedSearchConfig,
  allow_literal_artifacts: bool,
) -> Result<()> {
  validate_slice_bounds(
    "slices.regex",
    config.slices.regex,
    config.regex_patterns.len(),
  )?;
  validate_slice_bounds(
    "slices.legal_forms",
    config.slices.legal_forms,
    config.regex_patterns.len(),
  )?;
  validate_slice_bounds(
    "slices.triggers",
    config.slices.triggers,
    config.regex_patterns.len(),
  )?;
  validate_slice_bounds(
    "slices.custom_regex",
    config.slices.custom_regex,
    config.custom_regex_patterns.len(),
  )?;
  if !allow_literal_artifacts || !config.literal_patterns.is_empty() {
    validate_slice_bounds(
      "slices.deny_list",
      config.slices.deny_list,
      config.literal_patterns.len(),
    )?;
    validate_slice_bounds(
      "slices.street_types",
      config.slices.street_types,
      config.literal_patterns.len(),
    )?;
    validate_slice_bounds(
      "slices.gazetteer",
      config.slices.gazetteer,
      config.literal_patterns.len(),
    )?;
    validate_slice_bounds(
      "slices.countries",
      config.slices.countries,
      config.literal_patterns.len(),
    )?;
    validate_slice_bounds(
      "slices.hotwords",
      config.slices.hotwords,
      config.literal_patterns.len(),
    )?;
  }
  validate_static_data_length(
    "regex_meta",
    config.slices.regex,
    config.regex_meta.len(),
  )?;
  validate_static_data_length(
    "custom_regex_meta",
    config.slices.custom_regex,
    config.custom_regex_meta.len(),
  )
}

fn validate_slice_bounds(
  field: &'static str,
  slice: PatternSlice,
  pattern_count: usize,
) -> Result<()> {
  if slice.start > slice.end {
    return Err(Error::InvalidStaticData {
      field,
      reason: "slice start exceeds slice end".to_owned(),
    });
  }
  let Some(end) = usize::try_from(slice.end).ok() else {
    return Err(Error::InvalidStaticData {
      field,
      reason: "slice end exceeds usize range".to_owned(),
    });
  };
  if end <= pattern_count {
    return Ok(());
  }
  Err(Error::InvalidStaticData {
    field,
    reason: format!("slice end {end} exceeds pattern count {pattern_count}"),
  })
}

fn validate_legal_form_config(config: &PreparedSearchConfig) -> Result<()> {
  if config.slices.legal_forms.is_empty() {
    return Ok(());
  }

  let Some(data) = &config.legal_form_data else {
    return Err(Error::MissingStaticData {
      field: "legal_form_data",
    });
  };

  validate_static_data_length(
    "legal_form_data.suffixes",
    config.slices.legal_forms,
    data.suffixes.len(),
  )
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

fn validate_gazetteer_config(config: &PreparedSearchConfig) -> Result<()> {
  if config.slices.gazetteer.is_empty() {
    return Ok(());
  }

  let Some(data) = &config.gazetteer_data else {
    return Err(Error::MissingStaticData {
      field: "gazetteer_data",
    });
  };

  validate_static_data_length(
    "gazetteer_data.labels",
    config.slices.gazetteer,
    data.labels.len(),
  )?;
  validate_static_data_length(
    "gazetteer_data.is_fuzzy",
    config.slices.gazetteer,
    data.is_fuzzy.len(),
  )
}

fn validate_country_config(config: &PreparedSearchConfig) -> Result<()> {
  if config.slices.countries.is_empty() {
    return Ok(());
  }

  let Some(data) = &config.country_data else {
    return Err(Error::MissingStaticData {
      field: "country_data",
    });
  };

  validate_static_data_length(
    "country_data.labels",
    config.slices.countries,
    data.labels.len(),
  )
}

fn validate_hotword_config(config: &PreparedSearchConfig) -> Result<()> {
  if config.slices.hotwords.is_empty() {
    return Ok(());
  }

  let Some(data) = &config.hotword_data else {
    return Err(Error::MissingStaticData {
      field: "hotword_data",
    });
  };

  validate_static_data_length(
    "hotword_data.pattern_rule_indices",
    config.slices.hotwords,
    data.pattern_rule_indices.len(),
  )?;

  for rule_index in &data.pattern_rule_indices {
    let Ok(rule_index) = usize::try_from(*rule_index) else {
      return Err(Error::InvalidStaticData {
        field: "hotword_data.pattern_rule_indices",
        reason: String::from("rule index exceeds usize range"),
      });
    };
    if rule_index >= data.rules.len() {
      return Err(Error::InvalidStaticData {
        field: "hotword_data.pattern_rule_indices",
        reason: String::from("rule index out of range"),
      });
    }
  }

  Ok(())
}

const fn validate_address_seed_config(
  config: &PreparedSearchConfig,
) -> Result<()> {
  if config.slices.street_types.is_empty() {
    return Ok(());
  }

  if config.address_seed_data.is_some() {
    return Ok(());
  }

  Err(Error::MissingStaticData {
    field: "address_seed_data",
  })
}

fn validate_trigger_config(config: &PreparedSearchConfig) -> Result<()> {
  if config.slices.triggers.is_empty() {
    return Ok(());
  }

  let Some(data) = &config.trigger_data else {
    return Err(Error::MissingStaticData {
      field: "trigger_data",
    });
  };

  validate_static_data_length(
    "trigger_data.rules",
    config.slices.triggers,
    data.rules.len(),
  )
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
      .saturating_add(self.country_entities.len())
      .saturating_add(self.anchored_entities.len())
      .saturating_add(self.trigger_entities.len())
      .saturating_add(self.signature_entities.len())
      .saturating_add(self.legal_form_entities.len())
      .saturating_add(self.address_seed_entities.len());
    let mut entities = Vec::with_capacity(capacity);
    entities.extend(self.regex_entities.iter().cloned());
    entities.extend(self.custom_regex_entities.iter().cloned());
    entities.extend(self.deny_list_entities.iter().cloned());
    entities.extend(self.gazetteer_entities.iter().cloned());
    entities.extend(self.country_entities.iter().cloned());
    entities.extend(self.anchored_entities.iter().cloned());
    entities.extend(self.trigger_entities.iter().cloned());
    entities.extend(self.signature_entities.iter().cloned());
    entities.extend(self.legal_form_entities.iter().cloned());
    entities.extend(self.address_seed_entities.iter().cloned());
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
