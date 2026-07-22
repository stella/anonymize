use std::collections::{BTreeMap, BTreeSet};

use crate::byte_offsets::ByteOffsets;
use crate::signatures::PersonSpanTerminators;
use crate::types::Result;

use super::common::{byte_len, contains_span, entity_len, is_caller_owned};
use super::{DetectionSource, PipelineEntity};

/// Inputs to the boundary pass. `person_terminators` is empty when the
/// engine has no signature data, which disables person-span truncation.
#[derive(Clone, Copy, Debug)]
pub struct BoundaryParams<'a> {
  pub entities: &'a [PipelineEntity],
  pub full_text: &'a str,
  pub person_terminators: PersonSpanTerminators<'a>,
}

pub fn enforce_boundary_consistency(
  params: BoundaryParams<'_>,
) -> Result<Vec<PipelineEntity>> {
  let BoundaryParams {
    entities,
    full_text,
    person_terminators,
  } = params;
  let offsets = ByteOffsets::new(full_text);
  let spans = char_spans(full_text);
  let boundaries = word_boundaries(&spans);
  let fixed = fix_partial_words(entities, &offsets, &spans, &boundaries)?;
  // Truncation runs after word-boundary expansion so expansion cannot push a
  // person span back across a terminator it was just pulled behind.
  let truncated =
    truncate_person_spans(&fixed, full_text, &offsets, person_terminators)?;
  let resolved = resolve_cross_label_overlaps(&truncated, &offsets)?;
  let deduped = deduplicate_spans(&resolved);
  let merged = merge_adjacent(&deduped, &offsets)?;
  Ok(remove_nested_same_label(&merged))
}

/// Stop person spans at a signature-stamp phrase or a form-field label.
///
/// Stamp phrases are configured terminators, while field labels are exact,
/// language-keyed vocabulary from `signature-detection.json`.
fn truncate_person_spans(
  entities: &[PipelineEntity],
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  terminators: PersonSpanTerminators<'_>,
) -> Result<Vec<PipelineEntity>> {
  if terminators.stamp_phrases.is_empty() && terminators.field_labels.is_empty()
  {
    return Ok(entities.to_vec());
  }

  let mut result = Vec::with_capacity(entities.len());
  for entity in entities {
    if entity.label != crate::labels::PERSON_LABEL
      || has_locked_boundary(entity)
    {
      result.push(entity.clone());
      continue;
    }

    if let Some(prefix_end) =
      leading_terminator_end(full_text, entity, terminators)
    {
      // A detector may include both a leading signing-software stamp and the
      // signer. Retain the name after the exact terminator; only discard the
      // entity when it contains no text beyond that prefix.
      let trimmed_start = trim_leading_separator(full_text, prefix_end);
      if trimmed_start >= entity.end {
        continue;
      }
      let mut adjusted = entity.clone();
      adjusted.start = trimmed_start;
      adjusted.text = offsets.slice(trimmed_start, entity.end)?;
      result.push(adjusted);
      continue;
    }

    let Some(cut) = terminator_start_within(full_text, entity, terminators)
    else {
      result.push(entity.clone());
      continue;
    };

    let trimmed_end = trim_trailing_space(full_text, entity.start, cut);
    if trimmed_end <= entity.start {
      continue;
    }

    let mut adjusted = entity.clone();
    adjusted.end = trimmed_end;
    adjusted.text = offsets.slice(entity.start, trimmed_end)?;
    result.push(adjusted);
  }

  Ok(result)
}

fn leading_terminator_end(
  full_text: &str,
  entity: &PipelineEntity,
  terminators: PersonSpanTerminators<'_>,
) -> Option<u32> {
  let Ok(start) = usize::try_from(entity.start) else {
    return None;
  };
  let tail = full_text.get(start..).unwrap_or_default();
  stamp_phrase_end(tail, terminators.stamp_phrases)
    .or_else(|| field_label_end(tail, terminators.field_labels))
    .and_then(|relative| u32::try_from(start.saturating_add(relative)).ok())
}

