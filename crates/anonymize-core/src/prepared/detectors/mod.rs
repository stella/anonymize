use std::time::Instant;

use crate::resolution::PipelineEntity;
use crate::types::Result;

use super::timing::{TimedEntities, elapsed_us};

mod address_seed;
mod anchored;
mod legal_form;
mod literal;
mod name_corpus;
mod regex;
mod signature;
mod trigger;

pub(super) use address_seed::ADDRESS_SEED_RULE;
pub(super) use anchored::ANCHORED_RULE;
pub(super) use legal_form::LEGAL_FORM_RULE;
pub(super) use literal::{COUNTRY_RULE, DENY_LIST_RULE, GAZETTEER_RULE};
pub(super) use name_corpus::NAME_CORPUS_RULE;
pub(super) use regex::{CUSTOM_REGEX_RULE, REGEX_RULE};
pub(super) use signature::SIGNATURE_RULE;
pub(super) use trigger::TRIGGER_RULE;

fn timed_entities<F>(detect: F) -> Result<TimedEntities>
where
  F: FnOnce() -> Result<Vec<PipelineEntity>>,
{
  let start = Instant::now();
  let entities = detect()?;
  Ok(TimedEntities {
    entities,
    elapsed_us: elapsed_us(start),
  })
}
