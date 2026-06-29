use std::time::Instant;

use crate::address_context::{AddressContextData, PreparedAddressContextData};
use crate::address_seeds::{AddressSeedData, PreparedAddressSeedData};
use crate::artifact_bytes::{ArtifactReader, ArtifactWriter};
use crate::byte_offsets::ByteOffsets;
use crate::coreference::{CoreferenceData, PreparedCoreferenceData};
use crate::dates::{DateData, PreparedDateData};
use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::false_positives::filter_entity_false_positives;
use crate::hotwords::{
  HotwordRuleData, PreparedHotwordData, apply_hotword_rules,
};
use crate::legal_forms::{
  LegalFormData, PreparedLegalFormData, process_legal_form_matches,
};
use crate::money::{MonetaryData, PreparedMonetaryData};
use crate::name_corpus::{
  NameCorpusData, PreparedNameCorpusData as PreparedNames,
};
use crate::normalize::{
  NormalizedSearchText, normalize_for_search_with_byte_map,
};
use crate::processors::{
  CountryMatchData, DenyListFilterData, DenyListMatchData, GazetteerMatchData,
  PatternSlice, RegexMatchMeta, ensure_supported_deny_list_sources,
  process_country_matches, process_deny_list_matches,
  process_gazetteer_matches, process_regex_matches,
};
use crate::redact::redact_text;
use crate::resolution::{
  PipelineEntity, SourceDetail, enforce_boundary_consistency, merge_and_dedup,
  sanitize_entities_with_source,
};
use crate::search::{
  LiteralSearchOptions, SearchIndex, SearchIndexArtifacts,
  SearchIndexBuildStats, SearchOptions, SearchPattern,
};
use crate::signatures::detect_signatures;
use crate::triggers::{
  PreparedTriggerData, TriggerData, process_trigger_matches,
};
use crate::types::{
  Entity, EntityKind, Error, OperatorConfig, RedactionResult, Result,
  SearchMatch,
};
use crate::zones::{PreparedZoneData, ZoneData};

const PREPARED_SEARCH_ARTIFACTS_HEADER: [u8; 8] = *b"ANONPSR1";
const PREPARED_SEARCH_ARTIFACTS_VERSION: u32 = 1;
const NEAR_MISS_BAND: f64 = 0.15;
const BOOST_PER_NEIGHBOUR: f64 = 0.05;
const CONTEXT_WINDOW_CHARS: f64 = 150.0;
const HIGH_CONFIDENCE_FLOOR: f64 = 0.9;
const PARALLEL_SEARCH_MIN_BYTES: usize = 128 * 1024;

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
  false_positive_filters: Option<DenyListFilterData>,
  gazetteer_data: Option<GazetteerMatchData>,
  country_data: Option<CountryMatchData>,
  hotword_data: Option<PreparedHotwordData>,
  trigger_data: Option<PreparedTriggerData>,
  legal_form_data: Option<PreparedLegalFormData>,
  address_seed_data: Option<PreparedAddressSeedData>,
  zone_data: Option<PreparedZoneData>,
  address_context_data: Option<PreparedAddressContextData>,
  coreference_data: Option<PreparedCoreferenceData>,
  name_corpus_data: Option<PreparedNames>,
  date_data: Option<PreparedDateData>,
  monetary_data: Option<PreparedMonetaryData>,
  monetary_extraction: bool,
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
  #[serde(default)]
  pub false_positive_filters: Option<DenyListFilterData>,
  pub gazetteer_data: Option<GazetteerMatchData>,
  pub country_data: Option<CountryMatchData>,
  #[serde(default)]
  pub hotword_data: Option<HotwordRuleData>,
  pub trigger_data: Option<TriggerData>,
  pub legal_form_data: Option<LegalFormData>,
  pub address_seed_data: Option<AddressSeedData>,
  #[serde(default)]
  pub zone_data: Option<ZoneData>,
  #[serde(default)]
  pub address_context_data: Option<AddressContextData>,
  #[serde(default)]
  pub coreference_data: Option<CoreferenceData>,
  #[serde(default)]
  pub name_corpus_data: Option<NameCorpusData>,
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
  pub name_corpus_entities: Vec<PipelineEntity>,
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
  name_corpus: TimedEntities,
}