/// Byte offset of the first terminator beginning inside the entity span.
///
/// A stamp phrase may run past `entity.end` (the detector stops at the name,
/// so "Karel Digitálně" holds only the first word of "digitálně podepsal"),
/// so phrases are matched against the full text from each candidate token.
fn terminator_start_within(
  full_text: &str,
  entity: &PipelineEntity,
  terminators: PersonSpanTerminators<'_>,
) -> Option<u32> {
  let start = usize::try_from(entity.start).ok()?;
  let end = usize::try_from(entity.end).ok()?;
  let window = full_text.get(start..end)?;

  window
    .char_indices()
    .filter(|&(offset, _)| {
      offset > 0 && is_token_start(window, offset) && offset < end
    })
    .find(|&(offset, _)| {
      let absolute = start.saturating_add(offset);
      let tail = full_text.get(absolute..).unwrap_or_default();
      starts_with_stamp_phrase(tail, terminators.stamp_phrases)
        || is_colon_tied_field_label(tail, terminators.field_labels)
    })
    .and_then(|(offset, _)| u32::try_from(start.saturating_add(offset)).ok())
}

fn starts_with_stamp_phrase(tail: &str, phrases: &[String]) -> bool {
  stamp_phrase_end(tail, phrases).is_some()
}

fn stamp_phrase_end(tail: &str, phrases: &[String]) -> Option<usize> {
  phrases.iter().find_map(|phrase| {
    if !starts_with_ignore_case(tail, phrase) {
      return None;
    }
    let rest = remainder_after_chars(tail, phrase.chars().count())?;
    if rest.chars().next().is_some_and(char::is_alphanumeric) {
      return None;
    }
    Some(tail.len().saturating_sub(rest.len()))
  })
}

/// A field label counts only when optional whitespace after it ends in a colon.
/// Without the colon, "Name" and "Jméno" are ordinary words, and a surname
/// that happens to collide with the vocabulary keeps its place in the span.
fn is_colon_tied_field_label(tail: &str, labels: &[String]) -> bool {
  field_label_end(tail, labels).is_some()
}

fn field_label_end(tail: &str, labels: &[String]) -> Option<usize> {
  labels.iter().find_map(|label| {
    if !starts_with_ignore_case(tail, label) {
      return None;
    }
    let after_label = remainder_after_chars(tail, label.chars().count())?;
    let after_space = after_label.trim_start();
    let separator = after_space.chars().next()?;
    matches!(separator, ':' | '：').then(|| {
      let label_end = tail.len().saturating_sub(after_label.len());
      let separator_start = tail.len().saturating_sub(after_space.len());
      label_end.max(separator_start.saturating_add(separator.len_utf8()))
    })
  })
}

fn trim_leading_separator(full_text: &str, start: u32) -> u32 {
  let Ok(start_index) = usize::try_from(start) else {
    return start;
  };
  let tail = full_text.get(start_index..).unwrap_or_default();
  let trimmed = tail.trim_start_matches(|character: char| {
    character.is_whitespace() || matches!(character, ':' | '：' | '-' | '–')
  });
  u32::try_from(full_text.len().saturating_sub(trimmed.len())).unwrap_or(start)
}

fn remainder_after_chars(value: &str, count: usize) -> Option<&str> {
  if count == value.chars().count() {
    return Some("");
  }
  let index = value.char_indices().nth(count)?.0;
  value.get(index..)
}

/// Case-insensitive prefix test. `needle` is lowercased at prepare time.
fn starts_with_ignore_case(haystack: &str, needle: &str) -> bool {
  let mut lowered = haystack.chars().flat_map(char::to_lowercase);
  needle
    .chars()
    .all(|expected| lowered.next() == Some(expected))
}

fn is_token_start(window: &str, offset: usize) -> bool {
  window
    .get(..offset)
    .and_then(|prefix| prefix.chars().next_back())
    .is_none_or(|previous| !previous.is_alphanumeric())
}

