use std::collections::{BTreeMap, BTreeSet};

use super::common::{entity_len, is_caller_owned};
use super::sanitize::sanitize_entities;
use super::{DetectionSource, PipelineEntity};

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

  if curated_organization_contains_fragment(candidate, existing)
    && candidate_len > existing_len
  {
    return true;
  }
  if curated_organization_contains_fragment(existing, candidate)
    && existing_len > candidate_len
  {
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

  if regex_shape_contains_trigger_fragment(candidate, existing)
    && candidate_len > existing_len
  {
    return true;
  }
  if regex_shape_contains_trigger_fragment(existing, candidate)
    && existing_len > candidate_len
  {
    return false;
  }

  if person_regex_contains_name_fragment(candidate, existing)
    && candidate_len > existing_len
  {
    return true;
  }
  if person_regex_contains_name_fragment(existing, candidate)
    && existing_len > candidate_len
  {
    return false;
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

fn literal_contains(outer: &PipelineEntity, inner: &PipelineEntity) -> bool {
  outer.label == inner.label
    && matches!(
      outer.source,
      DetectionSource::DenyList | DetectionSource::Gazetteer
    )
    && outer.start <= inner.start
    && outer.end >= inner.end
}

fn curated_organization_contains_fragment(
  outer: &PipelineEntity,
  inner: &PipelineEntity,
) -> bool {
  matches!(
    outer.source,
    DetectionSource::DenyList | DetectionSource::Gazetteer
  ) && outer.label == "organization"
    && matches!(inner.label.as_str(), "address" | "country")
    && !is_caller_owned(inner)
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

fn regex_shape_contains_trigger_fragment(
  outer: &PipelineEntity,
  inner: &PipelineEntity,
) -> bool {
  outer.label == inner.label
    && outer.source == DetectionSource::Regex
    && inner.source == DetectionSource::Trigger
    && outer.start <= inner.start
    && outer.end >= comparable_trigger_fragment_end(inner)
    && regex_shape_preferred_label(&outer.label)
}

fn comparable_trigger_fragment_end(entity: &PipelineEntity) -> u32 {
  let mut end = entity.end;
  let mut text = entity.text.as_str();
  while let Some((index, ch)) = text.char_indices().next_back() {
    if !is_trigger_fragment_trailing_trim(ch) {
      break;
    }
    end = end.saturating_sub(u32_char_len(ch));
    text = text.get(..index).unwrap_or_default();
  }
  end
}

const fn is_trigger_fragment_trailing_trim(ch: char) -> bool {
  matches!(
    ch,
    '.' | ',' | ';' | ':' | '!' | '?' | ' ' | '\t' | '\n' | '\r'
  )
}

fn u32_char_len(ch: char) -> u32 {
  u32::try_from(ch.len_utf8()).unwrap_or(u32::MAX)
}

fn regex_shape_preferred_label(label: &str) -> bool {
  matches!(
    label,
    "date"
      | "date of birth"
      | "phone number"
      | "tax identification number"
      | "registration number"
      | "national identification number"
      | "social security number"
      | "birth number"
      | "identity card number"
      | "passport number"
      | "credit card number"
      | "bank account number"
      | "iban"
  )
}

fn person_regex_contains_name_fragment(
  outer: &PipelineEntity,
  inner: &PipelineEntity,
) -> bool {
  outer.label == "person"
    && inner.label == "person"
    && outer.source == DetectionSource::Regex
    && matches!(
      inner.source,
      DetectionSource::Trigger | DetectionSource::DenyList
    )
    && outer.start <= inner.start
    && outer.end >= inner.end
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