impl StaticEntityPasses {
  const fn entity_count(&self) -> usize {
    self
      .regex
      .entities
      .len()
      .saturating_add(self.custom_regex.entities.len())
      .saturating_add(self.deny_list.entities.len())
      .saturating_add(self.gazetteer.entities.len())
      .saturating_add(self.country.entities.len())
      .saturating_add(self.anchored.entities.len())
      .saturating_add(self.trigger.entities.len())
      .saturating_add(self.signature.entities.len())
      .saturating_add(self.legal_form.entities.len())
      .saturating_add(self.address_seed.entities.len())
      .saturating_add(self.name_corpus.entities.len())
  }
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

struct TimedSearchIndex {
  index: SearchIndex,
  elapsed_us: u64,
  stats: Vec<SearchIndexBuildStats>,
}

struct PreparedSearchIndexes {
  regex: TimedSearchIndex,
  custom_regex: TimedSearchIndex,
  legal_forms: TimedSearchIndex,
  triggers: TimedSearchIndex,
  literals: TimedSearchIndex,
}

struct SearchIndexConfigInput {
  regex_patterns: Vec<SearchPattern>,
  custom_regex_patterns: Vec<SearchPattern>,
  literal_patterns: Vec<SearchPattern>,
  regex_options: SearchOptions,
  custom_regex_options: SearchOptions,
  literal_options: SearchOptions,
  anchored_len: usize,
}

#[derive(Clone, Copy)]
struct SearchPrepareCounts {
  regex: usize,
  custom_regex: usize,
  anchored: usize,
  legal_forms: usize,
  triggers: usize,
  literals: usize,
}

impl SearchPrepareCounts {
  const fn total(self) -> usize {
    self
      .regex
      .saturating_add(self.custom_regex)
      .saturating_add(self.anchored)
      .saturating_add(self.legal_forms)
      .saturating_add(self.triggers)
      .saturating_add(self.literals)
  }
}

struct PreparedSearchIndexBundle {
  regex: SearchIndex,
  custom_regex: SearchIndex,
  legal_forms: SearchIndex,
  triggers: SearchIndex,
  literals: SearchIndex,
  counts: SearchPrepareCounts,
}

struct SupportDataInput {
  hotwords: Option<HotwordRuleData>,
  triggers: Option<TriggerData>,
  legal_forms: Option<LegalFormData>,
  address_seed: Option<AddressSeedData>,
  zones: Option<ZoneData>,
  address_context: Option<AddressContextData>,
  coreference: Option<CoreferenceData>,
  name_corpus: Option<NameCorpusData>,
}

struct PreparedSupportData {
  hotwords: Option<PreparedHotwordData>,
  triggers: Option<PreparedTriggerData>,
  legal_forms: Option<PreparedLegalFormData>,
  address_seed: Option<PreparedAddressSeedData>,
  zones: Option<PreparedZoneData>,
  address_context: Option<PreparedAddressContextData>,
  coreference: Option<PreparedCoreferenceData>,
  names: Option<PreparedNames>,
  count: usize,
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

struct SearchIndexPrepareMetrics {
  regex: SearchIndexPrepareMetric,
  custom_regex: SearchIndexPrepareMetric,
  legal_forms: SearchIndexPrepareMetric,
  triggers: SearchIndexPrepareMetric,
  literals: SearchIndexPrepareMetric,
}

struct SearchIndexPrepareMetric {
  pattern_count: usize,
  elapsed_us: u64,
  stats: Vec<SearchIndexBuildStats>,
}

impl PreparedSearch {
  pub fn new(config: PreparedSearchConfig) -> Result<Self> {
    Self::new_inner(config, None, None)
  }

  pub fn warm_lazy_regex(&self) -> Result<()> {
    self.warm_lazy_regex_inner(None)
  }

  pub fn warm_lazy_regex_diagnostics(
    &self,
  ) -> Result<StaticRedactionDiagnostics> {
    let mut diagnostics = StaticRedactionDiagnostics::default();
    self.warm_lazy_regex_inner(Some(&mut diagnostics))?;
    Ok(diagnostics)
  }

