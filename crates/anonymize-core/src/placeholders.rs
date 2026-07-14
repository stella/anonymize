use std::collections::{BTreeMap, BTreeSet};

use crate::normalize::{label_key, normalize_entity_text};
use crate::types::{Entity, EntityKind, PlaceholderMap};

// Canonical placeholder identity shared by document-local and session allocators.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(crate) struct PlaceholderIdentity {
  pub(crate) label_key: String,
  pub(crate) text: String,
}

#[must_use]
pub fn build_placeholder_map(
  entities: &[Entity],
  reserved_text: &str,
) -> PlaceholderMap {
  let mut counters = BTreeMap::<String, u32>::new();
  let mut normalized_to_placeholder =
    BTreeMap::<PlaceholderIdentity, String>::new();
  let reserved_placeholders = collect_reserved_placeholders(reserved_text);
  let mut placeholder_map = PlaceholderMap::default();

  let mut sorted = entities.iter().collect::<Vec<_>>();
  sorted.sort_by_key(|entity| entity.start);

  for entity in sorted {
    if placeholder_map.has_entity(entity) {
      continue;
    }

    let normalized_key = placeholder_identity(entity);

    if let Some(existing) = normalized_to_placeholder.get(&normalized_key) {
      placeholder_map.push_entity(entity, existing);
      continue;
    }

    let placeholder = next_placeholder(
      &normalized_key.label_key,
      &mut counters,
      &reserved_placeholders,
    );
    placeholder_map.push_entity(entity, &placeholder);
    normalized_to_placeholder.insert(normalized_key, placeholder);
  }

  placeholder_map
}

pub(crate) fn placeholder_identity(entity: &Entity) -> PlaceholderIdentity {
  let label_key = label_key(&entity.label);
  // Coreference aliases key by source identity, not alias text.
  let text = match &entity.kind {
    EntityKind::Detected => normalize_entity_text(&entity.label, &entity.text),
    EntityKind::Coreference { source_text } => {
      normalize_entity_text(&entity.label, source_text)
    }
  };

  PlaceholderIdentity { label_key, text }
}

fn next_placeholder(
  label_key: &str,
  counters: &mut BTreeMap<String, u32>,
  reserved_placeholders: &BTreeSet<String>,
) -> String {
  let mut count = counters.get(label_key).copied().unwrap_or(0);

  loop {
    count = count.saturating_add(1);
    let placeholder = format!("[{label_key}_{count}]");
    if reserved_placeholders.contains(&placeholder) {
      continue;
    }

    counters.insert(label_key.to_owned(), count);
    return placeholder;
  }
}

pub(crate) fn collect_reserved_placeholders(text: &str) -> BTreeSet<String> {
  collect_placeholder_counts(text).into_keys().collect()
}

pub(crate) fn collect_placeholder_counts(
  text: &str,
) -> BTreeMap<String, usize> {
  let mut placeholders = BTreeMap::new();
  for (start, end) in reserved_placeholder_spans(text) {
    let Some(placeholder) = text.get(start..end) else {
      continue;
    };
    let count = placeholders.entry(placeholder.to_owned()).or_insert(0usize);
    *count = count.saturating_add(1);
  }
  placeholders
}

pub(crate) fn reserved_placeholder_spans(
  text: &str,
) -> impl Iterator<Item = (usize, usize)> + '_ {
  let mut characters = text.char_indices();
  let mut start = None;
  std::iter::from_fn(move || {
    loop {
      let (index, character) = characters.next()?;
      if character == '[' {
        start = Some(index);
        continue;
      }
      if character != ']' {
        continue;
      }
      let Some(open) = start.take() else {
        continue;
      };
      let inner_start = open.checked_add('['.len_utf8())?;
      let end = index.checked_add(']'.len_utf8())?;
      if text
        .get(inner_start..index)
        .is_some_and(is_placeholder_inner)
      {
        return Some((open, end));
      }
    }
  })
}

fn is_placeholder_inner(inner: &str) -> bool {
  if inner.is_empty()
    || inner
      .chars()
      .any(|ch| ch.is_whitespace() || ch == '[' || ch == ']')
  {
    return false;
  }

  let Some(separator) = inner.rfind('_') else {
    return false;
  };
  if separator == 0 {
    return false;
  }

  let Some(number) = inner.get(separator.saturating_add(1)..) else {
    return false;
  };
  let mut chars = number.chars();
  let Some(first) = chars.next() else {
    return false;
  };
  first.is_ascii_digit() && first != '0' && chars.all(|ch| ch.is_ascii_digit())
}
