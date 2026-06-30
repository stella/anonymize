use crate::byte_offsets::ByteOffsets;
use crate::resolution::{PipelineEntity, SourceDetail};
use crate::types::{Error, Result};

const NEAR_MISS_BAND: f64 = 0.15;
const BOOST_PER_NEIGHBOUR: f64 = 0.05;
const CONTEXT_WINDOW_CHARS: f64 = 150.0;
const HIGH_CONFIDENCE_FLOOR: f64 = 0.9;

pub(super) fn filter_entities_for_config(
  entities: Vec<PipelineEntity>,
  threshold: f64,
  allowed_labels: &[String],
) -> Vec<PipelineEntity> {
  filter_entities_for_threshold(
    filter_entities_for_labels(entities, allowed_labels),
    threshold,
  )
}

pub(super) fn filter_entities_for_redaction(
  entities: Vec<PipelineEntity>,
  full_text: &str,
  threshold: f64,
  confidence_boost: bool,
  allowed_labels: &[String],
) -> Result<Vec<PipelineEntity>> {
  let entities = filter_entities_for_labels(entities, allowed_labels);
  if confidence_boost {
    return boost_near_miss_entities(entities, full_text, threshold);
  }
  Ok(filter_entities_for_threshold(entities, threshold))
}

pub(super) fn filter_entities_for_labels(
  entities: Vec<PipelineEntity>,
  allowed_labels: &[String],
) -> Vec<PipelineEntity> {
  entities
    .into_iter()
    .filter(|entity| {
      allowed_labels.is_empty()
        || allowed_labels.iter().any(|label| label == &entity.label)
    })
    .collect()
}

pub(super) fn label_is_allowed(label: &str, allowed_labels: &[String]) -> bool {
  allowed_labels.is_empty()
    || allowed_labels.iter().any(|allowed| allowed == label)
}

pub(super) fn clear_internal_source_details(entities: &mut [PipelineEntity]) {
  for entity in entities {
    if entity.source_detail == Some(SourceDetail::AddressContext) {
      entity.source_detail = None;
    }
  }
}

fn filter_entities_for_threshold(
  entities: Vec<PipelineEntity>,
  threshold: f64,
) -> Vec<PipelineEntity> {
  entities
    .into_iter()
    .filter(|entity| {
      entity.score >= threshold
        || entity.source_detail == Some(SourceDetail::AddressContext)
    })
    .collect()
}

fn boost_near_miss_entities(
  entities: Vec<PipelineEntity>,
  full_text: &str,
  threshold: f64,
) -> Result<Vec<PipelineEntity>> {
  let near_miss_floor = f64::max(0.0, threshold - NEAR_MISS_BAND);
  let byte_offsets = ByteOffsets::new(full_text);
  let text_offsets = TextOffsetMap::new(full_text);
  let anchors = entities
    .iter()
    .filter(|entity| entity.score >= HIGH_CONFIDENCE_FLOOR)
    .map(|entity| entity_midpoint(entity, &byte_offsets, &text_offsets))
    .collect::<Result<Vec<_>>>()?;

  let mut boosted = Vec::with_capacity(entities.len());
  for mut entity in entities {
    if entity.score >= threshold {
      boosted.push(entity);
      continue;
    }
    if entity.score < near_miss_floor {
      continue;
    }

    let midpoint = entity_midpoint(&entity, &byte_offsets, &text_offsets)?;
    let neighbours = anchors
      .iter()
      .filter(|anchor| (midpoint - **anchor).abs() <= CONTEXT_WINDOW_CHARS)
      .count();
    let neighbour_count = u32::try_from(neighbours).unwrap_or(u32::MAX);
    let boosted_score =
      f64::from(neighbour_count).mul_add(BOOST_PER_NEIGHBOUR, entity.score);
    if boosted_score < threshold {
      continue;
    }

    entity.score = f64::min(1.0, boosted_score);
    boosted.push(entity);
  }

  Ok(boosted)
}

fn entity_midpoint(
  entity: &PipelineEntity,
  byte_offsets: &ByteOffsets<'_>,
  text_offsets: &TextOffsetMap,
) -> Result<f64> {
  let start = text_offsets.offset_for(byte_offsets, entity.start)?;
  let end = text_offsets.offset_for(byte_offsets, entity.end)?;
  Ok(f64::midpoint(start, end))
}

struct TextOffsetMap {
  byte_offsets: Vec<usize>,
}

impl TextOffsetMap {
  fn new(full_text: &str) -> Self {
    let mut byte_offsets = full_text
      .char_indices()
      .map(|(byte_offset, _)| byte_offset)
      .collect::<Vec<_>>();
    byte_offsets.push(full_text.len());
    Self { byte_offsets }
  }

  fn offset_for(
    &self,
    byte_offsets: &ByteOffsets<'_>,
    offset: u32,
  ) -> Result<f64> {
    let byte_offset = byte_offsets.validate_offset(offset)?;
    let index = self
      .byte_offsets
      .binary_search(&byte_offset)
      .map_err(|_| Error::ByteOffsetInsideCodepoint { offset })?;
    let index = u32::try_from(index)
      .map_err(|_| Error::ByteOffsetOutOfBounds { offset: u32::MAX })?;
    Ok(f64::from(index))
  }
}