  fn warm_lazy_regex_inner(
    &self,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<()> {
    let total_start = Instant::now();
    let stages = [
      (DiagnosticStage::WarmRegex, &self.regex),
      (DiagnosticStage::WarmCustomRegex, &self.custom_regex),
      (DiagnosticStage::WarmLegalFormSearch, &self.legal_forms),
      (DiagnosticStage::WarmTriggerSearch, &self.triggers),
      (DiagnosticStage::WarmLiteral, &self.literals),
    ];
    let mut count = 0usize;
    for (stage, index) in stages {
      let start = Instant::now();
      index.warm_lazy_regex()?;
      count = count.saturating_add(index.len());
      if let Some(diagnostics) = &mut diagnostics {
        diagnostics.record_stage(
          stage,
          Some(index.len()),
          Some(elapsed_us(start)),
          None,
        );
      }
    }
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_stage(
        DiagnosticStage::WarmTotal,
        Some(count),
        Some(elapsed_us(total_start)),
        None,
      );
    }
    Ok(())
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
    mut config: PreparedSearchConfig,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
    artifacts: Option<&PreparedSearchArtifacts>,
  ) -> Result<Self> {
    let total_start = Instant::now();
    validate_supported_config_for_artifacts(&config, artifacts)?;
    let monetary_extraction = should_extract_monetary_data(&config);
    let support_input = take_support_input(&mut config);
    let PreparedSearchConfig {
      regex_patterns,
      custom_regex_patterns,
      literal_patterns,
      regex_options,
      custom_regex_options,
      literal_options,
      allowed_labels,
      threshold,
      confidence_boost,
      slices,
      regex_meta,
      custom_regex_meta,
      deny_list_data,
      false_positive_filters,
      gazetteer_data,
      country_data,
      date_data,
      monetary_data,
      ..
    } = config;
    let anchored_len =
      anchored_config_len(date_data.as_ref(), monetary_data.as_ref());
    let (date_data, monetary_data) = prepare_anchored_data(
      date_data.as_ref(),
      monetary_data,
      anchored_len,
      diagnostics.as_deref_mut(),
    )?;
    let PreparedSearchIndexBundle {
      regex,
      custom_regex,
      legal_forms,
      triggers,
      literals,
      counts,
    } = prepare_search_index_bundle(
      SearchIndexConfigInput {
        regex_patterns,
        custom_regex_patterns,
        literal_patterns,
        regex_options,
        custom_regex_options,
        literal_options,
        anchored_len,
      },
      &slices,
      artifacts,
      &mut diagnostics,
    )?;
    let support_data = prepare_support_data(support_input, &mut diagnostics)?;
    let prepare_count = counts.total().saturating_add(support_data.count);
    record_prepare_total(&mut diagnostics, prepare_count, total_start);
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
      regex_meta,
      custom_regex_meta,
      deny_list_data,
      false_positive_filters,
      gazetteer_data,
      country_data,
      hotword_data: support_data.hotwords,
      trigger_data: support_data.triggers,
      legal_form_data: support_data.legal_forms,
      address_seed_data: support_data.address_seed,
      zone_data: support_data.zones,
      address_context_data: support_data.address_context,
      coreference_data: support_data.coreference,
      name_corpus_data: support_data.names,
      date_data,
      monetary_data,
      monetary_extraction,
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
    let normalized = normalize_search_text(full_text, &mut diagnostics)?;
    if diagnostics.is_none() && full_text.len() >= PARALLEL_SEARCH_MIN_BYTES {
      return self.find_matches_parallel(full_text, &normalized);
    }

    let regex_start = Instant::now();
    let regex = offset_index_matches(
      &self.regex,
      full_text,
      diagnostics.as_deref_mut(),
      DiagnosticStage::FindRegex,
      full_text.len(),
      self.slices.regex.start,
    )?;
    record_search_matches(
      &mut diagnostics,
      DiagnosticStage::SearchRegex,
      &regex,
      full_text,
      regex_start,
    );

    let legal_form_start = Instant::now();
    let legal_forms = normalized_index_matches(
      &self.legal_forms,
      &normalized,
      diagnostics.as_deref_mut(),
      DiagnosticStage::FindLegalForm,
      full_text.len(),
      self.slices.legal_forms.start,
    )?;
    record_search_matches(
      &mut diagnostics,
      DiagnosticStage::SearchLegalForm,
      &legal_forms,
      full_text,
      legal_form_start,
    );

    let trigger_start = Instant::now();
    let triggers = offset_index_matches(
      &self.triggers,
      full_text,
      diagnostics.as_deref_mut(),
      DiagnosticStage::FindTrigger,
      full_text.len(),
      self.slices.triggers.start,
    )?;
    record_search_matches(
      &mut diagnostics,
      DiagnosticStage::SearchTrigger,
      &triggers,
      full_text,
      trigger_start,
    );

    let custom_regex_start = Instant::now();
    let custom_regex = offset_index_matches(
      &self.custom_regex,
      full_text,
      diagnostics.as_deref_mut(),
      DiagnosticStage::FindCustomRegex,
      full_text.len(),
      self.slices.custom_regex.start,
    )?;
    record_search_matches(
      &mut diagnostics,
      DiagnosticStage::SearchCustomRegex,
      &custom_regex,
      full_text,
      custom_regex_start,
    );

    let literal_start = Instant::now();
    let literal = normalized_index_matches(
      &self.literals,
      &normalized,
      diagnostics.as_deref_mut(),
      DiagnosticStage::FindLiteral,
      full_text.len(),
      0,
    )?;
    let regex = combine_regex_matches(regex, legal_forms, triggers);
    record_search_matches(
      &mut diagnostics,
      DiagnosticStage::SearchLiteral,
      &literal,
      full_text,
      literal_start,
    );
    record_find_matches_summary(
      &mut diagnostics,
      &regex,
      &custom_regex,
      &literal,
      full_text,
      total_start,
    );

    Ok(PreparedSearchMatches {
      regex,
      custom_regex,
      literal,
    })
  }

