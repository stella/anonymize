use std::time::Instant;

use crate::dates::{DateData, PreparedDateData};
use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::money::{MonetaryData, PreparedMonetaryData};
use crate::types::Result;

use super::artifacts::{PreparedEngineArtifacts, PreparedEngineArtifactsView};
use super::config_validation::validate_supported_config_for_artifacts;
use super::engine_state::{PipelinePolicy, PreparedStaticData, SearchIndexes};
use super::index_prepare::{
  PreparedEngineIndexBundle, SearchIndexConfigInput, prepare_search_artifacts,
  prepare_search_index_bundle,
};
use super::results::PreparedEngineBuildResult;
use super::support_prepare::{
  PreparedSupportData, prepare_support_data, take_support_input,
};
use super::timing::elapsed_us;
use super::{
  PreparedEngine, PreparedEngineConfig, PreparedEngineDetectorConfig,
  PreparedEnginePolicyConfig, PreparedEngineSearchConfig,
};

#[bon::bon]
impl PreparedEngine {
  #[builder]
  pub fn prepare(
    config: PreparedEngineConfig,
    artifacts: Option<&PreparedEngineArtifactsView<'_>>,
  ) -> Result<Self> {
    Self::new_inner(config, None, artifacts)
  }

  #[builder]
  pub fn prepare_with_diagnostics(
    config: PreparedEngineConfig,
    artifacts: Option<&PreparedEngineArtifactsView<'_>>,
  ) -> Result<PreparedEngineBuildResult> {
    let mut diagnostics = StaticRedactionDiagnostics::default();
    let prepared = Self::new_inner(config, Some(&mut diagnostics), artifacts)?;

    Ok(PreparedEngineBuildResult {
      prepared,
      diagnostics,
    })
  }

  pub fn new(config: PreparedEngineConfig) -> Result<Self> {
    Self::prepare().config(config).call()
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
      (DiagnosticStage::WarmRegex, &self.indexes.regex),
      (DiagnosticStage::WarmCustomRegex, &self.indexes.custom_regex),
      (
        DiagnosticStage::WarmLegalFormSearch,
        &self.indexes.legal_forms,
      ),
      (DiagnosticStage::WarmTriggerSearch, &self.indexes.triggers),
      (DiagnosticStage::WarmLiteral, &self.indexes.literals),
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
    config: PreparedEngineConfig,
  ) -> Result<PreparedEngineArtifacts> {
    prepare_search_artifacts(config)
  }

  pub fn new_with_artifacts(
    config: PreparedEngineConfig,
    artifacts: &PreparedEngineArtifacts,
  ) -> Result<Self> {
    let artifacts = artifacts.as_view();
    Self::new_with_artifact_view(config, &artifacts)
  }

  pub fn new_with_artifact_view(
    config: PreparedEngineConfig,
    artifacts: &PreparedEngineArtifactsView<'_>,
  ) -> Result<Self> {
    Self::new_inner(config, None, Some(artifacts))
  }

  pub fn new_with_artifacts_diagnostics(
    config: PreparedEngineConfig,
    artifacts: &PreparedEngineArtifacts,
  ) -> Result<PreparedEngineBuildResult> {
    let artifacts = artifacts.as_view();
    Self::new_with_artifact_view_diagnostics(config, &artifacts)
  }

  pub fn new_with_artifact_view_diagnostics(
    config: PreparedEngineConfig,
    artifacts: &PreparedEngineArtifactsView<'_>,
  ) -> Result<PreparedEngineBuildResult> {
    Self::prepare_with_diagnostics()
      .config(config)
      .artifacts(artifacts)
      .call()
  }

  pub fn new_with_diagnostics(
    config: PreparedEngineConfig,
  ) -> Result<PreparedEngineBuildResult> {
    Self::prepare_with_diagnostics().config(config).call()
  }

  fn new_inner(
    mut config: PreparedEngineConfig,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
    artifacts: Option<&PreparedEngineArtifactsView<'_>>,
  ) -> Result<Self> {
    let total_start = Instant::now();
    validate_supported_config_for_artifacts(&config, artifacts)?;
    let monetary_extraction = should_extract_monetary_data(&config.search);
    let support_input = take_support_input(&mut config.detectors);
    let PreparedEngineConfig {
      search,
      policy: policy_config,
      mut detectors,
    } = config;
    let PreparedEngineSearchConfig {
      regex_patterns,
      custom_regex_patterns,
      literal_patterns,
      regex_options,
      custom_regex_options,
      literal_options,
      slices,
      regex_meta,
      custom_regex_meta,
    } = search;
    let PreparedEnginePolicyConfig {
      allowed_labels,
      threshold,
      confidence_boost,
    } = policy_config;
    let anchored_len = anchored_config_len(
      detectors.date_data.as_ref(),
      detectors.monetary_data.as_ref(),
    );
    let (date_data, monetary_data) = prepare_anchored_data(
      detectors.date_data.as_ref(),
      detectors.monetary_data.take(),
      anchored_len,
      diagnostics.as_deref_mut(),
    )?;
    let PreparedEngineIndexBundle {
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
    record_prepare_total(
      &mut diagnostics,
      counts.total().saturating_add(support_data.count),
      total_start,
    );
    let indexes = SearchIndexes {
      regex,
      custom_regex,
      legal_forms,
      triggers,
      literals,
    };
    let policy = PipelinePolicy {
      allowed_labels,
      threshold,
      confidence_boost,
      slices,
      regex_meta,
      custom_regex_meta,
      monetary_extraction,
    };
    let data =
      prepared_static_data(detectors, support_data, date_data, monetary_data);
    Ok(Self {
      indexes,
      policy,
      data,
    })
  }
}

fn prepared_static_data(
  detectors: PreparedEngineDetectorConfig,
  support_data: PreparedSupportData,
  date_data: Option<PreparedDateData>,
  monetary_data: Option<PreparedMonetaryData>,
) -> PreparedStaticData {
  PreparedStaticData {
    deny_list: detectors.deny_list_data,
    false_positive_filters: detectors.false_positive_filters,
    gazetteer: detectors.gazetteer_data,
    countries: detectors.country_data,
    hotwords: support_data.hotwords,
    triggers: support_data.triggers,
    legal_forms: support_data.legal_forms,
    address_seed: support_data.address_seed,
    zones: support_data.zones,
    address_context: support_data.address_context,
    coreference: support_data.coreference,
    name_corpus: support_data.names,
    signatures: support_data.signature,
    dates: date_data,
    monetary: monetary_data,
  }
}

fn should_extract_monetary_data(config: &PreparedEngineSearchConfig) -> bool {
  config.regex_patterns.is_empty()
    || config
      .regex_meta
      .iter()
      .any(|meta| meta.label == "monetary amount")
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
