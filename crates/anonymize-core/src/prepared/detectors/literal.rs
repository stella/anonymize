use crate::diagnostics::DiagnosticStage;
use crate::processors::{
  process_country_matches, process_deny_list_matches, process_gazetteer_matches,
};

use super::prelude::*;
use super::timed_entities;

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  DENY_LIST_RULE {
    id: DetectorId::DenyList;
    stage: DiagnosticStage::EntityDenyList;
    inputs: &[
      DetectorInput::LiteralMatches,
      DetectorInput::DenyListData,
      DetectorInput::FullText,
    ];
    active: deny_list_is_active;
    detect: detect_deny_list;
  }
  GAZETTEER_RULE {
    id: DetectorId::Gazetteer;
    stage: DiagnosticStage::EntityGazetteer;
    inputs: &[
      DetectorInput::LiteralMatches,
      DetectorInput::GazetteerData,
      DetectorInput::FullText,
    ];
    active: gazetteer_is_active;
    detect: detect_gazetteer;
  }
  COUNTRY_RULE {
    id: DetectorId::Country;
    stage: DiagnosticStage::EntityCountry;
    inputs: &[
      DetectorInput::LiteralMatches,
      DetectorInput::CountryData,
      DetectorInput::FullText,
    ];
    active: country_is_active;
    detect: detect_country;
  }
}

fn deny_list_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  Ok(!context.literal_matches()?.is_empty() && context.deny_list_data()?.is_some())
}

fn gazetteer_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  Ok(!context.literal_matches()?.is_empty() && context.gazetteer_data()?.is_some())
}

fn country_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  Ok(!context.literal_matches()?.is_empty() && context.country_data()?.is_some())
}

fn detect_deny_list(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  timed_entities(|| {
    let Some(data) = context.deny_list_data()? else {
      return Ok(Vec::new());
    };
    process_deny_list_matches(
      context.literal_matches()?,
      context.deny_list_slice()?,
      context.full_text()?,
      data,
    )
  })
}

fn detect_gazetteer(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  timed_entities(|| {
    let Some(data) = context.gazetteer_data()? else {
      return Ok(Vec::new());
    };
    process_gazetteer_matches(
      context.literal_matches()?,
      context.gazetteer_slice()?,
      context.full_text()?,
      data,
    )
  })
}

fn detect_country(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  timed_entities(|| {
    let Some(data) = context.country_data()? else {
      return Ok(Vec::new());
    };
    process_country_matches(
      context.literal_matches()?,
      context.countries_slice()?,
      context.full_text()?,
      data,
    )
  })
}
