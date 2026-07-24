use crate::diagnostics::DiagnosticStage;
use crate::legal_forms::process_legal_form_matches;

use super::prelude::*;
use super::timed_entities;

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  LEGAL_FORM_RULE {
    id: DetectorId::LegalForm;
    stage: DiagnosticStage::EntityLegalForm;
    inputs: &[DetectorInput::RegexMatches, DetectorInput::FullText];
    uses: &[SupportResource::LegalForms];
    active: legal_form_is_active;
    detect: detect_legal_form;
  }
}

fn legal_form_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  Ok(!context.regex_matches()?.is_empty() && context.legal_form_data()?.is_some())
}

fn detect_legal_form(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  timed_entities(|| {
    let Some(data) = context.legal_form_data()? else {
      return Ok(Vec::new());
    };
    process_legal_form_matches(
      context.regex_matches()?,
      context.legal_forms_slice()?,
      context.full_text()?,
      data,
    )
  })
}
