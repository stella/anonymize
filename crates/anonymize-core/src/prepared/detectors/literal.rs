use crate::diagnostics::DiagnosticStage;
use crate::processors::{
  process_country_matches, process_deny_list_matches, process_gazetteer_matches,
};

use super::prelude::*;
use super::timed_entities;

static_detector_rule! {
  pub(in crate::prepared) const DENY_LIST_RULE;
  id: DetectorId::DenyList;
  stage: DiagnosticStage::EntityDenyList;
  inputs: &[
    DetectorInput::LiteralMatches,
    DetectorInput::DenyListData,
  ];
  active: deny_list_is_active;
  detect: detect_deny_list;
}

static_detector_rule! {
  pub(in crate::prepared) const GAZETTEER_RULE;
  id: DetectorId::Gazetteer;
  stage: DiagnosticStage::EntityGazetteer;
  inputs: &[
    DetectorInput::LiteralMatches,
    DetectorInput::GazetteerData,
  ];
  active: gazetteer_is_active;
  detect: detect_gazetteer;
}

static_detector_rule! {
  pub(in crate::prepared) const COUNTRY_RULE;
  id: DetectorId::Country;
  stage: DiagnosticStage::EntityCountry;
  inputs: &[
    DetectorInput::LiteralMatches,
    DetectorInput::CountryData,
  ];
  active: country_is_active;
  detect: detect_country;
}

const fn deny_list_is_active(context: &StaticDetectorContext<'_>) -> bool {
  !context.matches.literal.is_empty() && context.engine.data.deny_list.is_some()
}

const fn gazetteer_is_active(context: &StaticDetectorContext<'_>) -> bool {
  !context.matches.literal.is_empty() && context.engine.data.gazetteer.is_some()
}

const fn country_is_active(context: &StaticDetectorContext<'_>) -> bool {
  !context.matches.literal.is_empty() && context.engine.data.countries.is_some()
}

fn detect_deny_list(
  context: &StaticDetectorContext<'_>,
  _passes: &StaticEntityPasses,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let engine = context.engine;
  let matches = context.matches;
  let full_text = context.full_text;
  timed_entities(|| {
    let Some(data) = &engine.data.deny_list else {
      return Ok(Vec::new());
    };
    process_deny_list_matches(
      &matches.literal,
      engine.policy.slices.deny_list,
      full_text,
      data,
    )
  })
}

fn detect_gazetteer(
  context: &StaticDetectorContext<'_>,
  _passes: &StaticEntityPasses,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let engine = context.engine;
  let matches = context.matches;
  let full_text = context.full_text;
  timed_entities(|| {
    let Some(data) = &engine.data.gazetteer else {
      return Ok(Vec::new());
    };
    process_gazetteer_matches(
      &matches.literal,
      engine.policy.slices.gazetteer,
      full_text,
      data,
    )
  })
}

fn detect_country(
  context: &StaticDetectorContext<'_>,
  _passes: &StaticEntityPasses,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let engine = context.engine;
  let matches = context.matches;
  let full_text = context.full_text;
  timed_entities(|| {
    let Some(data) = &engine.data.countries else {
      return Ok(Vec::new());
    };
    process_country_matches(
      &matches.literal,
      engine.policy.slices.countries,
      full_text,
      data,
    )
  })
}
