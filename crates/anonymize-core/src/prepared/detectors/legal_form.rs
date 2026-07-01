use crate::legal_forms::process_legal_form_matches;

use super::prelude::*;
use super::timed_entities;

static_detector_rule! {
  pub(in crate::prepared) const LEGAL_FORM_RULE;
  id: DetectorId::LegalForm;
  inputs: &[DetectorInput::RegexMatches];
  uses: &[SupportResource::LegalForms];
  active: legal_form_is_active;
  detect: detect_legal_form;
}

const fn legal_form_is_active(context: &StaticDetectorContext<'_>) -> bool {
  !context.matches.regex.is_empty()
    && context.engine.data.legal_forms.is_some()
}

fn detect_legal_form(
  context: &StaticDetectorContext<'_>,
  _passes: &StaticEntityPasses,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let engine = context.engine;
  let matches = context.matches;
  let full_text = context.full_text;
  timed_entities(|| {
    let Some(data) = &engine.data.legal_forms else {
      return Ok(Vec::new());
    };
    process_legal_form_matches(
      &matches.regex,
      engine.policy.slices.legal_forms,
      full_text,
      data,
    )
  })
}
