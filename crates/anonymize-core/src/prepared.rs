use crate::diagnostics::{DiagnosticEvent, StaticRedactionDiagnostics};
use crate::types::{OperatorConfig, Result};

mod artifacts;
mod config;
mod config_validation;
mod detection_phase;
mod detector_registry;
mod detectors;
mod diagnostic_stream;
mod engine_state;
mod entity_filter;
mod index_builder;
mod index_patterns;
mod index_prepare;
mod phase;
mod prepare_phase;
mod redaction_phase;
mod resolution_phase;
mod results;
mod search_matcher;
mod search_phase;
mod support_prepare;
mod support_resources;
mod support_slots;
mod timing;

pub use artifacts::{PreparedEngineArtifacts, PreparedEngineArtifactsView};
pub use config::{
  PreparedEngineConfig, PreparedEngineDetectorConfig,
  PreparedEnginePolicyConfig, PreparedEngineSearchConfig, PreparedEngineSlices,
};
use diagnostic_stream::DiagnosticEventStream;
use engine_state::{PipelinePolicy, PreparedStaticData, SearchIndexes};
pub use results::{
  PreparedEngineBuildResult, PreparedEngineMatches, StaticDetectionResult,
  StaticEntityLayers, StaticRedactionDiagnosticResult, StaticRedactionResult,
};

pub struct PreparedEngine {
  indexes: SearchIndexes,
  policy: PipelinePolicy,
  data: PreparedStaticData,
}

impl PreparedEngine {
  pub fn redact_static_entities(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
  ) -> Result<StaticRedactionResult> {
    let mut event_stream = DiagnosticEventStream::none();
    self.redact_static_entities_inner(
      full_text,
      operators,
      None,
      &mut event_stream,
    )
  }

  pub fn redact_static_entities_with_diagnostics(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
  ) -> Result<StaticRedactionDiagnosticResult> {
    let mut diagnostics = StaticRedactionDiagnostics::default();
    let mut event_stream = DiagnosticEventStream::none();
    let result = self.redact_static_entities_inner(
      full_text,
      operators,
      Some(&mut diagnostics),
      &mut event_stream,
    )?;

    Ok(StaticRedactionDiagnosticResult {
      result,
      diagnostics,
    })
  }

  pub fn redact_static_entities_with_summary_diagnostics(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
  ) -> Result<StaticRedactionDiagnosticResult> {
    let mut diagnostics = StaticRedactionDiagnostics::summary();
    let mut event_stream = DiagnosticEventStream::none();
    let result = self.redact_static_entities_inner(
      full_text,
      operators,
      Some(&mut diagnostics),
      &mut event_stream,
    )?;

    Ok(StaticRedactionDiagnosticResult {
      result,
      diagnostics,
    })
  }

  pub fn redact_static_entities_with_diagnostics_observer<F>(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
    mut observer: F,
  ) -> Result<StaticRedactionDiagnosticResult>
  where
    F: FnMut(&[DiagnosticEvent]) -> Result<()>,
  {
    let mut diagnostics = StaticRedactionDiagnostics::default();
    let mut event_stream = DiagnosticEventStream::observed(&mut observer);
    let result = self.redact_static_entities_inner(
      full_text,
      operators,
      Some(&mut diagnostics),
      &mut event_stream,
    )?;

    Ok(StaticRedactionDiagnosticResult {
      result,
      diagnostics,
    })
  }
}
