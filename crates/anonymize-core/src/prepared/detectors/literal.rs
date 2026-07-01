use crate::diagnostics::DiagnosticStage;
use crate::prepared::detector_registry::{
  StaticDetectorContext, StaticDetectorDiagnostics, StaticDetectorId,
  StaticDetectorInput, StaticDetectorRule, StaticDetectorSpec,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::processors::{
  process_country_matches, process_deny_list_matches, process_gazetteer_matches,
};
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) const DENY_LIST_RULE: StaticDetectorRule =
  StaticDetectorRule::new(
    StaticDetectorSpec::new(
      StaticDetectorId::DenyList,
      DiagnosticStage::EntityDenyList,
      &[
        StaticDetectorInput::LiteralMatches,
        StaticDetectorInput::DenyListData,
      ],
      &[],
    ),
    detect_deny_list,
  );

pub(in crate::prepared) const GAZETTEER_RULE: StaticDetectorRule =
  StaticDetectorRule::new(
    StaticDetectorSpec::new(
      StaticDetectorId::Gazetteer,
      DiagnosticStage::EntityGazetteer,
      &[
        StaticDetectorInput::LiteralMatches,
        StaticDetectorInput::GazetteerData,
      ],
      &[],
    ),
    detect_gazetteer,
  );

pub(in crate::prepared) const COUNTRY_RULE: StaticDetectorRule =
  StaticDetectorRule::new(
    StaticDetectorSpec::new(
      StaticDetectorId::Country,
      DiagnosticStage::EntityCountry,
      &[
        StaticDetectorInput::LiteralMatches,
        StaticDetectorInput::CountryData,
      ],
      &[],
    ),
    detect_country,
  );

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
