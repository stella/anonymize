use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::search::{
  SearchIndex, SearchIndexBuildStats, SearchOptions, SearchPattern,
};
use crate::types::Result;

use super::artifacts::{PreparedEngineArtifacts, PreparedEngineArtifactsView};
use super::config_validation::validate_supported_config;
use super::index_builder::{
  SearchIndexBuildInputs, TimedSearchIndex, build_search_indexes,
};
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

struct SearchIndexPrepareMetric {
  stage: DiagnosticStage,
  pattern_count: usize,
  elapsed_us: u64,
  stats: Vec<SearchIndexBuildStats>,
}

struct PreparedSearchSlot {
  index: SearchIndex,
  metric: SearchIndexPrepareMetric,
}

pub(super) fn prepare_search_artifacts(
  config: PreparedEngineConfig,
) -> Result<PreparedEngineArtifacts> {
  validate_supported_config(&config, false)?;
  let search = config.search;
  let regex_groups =
    split_regex_patterns(search.regex_patterns, &search.slices)?;
  Ok(PreparedEngineArtifacts {
    regex: SearchIndex::prepare_artifacts(
      regex_groups.regex,
      search.regex_options,
    )?,
    custom_regex: SearchIndex::prepare_artifacts(
      search.custom_regex_patterns,
      search.custom_regex_options,
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
      search.literal_patterns,
      search.literal_options,
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
  counts.literals = indexes.literals.index.len();
  let regex = PreparedSearchSlot::from_timed(
    DiagnosticStage::PrepareRegex,
    counts.regex,
    indexes.regex,
  );
  let custom_regex = PreparedSearchSlot::from_timed(
    DiagnosticStage::PrepareCustomRegex,
    counts.custom_regex,
    indexes.custom_regex,
  );
  let legal_forms = PreparedSearchSlot::from_timed(
    DiagnosticStage::PrepareLegalFormSearch,
    counts.legal_forms,
    indexes.legal_forms,
  );
  let triggers = PreparedSearchSlot::from_timed(
    DiagnosticStage::PrepareTriggerSearch,
    counts.triggers,
    indexes.triggers,
  );
  let literals = PreparedSearchSlot::from_timed(
    DiagnosticStage::PrepareLiteral,
    counts.literals,
    indexes.literals,
  );
  let metrics = [
    regex.metric,
    custom_regex.metric,
    legal_forms.metric,
    triggers.metric,
    literals.metric,
  ];
  record_search_index_prepare_stages(diagnostics, &metrics);

  Ok(PreparedEngineIndexBundle {
    regex: regex.index,
    custom_regex: custom_regex.index,
    legal_forms: legal_forms.index,
    triggers: triggers.index,
    literals: literals.index,
    counts,
  })
}

impl PreparedSearchSlot {
  fn from_timed(
    stage: DiagnosticStage,
    pattern_count: usize,
    timed: TimedSearchIndex,
  ) -> Self {
    Self {
      index: timed.index,
      metric: SearchIndexPrepareMetric {
        stage,
        pattern_count,
        elapsed_us: timed.elapsed_us,
        stats: timed.stats,
      },
    }
  }
}

fn record_search_index_prepare_stages(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  metrics: &[SearchIndexPrepareMetric],
) {
  for metric in metrics {
    record_prepare_stage_elapsed(
      diagnostics,
      metric.stage,
      metric.pattern_count,
      metric.elapsed_us,
    );
    if let Some(diagnostics) = diagnostics.as_deref_mut() {
      diagnostics
        .record_search_build_slot_summaries(metric.stage, &metric.stats);
    }
  }
}
