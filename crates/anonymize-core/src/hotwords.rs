use crate::byte_offsets::ByteOffsets;
use crate::processors::PatternSlice;
use crate::resolution::{PipelineEntity, SourceDetail};
use crate::types::{Error, Result, SearchMatch};

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct HotwordRuleData {
  pub rules: Vec<HotwordRule>,
  pub pattern_rule_indices: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct HotwordRule {
  pub target_labels: Vec<String>,
  pub score_adjustment: f64,
  pub reclassify_to: Option<String>,
  pub proximity_before: u32,
  pub proximity_after: u32,
}

pub(crate) fn apply_hotword_rules(
  entities: Vec<PipelineEntity>,
  full_text: &str,
  matches: &[SearchMatch],
  slice: PatternSlice,
  data: &HotwordRuleData,
  allowed_labels: &[String],
) -> Result<Vec<PipelineEntity>> {
  let hits_by_rule = collect_hits_by_rule(matches, slice, data)?;
  let offsets = ByteOffsets::new(full_text);
  let mut result = Vec::with_capacity(entities.len());

  for entity in entities {
    if caller_owned(&entity) {
      result.push(entity);
      continue;
    }

    let adjusted = apply_entity_rules(entity, &offsets, data, &hits_by_rule)?;
    if label_allowed(&adjusted.label, allowed_labels) {
      result.push(adjusted);
    }
  }

  Ok(result)
}

fn collect_hits_by_rule(
  matches: &[SearchMatch],
  slice: PatternSlice,
  data: &HotwordRuleData,
) -> Result<Vec<Vec<SearchMatch>>> {
  let mut hits_by_rule = vec![Vec::new(); data.rules.len()];

  for found in matches {
    let Some(local_index) = slice.local_index(found.pattern()) else {
      continue;
    };
    let Some(rule_index) = data.pattern_rule_indices.get(local_index) else {
      continue;
    };
    let Ok(rule_index) = usize::try_from(*rule_index) else {
      return Err(Error::InvalidStaticData {
        field: "hotword_data.pattern_rule_indices",
        reason: String::from("rule index exceeds usize range"),
      });
    };
    let Some(bucket) = hits_by_rule.get_mut(rule_index) else {
      return Err(Error::InvalidStaticData {
        field: "hotword_data.pattern_rule_indices",
        reason: String::from("rule index out of range"),
      });
    };
    bucket.push(*found);
  }

  Ok(hits_by_rule)
}

fn apply_entity_rules(
  mut entity: PipelineEntity,
  offsets: &ByteOffsets<'_>,
  data: &HotwordRuleData,
  hits_by_rule: &[Vec<SearchMatch>],
) -> Result<PipelineEntity> {
  let mut best = None::<HotwordAdjustment>;

  for (rule_index, rule) in data.rules.iter().enumerate() {
    if !rule
      .target_labels
      .iter()
      .any(|label| label == &entity.label)
    {
      continue;
    }
    let Some(rule_hits) = hits_by_rule.get(rule_index) else {
      continue;
    };
    for hit in rule_hits {
      let Some((distance, max_distance)) =
        hotword_distance(offsets, &entity, hit, rule)?
      else {
        continue;
      };
      let decay = if max_distance == 0 {
        1.0
      } else {
        1.0 - (f64::from(distance) / f64::from(max_distance))
      };
      let adjustment = rule.score_adjustment * decay;
      if adjustment.abs() <= f64::EPSILON {
        continue;
      }
      if best
        .as_ref()
        .is_some_and(|best| adjustment.abs() <= best.score.abs())
      {
        continue;
      }

      best = Some(HotwordAdjustment {
        score: adjustment,
        reclassify_to: if adjustment.is_sign_positive() {
          rule.reclassify_to.clone()
        } else {
          None
        },
      });
    }
  }

  let Some(best) = best else {
    return Ok(entity);
  };

  entity.score = (entity.score + best.score).clamp(0.0, 1.0);
  if let Some(label) = best.reclassify_to {
    entity.label = label;
  }
  Ok(entity)
}

fn hotword_distance(
  offsets: &ByteOffsets<'_>,
  entity: &PipelineEntity,
  hit: &SearchMatch,
  rule: &HotwordRule,
) -> Result<Option<(u32, u32)>> {
  let (distance, max_distance) = if hit.end() <= entity.start {
    (
      text_distance(offsets, hit.end(), entity.start)?,
      rule.proximity_before,
    )
  } else if hit.start() >= entity.end {
    (
      text_distance(offsets, entity.end, hit.start())?,
      rule.proximity_after,
    )
  } else {
    (0, u32::max(rule.proximity_before, rule.proximity_after))
  };

  if distance > max_distance {
    return Ok(None);
  }
  Ok(Some((distance, max_distance)))
}

fn text_distance(
  offsets: &ByteOffsets<'_>,
  start: u32,
  end: u32,
) -> Result<u32> {
  offsets.utf16_units_between(start, end)
}

const fn caller_owned(entity: &PipelineEntity) -> bool {
  matches!(
    entity.source_detail,
    Some(SourceDetail::CustomDenyList | SourceDetail::CustomRegex)
  )
}

fn label_allowed(label: &str, allowed_labels: &[String]) -> bool {
  allowed_labels.is_empty()
    || allowed_labels.iter().any(|allowed| allowed == label)
}

struct HotwordAdjustment {
  score: f64,
  reclassify_to: Option<String>,
}
