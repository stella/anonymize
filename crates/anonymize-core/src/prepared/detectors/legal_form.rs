use crate::diagnostics::DiagnosticStage;
use crate::legal_forms::process_legal_form_matches;
use crate::prepared::detector_contract::{
  StaticDetectorContext, StaticDetectorDiagnostics, StaticDetectorId,
  StaticDetectorInput, StaticDetectorRule, StaticDetectorSpec,
};
use crate::prepared::support_resources::SupportResourceId;
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) const LEGAL_FORM_RULE: StaticDetectorRule =
  StaticDetectorRule::declare(
    StaticDetectorSpec::define(
      StaticDetectorId::LegalForm,
      DiagnosticStage::EntityLegalForm,
    )
    .requires(&[
      StaticDetectorInput::RegexMatches,
      StaticDetectorInput::LegalFormData,
    ])
    .uses(&[SupportResourceId::LegalForms]),
    detect_legal_form,
  );

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
