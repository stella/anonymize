use std::collections::{BTreeMap, BTreeSet};

use crate::types::EntityKind;

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
