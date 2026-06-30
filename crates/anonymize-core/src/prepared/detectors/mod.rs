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

pub(super) use address_seed::AddressSeedDetector;
pub(super) use anchored::AnchoredDetector;
pub(super) use legal_form::LegalFormDetector;
pub(super) use literal::{
  CountryDetector, DenyListDetector, GazetteerDetector,
};
pub(super) use name_corpus::NameCorpusDetector;
pub(super) use regex::{CustomRegexDetector, RegexDetector};
pub(super) use signature::SignatureDetector;
pub(super) use trigger::TriggerDetector;

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
