use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::search::{
  SearchIndex, SearchIndexBuildStats, SearchOptions, SearchPattern,
};
use crate::types::Result;

use super::artifacts::{PreparedEngineArtifacts, PreparedEngineArtifactsView};
use super::config_validation::validate_supported_config;
use super::index_builder::{SearchIndexBuildInputs, build_search_indexes};
use super::index_patterns::{
  legal_form_search_options, promote_case_insensitive_literals,
  split_regex_patterns, trigger_search_options,
};
use super::phase::record_prepare_stage_elapsed;
use super::{PreparedEngineConfig, PreparedEngineSlices};

pub(super) struct SearchIndexConfigInput {
  pub(super) regex_patterns: Vec<SearchPattern>,
  pub(super) custom_regex_patterns: Vec<SearchPattern>,
  pub(super) literal_patterns: Vec<SearchPattern>,
  pub(super) regex_options: SearchOptions,
  pub(super) custom_regex_options: SearchOptions,
  pub(super) literal_options: SearchOptions,
  pub(super) anchored_len: usize,
}

#[derive(Clone, Copy)]
pub(super) struct SearchPrepareCounts {
  regex: usize,
  custom_regex: usize,
  anchored: usize,
  legal_forms: usize,
  triggers: usize,
  literals: usize,
}

impl SearchPrepareCounts {
  pub(super) const fn total(self) -> usize {
    self
      .regex
      .saturating_add(self.custom_regex)
      .saturating_add(self.anchored)
      .saturating_add(self.legal_forms)
      .saturating_add(self.triggers)
      .saturating_add(self.literals)
  }
}

pub(super) struct PreparedEngineIndexBundle {
  pub(super) regex: SearchIndex,
  pub(super) custom_regex: SearchIndex,
  pub(super) legal_forms: SearchIndex,
  pub(super) triggers: SearchIndex,
  pub(super) literals: SearchIndex,
  pub(super) counts: SearchPrepareCounts,
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

pub(super) fn prepare_search_artifacts(
  config: PreparedEngineConfig,
) -> Result<PreparedEngineArtifacts> {
  validate_supported_config(&config, false)?;
  let regex_groups =
    split_regex_patterns(config.regex_patterns, &config.slices)?;
  Ok(PreparedEngineArtifacts {
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

pub(super) fn prepare_search_index_bundle(
  input: SearchIndexConfigInput,
  slices: &PreparedEngineSlices,
  artifacts: Option<&PreparedEngineArtifactsView<'_>>,
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
) -> Result<PreparedEngineIndexBundle> {
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

  Ok(PreparedEngineIndexBundle {
    regex,
    custom_regex,
    legal_forms,
    triggers,
    literals,
    counts,
  })
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
