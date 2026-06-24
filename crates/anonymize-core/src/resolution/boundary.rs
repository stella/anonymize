use std::collections::{BTreeMap, BTreeSet};

use crate::byte_offsets::ByteOffsets;
use crate::types::Result;

use super::common::{byte_len, contains_span, entity_len, is_caller_owned};
use super::{DetectionSource, PipelineEntity};

pub fn enforce_boundary_consistency(
  entities: &[PipelineEntity],
  full_text: &str,
) -> Result<Vec<PipelineEntity>> {
  let offsets = ByteOffsets::new(full_text);
  let spans = char_spans(full_text);
  let boundaries = word_boundaries(&spans);
  let fixed =
    fix_partial_words(entities, full_text, &offsets, &spans, &boundaries)?;
  let resolved = resolve_cross_label_overlaps(&fixed, full_text, &offsets)?;
  let deduped = deduplicate_spans(&resolved);
  let merged = merge_adjacent(&deduped, full_text, &offsets)?;
  Ok(remove_nested_same_label(&merged))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CharSpan {
  start: u32,
  end: u32,
  ch: char,
}

fn fix_partial_words(
  entities: &[PipelineEntity],
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  spans: &[CharSpan],
  boundaries: &BTreeSet<u32>,
) -> Result<Vec<PipelineEntity>> {
  let mut sorted = entities.to_vec();
  sorted.sort_by_key(|entity| entity.start);
  let mut fixed = Vec::with_capacity(sorted.len());

  for (index, entity) in sorted.iter().enumerate() {
    if has_locked_boundary(entity) || has_detector_locked_boundary(entity) {
      fixed.push(entity.clone());
      continue;
    }

    if entity.text != offsets.slice(full_text, entity.start, entity.end)? {
      fixed.push(entity.clone());
      continue;
    }

    let mut new_start = word_start_at(entity.start, boundaries, spans);
    let mut new_end = word_end_at(entity.end, boundaries, spans);

    for (other_index, other) in sorted.iter().enumerate() {
      if other_index == index || other.label == entity.label {
        continue;
      }
      if other.end > new_start && other.end <= entity.start {
        new_start = new_start.max(other.end);
      }
      if other.start >= entity.end && other.start < new_end {
        new_end = new_end.min(other.start);
      }
    }

    if new_start == entity.start && new_end == entity.end {
      fixed.push(entity.clone());
      continue;
    }

    let mut adjusted = entity.clone();
    adjusted.start = new_start;
    adjusted.end = new_end;
    adjusted.text = offsets.slice(full_text, new_start, new_end)?;
    fixed.push(adjusted);
  }

  Ok(fixed)
}

fn resolve_cross_label_overlaps(
  entities: &[PipelineEntity],
  full_text: &str,
  offsets: &ByteOffsets<'_>,
) -> Result<Vec<PipelineEntity>> {
  let mut sorted = entities.to_vec();
  sorted.sort_by_key(|entity| entity.start);

  let mut left_index = 0;
  while left_index < sorted.len() {
    let mut right_index = left_index.saturating_add(1);
    while right_index < sorted.len() {
      let Some(left) = sorted.get(left_index) else {
        break;
      };
      let Some(right) = sorted.get(right_index) else {
        break;
      };
      if right.start >= left.end {
        break;
      }
      if left.label == right.label
        || contains_span(left, right)
        || contains_span(right, left)
      {
        right_index = right_index.saturating_add(1);
        continue;
      }

      let left_len = entity_len(left);
      let right_len = entity_len(right);
      let left_locked = has_locked_boundary(left);
      let right_locked = has_locked_boundary(right);
      let left_wins = if left_locked == right_locked {
        match left.score.total_cmp(&right.score) {
          std::cmp::Ordering::Greater => true,
          std::cmp::Ordering::Less => false,
          std::cmp::Ordering::Equal => left_len >= right_len,
        }
      } else {
        left_locked
      };

      if left_wins {
        let new_start = left.end;
        if let Some(right_mut) = sorted.get_mut(right_index) {
          right_mut.start = new_start;
          right_mut.text =
            offsets.slice(full_text, new_start, right_mut.end)?;
        }
        right_index = right_index.saturating_add(1);
        continue;
      }

      let new_end = right.start;
      if let Some(left_mut) = sorted.get_mut(left_index) {
        left_mut.end = new_end;
        left_mut.text = offsets.slice(full_text, left_mut.start, new_end)?;
      }
      break;
    }

    left_index = left_index.saturating_add(1);
  }

  Ok(
    sorted
      .into_iter()
      .filter(|entity| entity.start < entity.end)
      .collect(),
  )
}

fn deduplicate_spans(entities: &[PipelineEntity]) -> Vec<PipelineEntity> {
  let mut seen = BTreeMap::<(u32, u32, String), PipelineEntity>::new();

  for entity in entities {
    let key = (entity.start, entity.end, entity.label.clone());
    let replace = seen
      .get(&key)
      .is_none_or(|existing| entity.score.total_cmp(&existing.score).is_gt());
    if replace {
      seen.insert(key, entity.clone());
    }
  }

  seen.into_values().collect()
}

fn merge_adjacent(
  entities: &[PipelineEntity],
  full_text: &str,
  offsets: &ByteOffsets<'_>,
) -> Result<Vec<PipelineEntity>> {
  let mut sorted = entities.to_vec();
  sorted.sort_by_key(|entity| entity.start);
  let mut result = Vec::<PipelineEntity>::new();
  let mut last_by_label = BTreeMap::<String, usize>::new();

  for entity in &sorted {
    if has_locked_boundary(entity) {
      result.push(entity.clone());
      continue;
    }

    let Some(previous_index) = last_by_label.get(&entity.label).copied() else {
      let index = result.len();
      result.push(entity.clone());
      last_by_label.insert(entity.label.clone(), index);
      continue;
    };

    let Some(previous) = result.get(previous_index) else {
      let index = result.len();
      result.push(entity.clone());
      last_by_label.insert(entity.label.clone(), index);
      continue;
    };

    if !has_locked_boundary(previous) && entity.start < previous.end {
      merge_into_previous(
        &mut result,
        previous_index,
        entity,
        full_text,
        offsets,
      )?;
      continue;
    }

    let gap = offsets.slice(full_text, previous.end, entity.start)?;
    let gap_start = previous.end;
    let gap_end = entity.start;
    let gap_occupied = sorted.iter().any(|other| {
      other.label != entity.label
        && other.start < gap_end
        && other.end > gap_start
    });
    let legal_form_comma = (is_legal_form_organization(previous)
      || is_legal_form_organization(entity))
      && gap.contains(',');

    if !has_locked_boundary(previous)
      && !legal_form_comma
      && entity.label != "country"
      && !gap_occupied
      && is_mergeable_gap(&gap)
    {
      merge_into_previous(
        &mut result,
        previous_index,
        entity,
        full_text,
        offsets,
      )?;
      continue;
    }

    let index = result.len();
    result.push(entity.clone());
    last_by_label.insert(entity.label.clone(), index);
  }

  Ok(result)
}

fn remove_nested_same_label(
  entities: &[PipelineEntity],
) -> Vec<PipelineEntity> {
  let mut sorted = entities.to_vec();
  sorted.sort_by(|left, right| {
    left
      .start
      .cmp(&right.start)
      .then_with(|| entity_len(right).cmp(&entity_len(left)))
  });

  let mut result = Vec::new();
  let mut max_end_by_label = BTreeMap::<String, u32>::new();

  for entity in sorted {
    if max_end_by_label
      .get(&entity.label)
      .is_some_and(|max_end| entity.end <= *max_end)
    {
      continue;
    }
    max_end_by_label.insert(entity.label.clone(), entity.end);
    result.push(entity);
  }

  result
}

fn char_spans(text: &str) -> Vec<CharSpan> {
  let mut spans = Vec::new();
  let mut offset = 0_u32;

  for ch in text.chars() {
    let width = u32::try_from(ch.len_utf8()).unwrap_or(u32::MAX);
    let end = offset.saturating_add(width);
    spans.push(CharSpan {
      start: offset,
      end,
      ch,
    });
    offset = end;
  }

  spans
}

fn word_boundaries(spans: &[CharSpan]) -> BTreeSet<u32> {
  let mut boundaries = BTreeSet::new();
  let mut run_start = None::<u32>;
  let mut run_end = None::<u32>;

  for (index, span) in spans.iter().enumerate() {
    if is_word_body(span.ch) || is_word_connector_between(spans, index) {
      if run_start.is_none() {
        run_start = Some(span.start);
      }
      run_end = Some(span.end);
      continue;
    }

    if let (Some(start), Some(end)) = (run_start.take(), run_end.take()) {
      boundaries.insert(start);
      boundaries.insert(end);
    }
  }

  if let (Some(start), Some(end)) = (run_start, run_end) {
    boundaries.insert(start);
    boundaries.insert(end);
  }

  boundaries
}

fn is_word_connector_between(spans: &[CharSpan], index: usize) -> bool {
  let Some(span) = spans.get(index) else {
    return false;
  };
  if !is_word_connector(span.ch) {
    return false;
  }

  let Some(previous) = index.checked_sub(1).and_then(|prev| spans.get(prev))
  else {
    return false;
  };
  let Some(next) = spans.get(index.saturating_add(1)) else {
    return false;
  };

  is_word_body(previous.ch) && is_word_body(next.ch)
}

const fn is_word_connector(ch: char) -> bool {
  matches!(ch, '\'' | '\u{2018}' | '\u{2019}' | '\u{02bc}' | '\u{ff07}')
}

fn is_word_body(ch: char) -> bool {
  ch.is_alphanumeric() || is_combining_mark(ch)
}

const fn is_combining_mark(ch: char) -> bool {
  matches!(
    ch,
    '\u{0300}'..='\u{036f}'
      | '\u{1ab0}'..='\u{1aff}'
      | '\u{1dc0}'..='\u{1dff}'
      | '\u{20d0}'..='\u{20ff}'
      | '\u{fe20}'..='\u{fe2f}'
  )
}

fn word_start_at(
  position: u32,
  boundaries: &BTreeSet<u32>,
  spans: &[CharSpan],
) -> u32 {
  let mut cursor = position;
  while cursor > 0 && !boundaries.contains(&cursor) {
    let Some(previous) = spans.iter().rev().find(|span| span.end <= cursor)
    else {
      return cursor;
    };
    if is_word_start_stop(previous.ch) {
      return cursor;
    }
    cursor = previous.start;
  }
  cursor
}

fn word_end_at(
  position: u32,
  boundaries: &BTreeSet<u32>,
  spans: &[CharSpan],
) -> u32 {
  let mut cursor = position;
  let text_end = spans.last().map_or(0, |span| span.end);
  while cursor < text_end && !boundaries.contains(&cursor) {
    let Some(next) = spans.iter().find(|span| span.start >= cursor) else {
      return cursor;
    };
    if is_word_end_stop(next.ch) {
      return cursor;
    }
    cursor = next.end;
  }
  cursor
}

fn merge_into_previous(
  entities: &mut [PipelineEntity],
  previous_index: usize,
  entity: &PipelineEntity,
  full_text: &str,
  offsets: &ByteOffsets<'_>,
) -> Result<()> {
  if let Some(previous) = entities.get_mut(previous_index) {
    previous.end = previous.end.max(entity.end);
    previous.text = offsets.slice(full_text, previous.start, previous.end)?;
    if entity.score.total_cmp(&previous.score).is_gt() {
      previous.score = entity.score;
    }
  }
  Ok(())
}

const fn has_locked_boundary(entity: &PipelineEntity) -> bool {
  is_caller_owned(entity)
}

fn has_detector_locked_boundary(entity: &PipelineEntity) -> bool {
  entity.label == "phone number" && entity.source == DetectionSource::Trigger
}

fn is_legal_form_organization(entity: &PipelineEntity) -> bool {
  entity.label == "organization" && entity.source == DetectionSource::LegalForm
}

fn is_mergeable_gap(gap: &str) -> bool {
  gap.is_empty()
    || (byte_len(gap) <= 3
      && gap.chars().all(|ch| matches!(ch, ' ' | '\t' | ',' | '-')))
}

const fn is_word_start_stop(ch: char) -> bool {
  matches!(ch, '\n' | '\r' | ',' | ';' | '(' | ')' | '[' | ']' | '&')
}

const fn is_word_end_stop(ch: char) -> bool {
  matches!(
    ch,
    '\n' | '\r' | ',' | ';' | '.' | '(' | ')' | '[' | ']' | '&'
  )
}