  fn find_matches_parallel(
    &self,
    full_text: &str,
    normalized: &NormalizedSearchText,
  ) -> Result<PreparedSearchMatches> {
    let input_bytes = full_text.len();
    std::thread::scope(|scope| {
      let regex = scope.spawn(|| {
        offset_index_matches(
          &self.regex,
          full_text,
          None,
          DiagnosticStage::FindRegex,
          input_bytes,
          self.slices.regex.start,
        )
      });
      let legal_forms = scope.spawn(|| {
        normalized_index_matches(
          &self.legal_forms,
          normalized,
          None,
          DiagnosticStage::FindLegalForm,
          input_bytes,
          self.slices.legal_forms.start,
        )
      });
      let triggers = scope.spawn(|| {
        offset_index_matches(
          &self.triggers,
          full_text,
          None,
          DiagnosticStage::FindTrigger,
          input_bytes,
          self.slices.triggers.start,
        )
      });
      let custom_regex = scope.spawn(|| {
        offset_index_matches(
          &self.custom_regex,
          full_text,
          None,
          DiagnosticStage::FindCustomRegex,
          input_bytes,
          self.slices.custom_regex.start,
        )
      });
      let literal = scope.spawn(|| {
        normalized_index_matches(
          &self.literals,
          normalized,
          None,
          DiagnosticStage::FindLiteral,
          input_bytes,
          0,
        )
      });

      Ok(PreparedSearchMatches {
        regex: combine_regex_matches(
          join_match_handle(regex, "regex")?,
          join_match_handle(legal_forms, "legal_forms")?,
          join_match_handle(triggers, "triggers")?,
        ),
        custom_regex: join_match_handle(custom_regex, "custom_regex")?,
        literal: join_match_handle(literal, "literals")?,
      })
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
    let detect_start = Instant::now();
    let matches =
      self.find_matches_inner(full_text, diagnostics.as_deref_mut())?;
    let passes = self.process_static_entity_passes(
      &matches,
      full_text,
      diagnostics.as_deref_mut(),
    )?;

    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_stage(
        DiagnosticStage::DetectTotal,
        Some(passes.entity_count()),
        Some(elapsed_us(detect_start)),
        Some(full_text.len()),
      );
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
      name_corpus_entities: passes.name_corpus.entities,
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

    let name_corpus =
      self.process_name_corpus_entities(full_text, &deny_list.entities)?;

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
        &name_corpus.entities,
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
      name_corpus,
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
    if self.monetary_extraction
      && let Some(data) = &self.monetary_data
    {
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

  fn process_name_corpus_entities(
    &self,
    full_text: &str,
    deny_list_entities: &[PipelineEntity],
  ) -> Result<TimedEntities> {
    let start = Instant::now();
    let entities = if let Some(data) = &self.name_corpus_data {
      data.detect_supplemental(full_text, deny_list_entities)?
    } else {
      Vec::new()
    };

    Ok(TimedEntities {
      entities,
      elapsed_us: elapsed_us(start),
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
    let redact_start = Instant::now();
    let detections = self
      .detect_static_entities_inner(full_text, diagnostics.as_deref_mut())?;
    let pre_threshold_entities = self.prepare_pre_threshold_entities(
      &detections,
      full_text,
      diagnostics.as_deref_mut(),
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
    let merged = self.extend_monetary_entities(full_text, &merged);
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
    let false_positive_filters =
      self.false_positive_filters.as_ref().or_else(|| {
        self
          .deny_list_data
          .as_ref()
          .and_then(|data| data.filters.as_ref())
      });
    let mut resolved_entities = filter_entities_for_config(
      filter_entity_false_positives(
        sanitized_entities,
        full_text,
        false_positive_filters,
      )?,
      self.threshold,
      &self.allowed_labels,
    );
    resolved_entities = self.process_coreference_entities(
      full_text,
      resolved_entities,
      false_positive_filters,
      diagnostics.as_deref_mut(),
    )?;
    clear_internal_source_details(&mut resolved_entities);
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
    record_redaction_stages(
      &mut diagnostics,
      &redaction,
      full_text.len(),
      redaction_start,
      redact_start,
    );

    Ok(StaticRedactionResult {
      detections,
      resolved_entities,
      redaction,
    })
  }

  fn prepare_pre_threshold_entities(
    &self,
    detections: &StaticDetectionResult,
    full_text: &str,
    diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<Vec<PipelineEntity>> {
    let zone_adjusted_entities = self.apply_zone_adjustments(
      detections.all_entities(),
      full_text,
      diagnostics,
    )?;
    self.apply_hotword_entities(
      zone_adjusted_entities,
      full_text,
      &detections.matches.literal,
    )
  }

  fn apply_hotword_entities(
    &self,
    entities: Vec<PipelineEntity>,
    full_text: &str,
    _literal_matches: &[SearchMatch],
  ) -> Result<Vec<PipelineEntity>> {
    let Some(data) = &self.hotword_data else {
      return Ok(entities);
    };
    apply_hotword_rules(entities, full_text, data, &self.allowed_labels)
  }

  fn apply_zone_adjustments(
    &self,
    entities: Vec<PipelineEntity>,
    full_text: &str,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<Vec<PipelineEntity>> {
    let Some(data) = &self.zone_data else {
      return Ok(entities);
    };

    let start = Instant::now();
    let adjusted = data.adjust_entities(full_text, entities)?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_stage(
        DiagnosticStage::EntityZoneAdjustment,
        Some(adjusted.boosted),
        Some(elapsed_us(start)),
        Some(full_text.len()),
      );
    }
    Ok(adjusted.entities)
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

  fn process_coreference_entities(
    &self,
    full_text: &str,
    existing_entities: Vec<PipelineEntity>,
    false_positive_filters: Option<&DenyListFilterData>,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<Vec<PipelineEntity>> {
    let Some(data) = &self.coreference_data else {
      return Ok(existing_entities);
    };

    let start = Instant::now();
    let coreference_entities =
      data.process(full_text, &existing_entities, self.threshold)?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_entities(
        DiagnosticStage::EntityCoreference,
        &coreference_entities,
        full_text,
        Some(elapsed_us(start)),
      );
    }
    if coreference_entities.is_empty() {
      return Ok(existing_entities);
    }

    let merged =
      merge_and_dedup(&[existing_entities, coreference_entities].concat());
    let consistent = enforce_boundary_consistency(&merged, full_text)?;
    let sanitized = sanitize_entities_with_source(&consistent, full_text)?;
    let filtered = filter_entity_false_positives(
      sanitized,
      full_text,
      false_positive_filters,
    )?;
    Ok(filter_entities_for_labels(filtered, &self.allowed_labels))
  }

  fn extend_monetary_entities(
    &self,
    full_text: &str,
    entities: &[PipelineEntity],
  ) -> Vec<PipelineEntity> {
    let Some(data) = &self.monetary_data else {
      return entities.to_vec();
    };
    data.extend_entities(full_text, entities)
  }
}

fn should_extract_monetary_data(config: &PreparedSearchConfig) -> bool {
  config.regex_patterns.is_empty()
    || config
      .regex_meta
      .iter()
      .any(|meta| meta.label == "monetary amount")
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
    .filter(|entity| {
      entity.score >= threshold
        || entity.source_detail == Some(SourceDetail::AddressContext)
    })
    .collect()
}

fn clear_internal_source_details(entities: &mut [PipelineEntity]) {
  for entity in entities {
    if entity.source_detail == Some(SourceDetail::AddressContext) {
      entity.source_detail = None;
    }
  }
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
    DiagnosticStage::EntityNameCorpus,
    &passes.name_corpus.entities,
    full_text,
    Some(passes.name_corpus.elapsed_us),
  );
  diagnostics.record_entities(
    DiagnosticStage::EntityAddressSeed,
    &passes.address_seed.entities,
    full_text,
    Some(passes.address_seed.elapsed_us),
  );
}

fn normalize_search_text(
  full_text: &str,
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
) -> Result<NormalizedSearchText> {
  let start = Instant::now();
  let normalized = normalize_for_search_with_byte_map(full_text)?;
  if let Some(diagnostics) = diagnostics {
    diagnostics.record_stage(
      DiagnosticStage::Normalize,
      None,
      Some(elapsed_us(start)),
      Some(full_text.len()),
    );
  }
  Ok(normalized)
}

fn record_search_matches(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  stage: DiagnosticStage,
  matches: &[SearchMatch],
  full_text: &str,
  start: Instant,
) {
  if let Some(diagnostics) = diagnostics {
    diagnostics.record_search_matches(
      stage,
      matches,
      full_text,
      Some(elapsed_us(start)),
    );
  }
}

fn record_find_matches_summary(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  regex: &[SearchMatch],
  custom_regex: &[SearchMatch],
  literal: &[SearchMatch],
  full_text: &str,
  start: Instant,
) {
  let Some(diagnostics) = diagnostics else {
    return;
  };
  diagnostics.record_stage(
    DiagnosticStage::FindMatches,
    Some(
      regex
        .len()
        .saturating_add(custom_regex.len())
        .saturating_add(literal.len()),
    ),
    Some(elapsed_us(start)),
    Some(full_text.len()),
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

fn prepare_search_index_bundle(
  input: SearchIndexConfigInput,
  slices: &PreparedSearchSlices,
  artifacts: Option<&PreparedSearchArtifacts>,
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
) -> Result<PreparedSearchIndexBundle> {
  let SearchIndexConfigInput {
    regex_patterns,
    custom_regex_patterns,
    literal_patterns,
    regex_options,
    custom_regex_options,
    literal_options,
    anchored_len,
  } = input;
  let regex_groups = split_regex_patterns(regex_patterns, slices)?;
  let mut counts = SearchPrepareCounts {
    regex: regex_groups.regex.len(),
    custom_regex: custom_regex_patterns.len(),
    anchored: anchored_len,
    legal_forms: regex_groups.legal_forms.len(),
    triggers: regex_groups.triggers.len(),
    literals: 0,
  };
  let indexes = build_search_indexes(
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
    diagnostics.is_some(),
  )?;
  let (
    regex_index,
    custom_regex_index,
    legal_forms_index,
    triggers_index,
    literals_index,
  ) = (
    indexes.regex,
    indexes.custom_regex,
    indexes.legal_forms,
    indexes.triggers,
    indexes.literals,
  );
  let regex = regex_index.index;
  let custom_regex = custom_regex_index.index;
  let legal_forms = legal_forms_index.index;
  let triggers = triggers_index.index;
  let literals = literals_index.index;
  counts.literals = literals.len();
  record_search_index_prepare_stages(
    diagnostics,
    &SearchIndexPrepareMetrics {
      regex: SearchIndexPrepareMetric {
        pattern_count: counts.regex,
        elapsed_us: regex_index.elapsed_us,
        stats: regex_index.stats,
      },
      custom_regex: SearchIndexPrepareMetric {
        pattern_count: counts.custom_regex,
        elapsed_us: custom_regex_index.elapsed_us,
        stats: custom_regex_index.stats,
      },
      legal_forms: SearchIndexPrepareMetric {
        pattern_count: counts.legal_forms,
        elapsed_us: legal_forms_index.elapsed_us,
        stats: legal_forms_index.stats,
      },
      triggers: SearchIndexPrepareMetric {
        pattern_count: counts.triggers,
        elapsed_us: triggers_index.elapsed_us,
        stats: triggers_index.stats,
      },
      literals: SearchIndexPrepareMetric {
        pattern_count: counts.literals,
        elapsed_us: literals_index.elapsed_us,
        stats: literals_index.stats,
      },
    },
  );

  Ok(PreparedSearchIndexBundle {
    regex,
    custom_regex,
    legal_forms,
    triggers,
    literals,
    counts,
  })
}

fn build_search_indexes(
  inputs: SearchIndexBuildInputs,
  artifacts: Option<&PreparedSearchArtifacts>,
  collect_stats: bool,
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
      build_search_index(
        regex_patterns,
        regex_options,
        regex_artifacts,
        collect_stats,
      )
    });
    let custom_regex = scope.spawn(move || {
      build_search_index(
        custom_regex_patterns,
        custom_regex_options,
        custom_regex_artifacts,
        collect_stats,
      )
    });
    let legal_forms = scope.spawn(move || {
      build_search_index(
        legal_form_patterns,
        legal_form_search_options(),
        legal_form_artifacts,
        collect_stats,
      )
    });
    let triggers = scope.spawn(move || {
      build_search_index(
        trigger_patterns,
        trigger_search_options(),
        trigger_artifacts,
        collect_stats,
      )
    });
    let literals = scope.spawn(move || {
      build_search_index(
        literal_patterns,
        literal_options,
        literal_artifacts,
        collect_stats,
      )
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
  collect_stats: bool,
) -> Result<TimedSearchIndex> {
  let start = Instant::now();
  let (index, stats) = if collect_stats {
    let result = if let Some(artifacts) = artifacts {
      SearchIndex::new_with_artifacts_build_stats(patterns, options, artifacts)?
    } else {
      SearchIndex::new_with_build_stats(patterns, options)?
    };
    (result.index, result.stats)
  } else if let Some(artifacts) = artifacts {
    (
      SearchIndex::new_with_artifacts(patterns, options, artifacts)?,
      Vec::new(),
    )
  } else {
    (SearchIndex::new(patterns, options)?, Vec::new())
  };
  Ok(TimedSearchIndex {
    index,
    elapsed_us: elapsed_us(start),
    stats,
  })
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

fn join_match_handle(
  handle: std::thread::ScopedJoinHandle<'_, Result<Vec<SearchMatch>>>,
  field: &'static str,
) -> Result<Vec<SearchMatch>> {
  handle.join().map_err(|_| Error::InvalidStaticData {
    field,
    reason: "search worker panicked".to_owned(),
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
    (DiagnosticStage::PrepareRegex, &metrics.regex),
    (DiagnosticStage::PrepareCustomRegex, &metrics.custom_regex),
    (
      DiagnosticStage::PrepareLegalFormSearch,
      &metrics.legal_forms,
    ),
    (DiagnosticStage::PrepareTriggerSearch, &metrics.triggers),
    (DiagnosticStage::PrepareLiteral, &metrics.literals),
  ];
  for (stage, metric) in stages {
    record_prepare_stage_elapsed(
      diagnostics,
      stage,
      metric.pattern_count,
      metric.elapsed_us,
    );
    if let Some(diagnostics) = diagnostics.as_deref_mut() {
      diagnostics.record_search_build_slot_summaries(stage, &metric.stats);
    }
  }
}

fn record_prepare_total(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  count: usize,
  start: Instant,
) {
  let Some(diagnostics) = diagnostics else {
    return;
  };
  diagnostics.record_stage(
    DiagnosticStage::PrepareTotal,
    Some(count),
    Some(elapsed_us(start)),
    None,
  );
}

fn record_redaction_stages(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  redaction: &RedactionResult,
  input_bytes: usize,
  redaction_start: Instant,
  total_start: Instant,
) {
  let Some(diagnostics) = diagnostics else {
    return;
  };
  diagnostics.record_redaction(
    redaction,
    Some(elapsed_us(redaction_start)),
    input_bytes,
  );
  diagnostics.record_stage(
    DiagnosticStage::RedactTotal,
    Some(redaction.entity_count),
    Some(elapsed_us(total_start)),
    Some(input_bytes),
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

const fn take_support_input(
  config: &mut PreparedSearchConfig,
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
  }
}

fn prepare_support_data(
  input: SupportDataInput,
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
) -> Result<PreparedSupportData> {
  let hotword_data_len = hotword_data_len(input.hotwords.as_ref());
  let hotword_data_start = Instant::now();
  let hotword_data = prepare_hotword_data(input.hotwords)?;
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareHotwordData,
    hotword_data_len,
    elapsed_us(hotword_data_start),
  );

  let trigger_data_len = trigger_data_len(input.triggers.as_ref());
  let trigger_data_start = Instant::now();
  let trigger_data = prepare_trigger_data(input.triggers)?;
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareTriggerData,
    trigger_data_len,
    elapsed_us(trigger_data_start),
  );

  let legal_form_data_len = legal_form_data_len(input.legal_forms.as_ref());
  let legal_form_data_start = Instant::now();
  let legal_form_data = input.legal_forms.map(PreparedLegalFormData::new);
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareLegalFormData,
    legal_form_data_len,
    elapsed_us(legal_form_data_start),
  );

  let address_seed_data_len =
    address_seed_data_len(input.address_seed.as_ref());
  let address_seed_data_start = Instant::now();
  let address_seed_data = prepare_address_seed_data(input.address_seed)?;
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareAddressSeedData,
    address_seed_data_len,
    elapsed_us(address_seed_data_start),
  );

  let zone_data_len = zone_data_len(input.zones.as_ref());
  let zone_data_start = Instant::now();
  let zone_data = prepare_zone_data(input.zones.as_ref())?;
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareZoneData,
    zone_data_len,
    elapsed_us(zone_data_start),
  );

  let address_context_data_len =
    address_context_data_len(input.address_context.as_ref());
  let address_context_data_start = Instant::now();
  let address_context_data =
    prepare_address_context_data(input.address_context)?;
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareAddressContextData,
    address_context_data_len,
    elapsed_us(address_context_data_start),
  );

  let coreference_data_len = coreference_data_len(input.coreference.as_ref());
  let coreference_data_start = Instant::now();
  let coreference_data = prepare_coreference_data(input.coreference)?;
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareCoreferenceData,
    coreference_data_len,
    elapsed_us(coreference_data_start),
  );

  let name_corpus_data_len = name_corpus_data_len(input.name_corpus.as_ref());
  let name_corpus_data_start = Instant::now();
  let name_corpus_data = input.name_corpus.map(PreparedNames::new);
  record_prepare_stage_elapsed(
    diagnostics,
    DiagnosticStage::PrepareNameCorpusData,
    name_corpus_data_len,
    elapsed_us(name_corpus_data_start),
  );
  let count = [
    hotword_data_len,
    trigger_data_len,
    legal_form_data_len,
    address_seed_data_len,
    zone_data_len,
    address_context_data_len,
    coreference_data_len,
    name_corpus_data_len,
  ]
  .into_iter()
  .fold(0usize, usize::saturating_add);

  Ok(PreparedSupportData {
    hotwords: hotword_data,
    triggers: trigger_data,
    legal_forms: legal_form_data,
    address_seed: address_seed_data,
    zones: zone_data,
    address_context: address_context_data,
    coreference: coreference_data,
    names: name_corpus_data,
    count,
  })
}

fn hotword_data_len(data: Option<&HotwordRuleData>) -> usize {
  data.map_or(0, |data| data.rules.len())
}

fn trigger_data_len(data: Option<&TriggerData>) -> usize {
  data.map_or(0, |data| data.rules.len())
}

fn legal_form_data_len(data: Option<&LegalFormData>) -> usize {
  data.map_or(0, |data| {
    [
      data.suffixes.len(),
      data.normalized_boundary_suffixes.len(),
      data.normalized_in_name_words.len(),
      data.normalized_suffix_words.len(),
      data.role_heads.len(),
      data.sentence_verb_indicators.len(),
      data.clause_noun_heads.len(),
      data.connector_prose_heads.len(),
      data.structural_single_cap_prefixes.len(),
      data.leading_clause_phrases.len(),
      data.leading_clause_direct_prefixes.len(),
      data.connector_words.len(),
      data.and_connector_words.len(),
      data.in_name_prepositions.len(),
      data.company_suffix_words.len(),
      data.comma_gated_direct_prefixes.len(),
    ]
    .into_iter()
    .fold(0usize, usize::saturating_add)
  })
}

fn address_seed_data_len(data: Option<&AddressSeedData>) -> usize {
  data.map_or(0, |data| {
    data
      .boundary_words
      .len()
      .saturating_add(data.br_cep_cue_words.len())
      .saturating_add(data.unit_abbreviations.len())
  })
}

fn zone_data_len(data: Option<&ZoneData>) -> usize {
  data.map_or(0, |data| {
    data
      .section_heading_patterns
      .len()
      .saturating_add(data.signing_clauses.len())
  })
}

fn address_context_data_len(data: Option<&AddressContextData>) -> usize {
  data.map_or(0, |data| {
    data
      .address_prepositions
      .len()
      .saturating_add(data.temporal_prepositions.len())
      .saturating_add(data.street_abbreviations.len())
      .saturating_add(data.bare_house_stopwords.len())
  })
}

fn coreference_data_len(data: Option<&CoreferenceData>) -> usize {
  data.map_or(0, |data| {
    data
      .definition_patterns
      .len()
      .saturating_add(data.role_stop_terms.len())
      .saturating_add(data.legal_form_aliases.len())
      .saturating_add(data.organization_suffixes.len())
      .saturating_add(data.organization_determiners.len())
  })
}

fn name_corpus_data_len(data: Option<&NameCorpusData>) -> usize {
  data.map_or(0, |data| {
    [
      data.first_names.len(),
      data.surnames.len(),
      data.title_tokens.len(),
      data.title_abbreviations.len(),
      data.excluded_words.len(),
      data.common_words.len(),
      data.non_western_names.len(),
      data.excluded_all_caps.len(),
      data.ja_suffixes.len(),
      data.arabic_connectors.len(),
      data.relation_connectors.len(),
      data.hyphenated_prefixes.len(),
      data.cjk_non_person_terms.len(),
      data.cjk_surname_starters.len(),
      data.organization_terms.len(),
    ]
    .into_iter()
    .fold(0usize, usize::saturating_add)
  })
}

fn prepare_address_seed_data(
  data: Option<AddressSeedData>,
) -> Result<Option<PreparedAddressSeedData>> {
  data.map(PreparedAddressSeedData::new).transpose()
}

fn prepare_hotword_data(
  data: Option<HotwordRuleData>,
) -> Result<Option<PreparedHotwordData>> {
  data.map(PreparedHotwordData::new).transpose()
}

fn prepare_trigger_data(
  data: Option<TriggerData>,
) -> Result<Option<PreparedTriggerData>> {
  data.map(PreparedTriggerData::new).transpose()
}

fn prepare_address_context_data(
  data: Option<AddressContextData>,
) -> Result<Option<PreparedAddressContextData>> {
  data.map(PreparedAddressContextData::new).transpose()
}

fn prepare_zone_data(
  data: Option<&ZoneData>,
) -> Result<Option<PreparedZoneData>> {
  data.map(PreparedZoneData::new).transpose()
}

fn prepare_coreference_data(
  data: Option<CoreferenceData>,
) -> Result<Option<PreparedCoreferenceData>> {
  data.map(PreparedCoreferenceData::new).transpose()
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

fn find_index_matches(
  search: &SearchIndex,
  haystack: &str,
  diagnostics: Option<&mut StaticRedactionDiagnostics>,
  slot_stage: DiagnosticStage,
  input_bytes: usize,
) -> Result<Vec<SearchMatch>> {
  let Some(diagnostics) = diagnostics else {
    return search.find_iter(haystack);
  };

  let result = search.find_iter_with_stats(haystack)?;
  diagnostics.record_search_slot_summaries(
    slot_stage,
    &result.stats,
    input_bytes,
  );
  Ok(result.matches)
}

fn offset_index_matches(
  search: &SearchIndex,
  haystack: &str,
  diagnostics: Option<&mut StaticRedactionDiagnostics>,
  slot_stage: DiagnosticStage,
  input_bytes: usize,
  offset: u32,
) -> Result<Vec<SearchMatch>> {
  offset_matches(
    find_index_matches(search, haystack, diagnostics, slot_stage, input_bytes)?,
    offset,
  )
}

fn normalized_index_matches(
  search: &SearchIndex,
  normalized: &NormalizedSearchText,
  diagnostics: Option<&mut StaticRedactionDiagnostics>,
  slot_stage: DiagnosticStage,
  input_bytes: usize,
  offset: u32,
) -> Result<Vec<SearchMatch>> {
  find_index_matches(
    search,
    normalized.as_str(),
    diagnostics,
    slot_stage,
    input_bytes,
  )?
  .into_iter()
  .map(|found| remap_normalized_match(normalized, found))
  .map(|found| found.and_then(|value| offset_match(value, offset)))
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

fn validate_supported_config_for_artifacts(
  config: &PreparedSearchConfig,
  artifacts: Option<&PreparedSearchArtifacts>,
) -> Result<()> {
  let allow_literal_artifacts =
    artifacts.is_some_and(|artifacts| !artifacts.literals.slots.is_empty());
  validate_supported_config(config, allow_literal_artifacts)
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

  data.labels.validate("deny_list.labels")?;
  data.custom_labels.validate("deny_list.custom_labels")?;
  data.sources.validate("deny_list.sources")?;
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
  validate_deny_list_pattern_metadata(config.slices.deny_list, data)?;
  validate_static_data_length(
    "deny_list.sources",
    config.slices.deny_list,
    data.sources.len(),
  )?;
  ensure_supported_deny_list_sources(data)
}

fn validate_deny_list_pattern_metadata(
  slice: PatternSlice,
  data: &DenyListMatchData,
) -> Result<()> {
  if !data.originals.is_empty() {
    return validate_static_data_length(
      "deny_list.originals",
      slice,
      data.originals.len(),
    );
  }
  validate_static_data_length(
    "deny_list.pattern_meta",
    slice,
    data.pattern_meta.len(),
  )
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
  if !config.slices.hotwords.is_empty() {
    return Err(Error::UnsupportedStaticSlice { slice: "hotwords" });
  }

  let Some(data) = &config.hotword_data else {
    return Ok(());
  };

  for rule in &data.rules {
    if rule.hotwords.is_empty() {
      return Err(Error::InvalidStaticData {
        field: "hotword_data.rules.hotwords",
        reason: String::from("native hotword rules require hotword strings"),
      });
    }
    for hotword in &rule.hotwords {
      if hotword.is_empty() {
        return Err(Error::InvalidStaticData {
          field: "hotword_data.rules.hotwords",
          reason: String::from("hotword must not be empty"),
        });
      }
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
  pub const fn entity_count(&self) -> usize {
    self
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
      .saturating_add(self.address_seed_entities.len())
      .saturating_add(self.name_corpus_entities.len())
  }

  #[must_use]
  pub fn all_entities(&self) -> Vec<PipelineEntity> {
    let mut entities = Vec::with_capacity(self.entity_count());
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
    entities.extend(self.name_corpus_entities.iter().cloned());
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
