use std::collections::{BTreeMap, BTreeSet};

use crate::types::{EntityKind, Result};
use crate::utf16::Utf16Offsets;

const LEGAL_PERIOD_SUFFIXES: &str =
  include_str!("../data/legal-period-suffixes.txt");
const ADDRESS_FINAL_ABBREVS: &str =
  include_str!("../data/address-final-abbrevs.txt");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DetectionSource {
  Trigger,
  Regex,
  DenyList,
  LegalForm,
  Gazetteer,
  Country,
  Ner,
  Coreference,
}

impl DetectionSource {
  const fn priority(self) -> u8 {
    match self {
      Self::Gazetteer => 5,
      Self::Trigger => 4,
      Self::LegalForm | Self::Regex | Self::Country => 3,
      Self::DenyList | Self::Coreference => 2,
      Self::Ner => 1,
    }
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SourceDetail {
  CustomDenyList,
  CustomRegex,
  GazetteerExtension,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PipelineEntity {
  pub start: u32,
  pub end: u32,
  pub label: String,
  pub text: String,
  pub score: f64,
  pub source: DetectionSource,
  pub source_detail: Option<SourceDetail>,
  pub kind: EntityKind,
}

impl PipelineEntity {
  #[must_use]
  pub fn detected(
    start: u32,
    end: u32,
    label: impl Into<String>,
    text: impl Into<String>,
    score: f64,
    source: DetectionSource,
  ) -> Self {
    Self {
      start,
      end,
      label: label.into(),
      text: text.into(),
      score,
      source,
      source_detail: None,
      kind: EntityKind::Detected,
    }
  }

  #[must_use]
  pub fn coreference(
    start: u32,
    end: u32,
    label: impl Into<String>,
    text: impl Into<String>,
    score: f64,
    source_text: impl Into<String>,
  ) -> Self {
    Self {
      start,
      end,
      label: label.into(),
      text: text.into(),
      score,
      source: DetectionSource::Coreference,
      source_detail: None,
      kind: EntityKind::Coreference {
        source_text: source_text.into(),
      },
    }
  }
}

#[must_use]
pub fn merge_and_dedup(entities: &[PipelineEntity]) -> Vec<PipelineEntity> {
  if entities.is_empty() {
    return Vec::new();
  }

  let mut sorted = entities.to_vec();
  sorted.sort_by_key(|entity| entity.start);

  let Some(first) = sorted.first() else {
    return Vec::new();
  };
  let mut merged = vec![first.clone()];

  for entity in sorted.into_iter().skip(1) {
    let overlaps = overlapping_indexes(&merged, &entity);
    if overlaps.is_empty() {
      merged.push(entity);
      continue;
    }

    let has_partial_overlap = overlaps.iter().any(|index| {
      merged.get(*index).is_some_and(|existing| {
        existing.start != entity.start || existing.end != entity.end
      })
    });

    if !has_partial_overlap {
      let same_label_index = overlaps.iter().find_map(|index| {
        merged
          .get(*index)
          .is_some_and(|existing| existing.label == entity.label)
          .then_some(*index)
      });

      let Some(index) = same_label_index else {
        merged.push(entity);
        merged.sort_by_key(|entry| entry.start);
        continue;
      };

      if let Some(existing) = merged.get(index)
        && should_replace(&entity, existing)
      {
        replace_at(&mut merged, index, entity);
      }
      continue;
    }

    let replaces_all = overlaps.iter().all(|index| {
      merged
        .get(*index)
        .is_some_and(|existing| should_replace(&entity, existing))
    });
    if !replaces_all {
      continue;
    }

    let Some(insert_at) = overlaps.first().copied() else {
      continue;
    };
    for index in overlaps.iter().rev() {
      remove_at(&mut merged, *index);
    }
    insert_at_or_push(&mut merged, insert_at, entity);
  }

  resolve_same_span_label_conflicts(&sanitize_entities(&merged))
}

#[must_use]
pub fn sanitize_entities(entities: &[PipelineEntity]) -> Vec<PipelineEntity> {
  let mut sanitized = Vec::new();

  for entity in entities {
    if is_caller_owned(entity) || has_curated_literal_boundary(entity) {
      sanitized.push(entity.clone());
      continue;
    }

    let Some(cleaned) = clean_entity_text(entity) else {
      continue;
    };
    sanitized.push(cleaned);
  }

  sanitized
}

pub fn enforce_boundary_consistency(
  entities: &[PipelineEntity],
  full_text: &str,
) -> Result<Vec<PipelineEntity>> {
  let offsets = Utf16Offsets::new(full_text);
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
  offsets: &Utf16Offsets,
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
  offsets: &Utf16Offsets,
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
  offsets: &Utf16Offsets,
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

fn overlapping_indexes(
  entities: &[PipelineEntity],
  entity: &PipelineEntity,
) -> Vec<usize> {
  entities
    .iter()
    .enumerate()
    .filter_map(|(index, existing)| {
      (existing.end > entity.start && existing.start < entity.end)
        .then_some(index)
    })
    .collect()
}

fn should_replace(
  candidate: &PipelineEntity,
  existing: &PipelineEntity,
) -> bool {
  let candidate_len = entity_len(candidate);
  let existing_len = entity_len(existing);
  let candidate_caller_owned = is_caller_owned(candidate);
  let existing_caller_owned = is_caller_owned(existing);
  if candidate_caller_owned != existing_caller_owned {
    return candidate_caller_owned;
  }

  if literal_contains(candidate, existing) && candidate_len > existing_len {
    return true;
  }
  if literal_contains(existing, candidate) && existing_len > candidate_len {
    return false;
  }

  if address_contains_bare_postal(candidate, existing)
    && candidate_len > existing_len
  {
    return true;
  }
  if address_contains_bare_postal(existing, candidate)
    && existing_len > candidate_len
  {
    return false;
  }

  if legal_form_contains(candidate, existing) && candidate_len > existing_len {
    return true;
  }
  if legal_form_contains(existing, candidate) && existing_len > candidate_len {
    return false;
  }

  if same_start_longest_wins(candidate, existing)
    && candidate_len != existing_len
  {
    return candidate_len > existing_len;
  }

  if country_inside_person_or_org(candidate, existing)
    && existing_len > candidate_len
  {
    return false;
  }
  if country_inside_person_or_org(existing, candidate)
    && candidate_len > existing_len
  {
    return true;
  }

  let candidate_priority = candidate.source.priority();
  let existing_priority = existing.source.priority();
  if candidate_priority != existing_priority {
    return candidate_priority > existing_priority;
  }

  match candidate.score.total_cmp(&existing.score) {
    std::cmp::Ordering::Greater => true,
    std::cmp::Ordering::Less => false,
    std::cmp::Ordering::Equal => candidate_len > existing_len,
  }
}

fn resolve_same_span_label_conflicts(
  entities: &[PipelineEntity],
) -> Vec<PipelineEntity> {
  if entities.len() < 2 {
    return entities.to_vec();
  }

  let mut by_offsets = BTreeMap::<(u32, u32), Vec<usize>>::new();
  for (index, entity) in entities.iter().enumerate() {
    by_offsets
      .entry((entity.start, entity.end))
      .or_default()
      .push(index);
  }

  let mut dropped = BTreeSet::<usize>::new();
  for group in by_offsets.values() {
    if group.len() < 2 {
      continue;
    }

    let labels = group
      .iter()
      .filter_map(|index| entities.get(*index))
      .map(|entity| entity.label.as_str())
      .collect::<BTreeSet<_>>();
    if labels.len() < 2 {
      continue;
    }

    let has_person = labels.contains("person");
    let has_precise_non_address = labels
      .iter()
      .any(|label| *label != "address" && precise_over_address(label));
    let mut yielding_to_person = BTreeSet::<usize>::new();

    if has_person {
      for index in group {
        let Some(entity) = entities.get(*index) else {
          continue;
        };
        if !is_caller_owned(entity) && person_preferred_over(&entity.label) {
          yielding_to_person.insert(*index);
        }
      }
    }

    let mut max_priority = None::<u8>;
    for index in group {
      let Some(entity) = entities.get(*index) else {
        continue;
      };
      if is_caller_owned(entity) || yielding_to_person.contains(index) {
        continue;
      }
      max_priority = Some(max_priority.map_or_else(
        || entity.source.priority(),
        |priority| priority.max(entity.source.priority()),
      ));
    }

    for index in group {
      let Some(entity) = entities.get(*index) else {
        continue;
      };
      if is_caller_owned(entity) {
        continue;
      }
      if yielding_to_person.contains(index) {
        dropped.insert(*index);
        continue;
      }
      if max_priority
        .is_some_and(|priority| entity.source.priority() < priority)
      {
        dropped.insert(*index);
        continue;
      }
      if has_precise_non_address && entity.label == "address" {
        dropped.insert(*index);
      }
    }
  }

  entities
    .iter()
    .enumerate()
    .filter(|(index, _)| !dropped.contains(index))
    .map(|(_, entity)| entity.clone())
    .collect()
}

fn clean_entity_text(entity: &PipelineEntity) -> Option<PipelineEntity> {
  let mut start_byte = 0;
  let mut end_byte = entity.text.len();

  while let Some((ch, len)) = first_char(entity.text.get(start_byte..end_byte)?)
  {
    if ch.is_whitespace() || is_leading_trim(ch, &entity.label) {
      start_byte = start_byte.saturating_add(len);
      continue;
    }
    break;
  }

  while let Some((ch, len)) = last_char(entity.text.get(start_byte..end_byte)?)
  {
    if ch.is_whitespace() || is_trailing_trim(ch, &entity.label) {
      end_byte = end_byte.saturating_sub(len);
      continue;
    }
    break;
  }

  if should_strip_period(entity, start_byte, end_byte) {
    end_byte = end_byte.saturating_sub('.'.len_utf8());
  }

  while let Some((ch, len)) = last_char(entity.text.get(start_byte..end_byte)?)
  {
    if ch.is_whitespace() || is_trailing_trim(ch, &entity.label) {
      end_byte = end_byte.saturating_sub(len);
      continue;
    }
    break;
  }

  if start_byte >= end_byte {
    return None;
  }

  let cleaned_raw = entity.text.get(start_byte..end_byte)?;
  if !cleaned_raw.chars().any(char::is_alphanumeric) {
    return None;
  }

  let display_text = collapse_display_whitespace(cleaned_raw);
  let start = entity.start.saturating_add(utf16_len(
    entity.text.get(..start_byte).unwrap_or_default(),
  ));
  let end = start.saturating_add(utf16_len(cleaned_raw));

  let mut cleaned = entity.clone();
  cleaned.start = start;
  cleaned.end = end;
  cleaned.text = display_text;
  Some(cleaned)
}

fn replace_at(
  entities: &mut [PipelineEntity],
  index: usize,
  entity: PipelineEntity,
) {
  if let Some(slot) = entities.get_mut(index) {
    *slot = entity;
  }
}

fn remove_at(entities: &mut Vec<PipelineEntity>, index: usize) {
  if index < entities.len() {
    entities.remove(index);
  }
}

fn insert_at_or_push(
  entities: &mut Vec<PipelineEntity>,
  index: usize,
  entity: PipelineEntity,
) {
  if index <= entities.len() {
    entities.insert(index, entity);
    return;
  }
  entities.push(entity);
}

fn char_spans(text: &str) -> Vec<CharSpan> {
  let mut spans = Vec::new();
  let mut offset = 0_u32;

  for ch in text.chars() {
    let width = u32::try_from(ch.len_utf16()).unwrap_or(u32::MAX);
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

  for span in spans {
    if span.ch.is_alphanumeric() {
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
  offsets: &Utf16Offsets,
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

const fn contains_span(outer: &PipelineEntity, inner: &PipelineEntity) -> bool {
  outer.start <= inner.start && outer.end >= inner.end
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
    || (utf16_len(gap) <= 3
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

const fn entity_len(entity: &PipelineEntity) -> u32 {
  entity.end.saturating_sub(entity.start)
}

const fn is_caller_owned(entity: &PipelineEntity) -> bool {
  matches!(
    entity.source_detail,
    Some(SourceDetail::CustomDenyList | SourceDetail::CustomRegex)
  )
}

fn literal_contains(outer: &PipelineEntity, inner: &PipelineEntity) -> bool {
  outer.label == inner.label
    && matches!(
      outer.source,
      DetectionSource::DenyList | DetectionSource::Gazetteer
    )
    && outer.start <= inner.start
    && outer.end >= inner.end
}

fn address_contains_bare_postal(
  outer: &PipelineEntity,
  inner: &PipelineEntity,
) -> bool {
  outer.label == "address"
    && inner.label == "address"
    && outer.start <= inner.start
    && outer.end >= inner.end
    && is_bare_postal_code(&inner.text)
}

fn legal_form_contains(outer: &PipelineEntity, inner: &PipelineEntity) -> bool {
  outer.label == inner.label
    && outer.source == DetectionSource::LegalForm
    && outer.start <= inner.start
    && outer.end >= inner.end
}

fn same_start_longest_wins(
  candidate: &PipelineEntity,
  existing: &PipelineEntity,
) -> bool {
  candidate.label == existing.label
    && candidate.start == existing.start
    && longest_wins_label(&candidate.label)
}

fn country_inside_person_or_org(
  country: &PipelineEntity,
  container: &PipelineEntity,
) -> bool {
  country.label == "country"
    && matches!(container.label.as_str(), "person" | "organization")
    && container.start <= country.start
    && container.end >= country.end
}

fn has_curated_literal_boundary(entity: &PipelineEntity) -> bool {
  matches!(
    entity.source,
    DetectionSource::DenyList | DetectionSource::Gazetteer
  ) && entity.label != "person"
    && entity.source_detail != Some(SourceDetail::GazetteerExtension)
    && entity
      .text
      .chars()
      .next()
      .into_iter()
      .chain(entity.text.chars().next_back())
      .any(is_literal_boundary_punct)
}

fn is_leading_trim(ch: char, label: &str) -> bool {
  if label_allows_colon(label) {
    matches!(
      ch,
      ',' | ';' | '"' | '\'' | '“' | '”' | '‘' | '’' | '«' | '¿' | '¡'
    )
  } else {
    matches!(
      ch,
      ',' | ';' | ':' | '"' | '\'' | '“' | '”' | '‘' | '’' | '«' | '¿' | '¡'
    )
  }
}

fn is_trailing_trim(ch: char, label: &str) -> bool {
  if label_allows_colon(label) {
    matches!(
      ch,
      ',' | ';' | '"' | '\'' | '“' | '”' | '‘' | '’' | '»' | '!' | '?'
    )
  } else {
    matches!(
      ch,
      ',' | ';' | ':' | '"' | '\'' | '“' | '”' | '‘' | '’' | '»' | '!' | '?'
    )
  }
}

const fn is_literal_boundary_punct(ch: char) -> bool {
  matches!(
    ch,
    '"'
      | '\''
      | '“'
      | '”'
      | '„'
      | '‟'
      | '‘'
      | '’'
      | '‛'
      | '«'
      | '»'
      | '!'
      | '.'
  )
}

fn should_strip_period(
  entity: &PipelineEntity,
  start_byte: usize,
  end_byte: usize,
) -> bool {
  if !matches!(
    entity.label.as_str(),
    "organization" | "location" | "address"
  ) {
    return false;
  }
  let Some(text) = entity.text.get(start_byte..end_byte) else {
    return false;
  };
  if !text.ends_with('.') || known_period_suffix(text) {
    return false;
  }
  if entity.label == "address" && known_address_final_abbrev(text) {
    return false;
  }
  !(entity.label == "location" && known_location_final_abbrev(text))
}

fn known_period_suffix(text: &str) -> bool {
  LEGAL_PERIOD_SUFFIXES
    .lines()
    .any(|suffix| text.ends_with(suffix))
}

fn known_address_final_abbrev(text: &str) -> bool {
  ADDRESS_FINAL_ABBREVS.lines().any(|suffix| {
    text
      .strip_suffix(suffix)
      .is_some_and(|prefix| prefix.ends_with(char::is_whitespace))
  })
}

fn known_location_final_abbrev(text: &str) -> bool {
  text.ends_with("D.C.")
    || text
      .split_whitespace()
      .next_back()
      .is_some_and(|token| token.chars().filter(|ch| *ch == '.').count() >= 2)
}

fn label_allows_colon(label: &str) -> bool {
  matches!(label, "ip address" | "mac address")
}

fn longest_wins_label(label: &str) -> bool {
  matches!(
    label,
    "date"
      | "date of birth"
      | "monetary amount"
      | "phone number"
      | "email address"
      | "url"
  )
}

fn precise_over_address(label: &str) -> bool {
  matches!(
    label,
    "person"
      | "date"
      | "date of birth"
      | "phone number"
      | "email address"
      | "monetary amount"
      | "iban"
      | "bank account number"
      | "tax identification number"
      | "registration number"
      | "identity card number"
      | "national identification number"
      | "passport number"
      | "credit card number"
  )
}

fn person_preferred_over(label: &str) -> bool {
  matches!(label, "address" | "country" | "land parcel")
}

fn is_bare_postal_code(text: &str) -> bool {
  let compact = text
    .chars()
    .filter(|ch| !ch.is_whitespace() && *ch != '-' && *ch != '–')
    .collect::<String>();
  let len = compact.len();
  matches!(len, 5 | 8 | 9) && compact.chars().all(|ch| ch.is_ascii_digit())
}

fn collapse_display_whitespace(text: &str) -> String {
  let mut output = String::new();
  let mut in_whitespace = false;

  for ch in text.chars() {
    if ch.is_whitespace() {
      if !in_whitespace {
        output.push(' ');
        in_whitespace = true;
      }
      continue;
    }

    output.push(ch);
    in_whitespace = false;
  }

  output
}

fn first_char(text: &str) -> Option<(char, usize)> {
  text.chars().next().map(|ch| (ch, ch.len_utf8()))
}

fn last_char(text: &str) -> Option<(char, usize)> {
  text.chars().next_back().map(|ch| (ch, ch.len_utf8()))
}

fn utf16_len(text: &str) -> u32 {
  u32::try_from(text.encode_utf16().count()).unwrap_or(u32::MAX)
}