fn trim_trailing_space(full_text: &str, start: u32, end: u32) -> u32 {
  let (Ok(start_index), Ok(end_index)) =
    (usize::try_from(start), usize::try_from(end))
  else {
    return end;
  };
  let Some(slice) = full_text.get(start_index..end_index) else {
    return end;
  };
  let trimmed = slice.trim_end();
  start.saturating_add(byte_len(trimmed))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CharSpan {
  start: u32,
  end: u32,
  ch: char,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LabelSummary {
  Empty,
  Uniform(usize),
  Mixed,
}

impl LabelSummary {
  const fn combine(left: Self, right: Self) -> Self {
    match (left, right) {
      (Self::Empty, summary) | (summary, Self::Empty) => summary,
      (Self::Uniform(left_label), Self::Uniform(right_label))
        if left_label == right_label =>
      {
        Self::Uniform(left_label)
      }
      _ => Self::Mixed,
    }
  }

  const fn has_different_label(self, excluded_label: usize) -> bool {
    match self {
      Self::Empty => false,
      Self::Uniform(label) => label != excluded_label,
      Self::Mixed => true,
    }
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct BoundaryPoint {
  position: u32,
  label_id: usize,
}

// Each tree node records whether all positions below it share one label.
// A query can therefore discard a same-label subtree in one step and descend
// only toward the nearest cross-label start or end.
#[derive(Debug)]
struct BoundaryPositionIndex {
  points: Vec<BoundaryPoint>,
  summaries: Vec<LabelSummary>,
  leaf_count: usize,
}

#[derive(Debug, Default)]
struct BoundarySearchResult {
  position: Option<u32>,
  #[cfg(test)]
  node_visits: usize,
}

impl BoundaryPositionIndex {
  fn new(
    entities: &[PipelineEntity],
    label_ids: &[usize],
    position: impl Fn(&PipelineEntity) -> u32,
  ) -> Self {
    let mut points = entities
      .iter()
      .zip(label_ids)
      .map(|(entity, &label_id)| BoundaryPoint {
        position: position(entity),
        label_id,
      })
      .collect::<Vec<_>>();
    points.sort_by_key(|point| point.position);

    let leaf_count = points.len().next_power_of_two();
    let mut summaries = vec![LabelSummary::Empty; leaf_count.saturating_mul(2)];
    for (index, point) in points.iter().enumerate() {
      if let Some(summary) = summaries.get_mut(leaf_count.saturating_add(index))
      {
        *summary = LabelSummary::Uniform(point.label_id);
      }
    }
    for index in (1..leaf_count).rev() {
      let left = summaries
        .get(index.saturating_mul(2))
        .copied()
        .unwrap_or(LabelSummary::Empty);
      let right = summaries
        .get(index.saturating_mul(2).saturating_add(1))
        .copied()
        .unwrap_or(LabelSummary::Empty);
      if let Some(summary) = summaries.get_mut(index) {
        *summary = LabelSummary::combine(left, right);
      }
    }

    Self {
      points,
      summaries,
      leaf_count,
    }
  }

  fn leftmost_different(
    &self,
    start: u32,
    end: u32,
    excluded_label: usize,
  ) -> BoundarySearchResult {
    let query_start =
      self.points.partition_point(|point| point.position < start);
    let query_end = self.points.partition_point(|point| point.position < end);
    #[cfg(test)]
    let mut node_visits = 0_usize;
    #[cfg(test)]
    let mut record_visit = || {
      node_visits = node_visits.saturating_add(1);
    };
    #[cfg(not(test))]
    let mut record_visit = || {};
    let position = self.find_different(
      BoundarySearchParams {
        node: 1,
        node_start: 0,
        node_end: self.leaf_count,
        query_start,
        query_end,
        excluded_label,
        direction: SearchDirection::Leftmost,
      },
      &mut record_visit,
    );
    BoundarySearchResult {
      position,
      #[cfg(test)]
      node_visits,
    }
  }

  fn rightmost_different(
    &self,
    start_exclusive: u32,
    end_inclusive: u32,
    excluded_label: usize,
  ) -> BoundarySearchResult {
    let query_start = self
      .points
      .partition_point(|point| point.position <= start_exclusive);
    let query_end = self
      .points
      .partition_point(|point| point.position <= end_inclusive);
    #[cfg(test)]
    let mut node_visits = 0_usize;
    #[cfg(test)]
    let mut record_visit = || {
      node_visits = node_visits.saturating_add(1);
    };
    #[cfg(not(test))]
    let mut record_visit = || {};
    let position = self.find_different(
      BoundarySearchParams {
        node: 1,
        node_start: 0,
        node_end: self.leaf_count,
        query_start,
        query_end,
        excluded_label,
        direction: SearchDirection::Rightmost,
      },
      &mut record_visit,
    );
    BoundarySearchResult {
      position,
      #[cfg(test)]
      node_visits,
    }
  }

  fn find_different(
    &self,
    params: BoundarySearchParams,
    record_visit: &mut impl FnMut(),
  ) -> Option<u32> {
    let BoundarySearchParams {
      node,
      node_start,
      node_end,
      query_start,
      query_end,
      excluded_label,
      direction,
    } = params;
    if node_end <= query_start || node_start >= query_end {
      return None;
    }

    record_visit();
    if !self
      .summaries
      .get(node)
      .copied()
      .unwrap_or(LabelSummary::Empty)
      .has_different_label(excluded_label)
    {
      return None;
    }
    if node_end.saturating_sub(node_start) == 1 {
      return self.points.get(node_start).map(|point| point.position);
    }

    let midpoint =
      node_start.saturating_add(node_end.saturating_sub(node_start) >> 1);
    let left = BoundarySearchParams {
      node: node.saturating_mul(2),
      node_start,
      node_end: midpoint,
      query_start,
      query_end,
      excluded_label,
      direction,
    };
    let right = BoundarySearchParams {
      node: node.saturating_mul(2).saturating_add(1),
      node_start: midpoint,
      node_end,
      query_start,
      query_end,
      excluded_label,
      direction,
    };
    match direction {
      SearchDirection::Leftmost => self
        .find_different(left, record_visit)
        .or_else(|| self.find_different(right, record_visit)),
      SearchDirection::Rightmost => self
        .find_different(right, record_visit)
        .or_else(|| self.find_different(left, record_visit)),
    }
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SearchDirection {
  Leftmost,
  Rightmost,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct BoundarySearchParams {
  node: usize,
  node_start: usize,
  node_end: usize,
  query_start: usize,
  query_end: usize,
  excluded_label: usize,
  direction: SearchDirection,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct BoundaryFixStats {
  #[cfg(test)]
  index_node_visits: usize,
}

impl BoundaryFixStats {
  #[inline]
  #[cfg(test)]
  const fn record_search(&mut self, search: &BoundarySearchResult) {
    self.index_node_visits =
      self.index_node_visits.saturating_add(search.node_visits);
  }
}

#[derive(Debug)]
struct BoundaryOverlapIndexes {
  label_ids: Vec<usize>,
  starts: BoundaryPositionIndex,
  ends: BoundaryPositionIndex,
}

// Linear scans avoid index construction overhead on ordinary small inputs.
const BOUNDARY_INDEX_MIN_ENTITIES: usize = 64;

impl BoundaryOverlapIndexes {
  fn new(entities: &[PipelineEntity]) -> Self {
    let mut labels = BTreeMap::<&str, usize>::new();
    let label_ids = entities
      .iter()
      .map(|entity| {
        let next_id = labels.len();
        *labels.entry(&entity.label).or_insert(next_id)
      })
      .collect::<Vec<_>>();
    Self {
      starts: BoundaryPositionIndex::new(entities, &label_ids, |entity| {
        entity.start
      }),
      ends: BoundaryPositionIndex::new(entities, &label_ids, |entity| {
        entity.end
      }),
      label_ids,
    }
  }
}

fn fix_partial_words(
  entities: &[PipelineEntity],
  offsets: &ByteOffsets<'_>,
  spans: &[CharSpan],
  boundaries: &BTreeSet<u32>,
) -> Result<Vec<PipelineEntity>> {
  fix_partial_words_with_stats(entities, offsets, spans, boundaries)
    .map(|(fixed, _)| fixed)
}

fn fix_partial_words_with_stats(
  entities: &[PipelineEntity],
  offsets: &ByteOffsets<'_>,
  spans: &[CharSpan],
  boundaries: &BTreeSet<u32>,
) -> Result<(Vec<PipelineEntity>, BoundaryFixStats)> {
  let mut sorted = entities.to_vec();
  sorted.sort_by_key(|entity| entity.start);
  let indexes = (sorted.len() >= BOUNDARY_INDEX_MIN_ENTITIES)
    .then(|| BoundaryOverlapIndexes::new(&sorted));
  let mut fixed = Vec::with_capacity(sorted.len());
  #[cfg(test)]
  let mut stats = BoundaryFixStats::default();
  #[cfg(not(test))]
  let stats = BoundaryFixStats::default();

  for (index, entity) in sorted.iter().enumerate() {
    if has_locked_boundary(entity) || has_detector_locked_boundary(entity) {
      fixed.push(entity.clone());
      continue;
    }

    if entity.text != offsets.slice(entity.start, entity.end)? {
      fixed.push(entity.clone());
      continue;
    }

    let mut new_start = word_start_at(entity.start, boundaries, spans);
    let mut new_end = word_end_at(entity.end, boundaries, spans);

    if let Some(indexes) = indexes.as_ref() {
      let label_id = indexes.label_ids.get(index).copied().unwrap_or_default();
      let left =
        indexes
          .ends
          .rightmost_different(new_start, entity.start, label_id);
      #[cfg(test)]
      stats.record_search(&left);
      if let Some(end) = left.position {
        new_start = new_start.max(end);
      }
      let right = indexes
        .starts
        .leftmost_different(entity.end, new_end, label_id);
      #[cfg(test)]
      stats.record_search(&right);
      if let Some(start) = right.position {
        new_end = new_end.min(start);
      }
    } else {
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
    }

    if new_start == entity.start && new_end == entity.end {
      fixed.push(entity.clone());
      continue;
    }

    let mut adjusted = entity.clone();
    adjusted.start = new_start;
    adjusted.end = new_end;
    adjusted.text = offsets.slice(new_start, new_end)?;
    fixed.push(adjusted);
  }

  Ok((fixed, stats))
}

fn resolve_cross_label_overlaps(
  entities: &[PipelineEntity],
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
          right_mut.text = offsets.slice(new_start, right_mut.end)?;
        }
        right_index = right_index.saturating_add(1);
        continue;
      }

      let new_end = right.start;
      if let Some(left_mut) = sorted.get_mut(left_index) {
        left_mut.end = new_end;
        left_mut.text = offsets.slice(left_mut.start, new_end)?;
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
      merge_into_previous(&mut result, previous_index, entity, offsets)?;
      continue;
    }

    let gap = offsets.slice(previous.end, entity.start)?;
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
      merge_into_previous(&mut result, previous_index, entity, offsets)?;
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
    let index = spans.partition_point(|span| span.end <= cursor);
    if index == 0 {
      return cursor;
    }
    let Some(previous) = spans.get(index.saturating_sub(1)) else {
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
    let index = spans.partition_point(|span| span.start < cursor);
    let Some(next) = spans.get(index) else {
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
  offsets: &ByteOffsets<'_>,
) -> Result<()> {
  if let Some(previous) = entities.get_mut(previous_index) {
    previous.end = previous.end.max(entity.end);
    previous.text = offsets.slice(previous.start, previous.end)?;
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
  entity.label == crate::labels::PHONE_NUMBER_LABEL
    && entity.source == DetectionSource::Trigger
}

fn is_legal_form_organization(entity: &PipelineEntity) -> bool {
  entity.label == crate::labels::ORGANIZATION_LABEL
    && entity.source == DetectionSource::LegalForm
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

#[cfg(test)]
mod tests {
  use proptest::prelude::*;

  use super::*;

  const SAME_LABEL_SCALING_ENTITY_COUNT: usize = 20_000;

  fn fix_partial_words_legacy(
    entities: &[PipelineEntity],
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
      if entity.text != offsets.slice(entity.start, entity.end)? {
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
      adjusted.text = offsets.slice(new_start, new_end)?;
      fixed.push(adjusted);
    }

    Ok(fixed)
  }

  proptest! {
    #[test]
    fn indexed_partial_word_fix_matches_legacy_scan(
      full_text in "[a-zA-Z ,;.\\n']{0,128}",
      raw_entities in proptest::collection::vec(
        (any::<u16>(), any::<u16>(), 0_u8..4, any::<bool>(), 0_u8..3),
        0..128,
      ),
    ) {
      let text_len = full_text.len();
      let entities = raw_entities
        .into_iter()
        .enumerate()
        .map(|(index, (left, right, label_index, exact_text, source_index))| {
          let modulus = text_len.saturating_add(1);
          let left = usize::from(left).checked_rem(modulus).unwrap_or_default();
          let right = usize::from(right).checked_rem(modulus).unwrap_or_default();
          let start = left.min(right);
          let end = left.max(right);
          let label = match label_index {
            0 => "person",
            1 => "organization",
            2 => crate::labels::PHONE_NUMBER_LABEL,
            _ => "address",
          };
          let source = match source_index {
            0 => DetectionSource::Ner,
            1 => DetectionSource::Trigger,
            _ => DetectionSource::Caller,
          };
          let detected_text = if exact_text {
            full_text.get(start..end).unwrap_or_default()
          } else {
            "intentionally stale"
          };
          PipelineEntity::detected(
            u32::try_from(start).unwrap_or(u32::MAX),
            u32::try_from(end).unwrap_or(u32::MAX),
            label,
            detected_text,
            f64::from(u32::try_from(index).unwrap_or(u32::MAX)),
            source,
          )
        })
        .collect::<Vec<_>>();
      let offsets = ByteOffsets::new(&full_text);
      let spans = char_spans(&full_text);
      let boundaries = word_boundaries(&spans);

      prop_assert_eq!(
        fix_partial_words(&entities, &offsets, &spans, &boundaries)?,
        fix_partial_words_legacy(&entities, &offsets, &spans, &boundaries)?,
      );
    }
  }

  #[test]
  #[ignore = "release-mode scaling regression check"]
  fn fix_partial_words_same_label_scaling_is_bounded() -> Result<()> {
    let full_text = "word";
    let offsets = ByteOffsets::new(full_text);
    let spans = char_spans(full_text);
    let boundaries = word_boundaries(&spans);
    let entities = (0..SAME_LABEL_SCALING_ENTITY_COUNT)
      .map(|index| {
        let start = u32::try_from(index % 4).unwrap_or(u32::MAX);
        PipelineEntity::detected(
          start,
          start.saturating_add(1),
          "person",
          full_text.get(index % 4..index % 4 + 1).unwrap_or_default(),
          0.9,
          DetectionSource::Ner,
        )
      })
      .collect::<Vec<_>>();

    let (fixed, stats) =
      fix_partial_words_with_stats(&entities, &offsets, &spans, &boundaries)?;

    assert_eq!(fixed.len(), SAME_LABEL_SCALING_ENTITY_COUNT);
    assert!(
      fixed.iter().all(|entity| {
        entity.start == 0
          && entity.end == 4
          && entity.text == "word"
          && entity.label == "person"
          && entity.source == DetectionSource::Ner
          && entity.score.to_bits() == 0.9_f64.to_bits()
      }),
      "indexed resolution must retain all entity invariants"
    );
    assert!(
      stats.index_node_visits
        <= SAME_LABEL_SCALING_ENTITY_COUNT.saturating_mul(2),
      "same-label searches visited {} index nodes for {} entities",
      stats.index_node_visits,
      SAME_LABEL_SCALING_ENTITY_COUNT,
    );
    Ok(())
  }
}
