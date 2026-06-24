use std::collections::{BTreeMap, BTreeSet};

use crate::normalize::{label_key, normalize_entity_text};
use crate::types::{Entity, EntityKind, PlaceholderMap};

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct NormalizedKey {
  label_key: String,
  text: String,
}

#[must_use]
pub fn build_placeholder_map(
  entities: &[Entity],
  reserved_text: &str,
) -> PlaceholderMap {
  let mut counters = BTreeMap::<String, u32>::new();
  let mut normalized_to_placeholder = BTreeMap::<NormalizedKey, String>::new();
  let reserved_placeholders = collect_reserved_placeholders(reserved_text);
  let mut placeholder_map = PlaceholderMap::default();

  let mut sorted = entities.to_vec();
  sorted.sort_by_key(|entity| entity.start);

  for entity in &sorted {
    if placeholder_map.has(&entity.label, &entity.text) {
      continue;
    }

    let label_key = label_key(&entity.label);
    let source_normalized_key = source_normalized_key(entity, &label_key);

    if let Some(source_key) = source_normalized_key.as_ref()
      && let Some(existing) = normalized_to_placeholder.get(source_key)
    {
      placeholder_map.push(&entity.label, &entity.text, existing);
      continue;
    }

    let normalized = normalize_entity_text(&entity.label, &entity.text);
    let normalized_key = NormalizedKey {
      label_key: label_key.clone(),
      text: normalized,
    };

    if let Some(existing) = normalized_to_placeholder.get(&normalized_key) {
      placeholder_map.push(&entity.label, &entity.text, existing);
      if let Some(source_key) = source_normalized_key {
        normalized_to_placeholder.insert(source_key, existing.clone());
      }
      continue;
    }

    let placeholder =
      next_placeholder(&label_key, &mut counters, &reserved_placeholders);
    placeholder_map.push(&entity.label, &entity.text, &placeholder);
    normalized_to_placeholder.insert(normalized_key, placeholder.clone());
    if let Some(source_key) = source_normalized_key {
      normalized_to_placeholder.insert(source_key, placeholder);
    }
  }

  placeholder_map
}

fn source_normalized_key(
  entity: &Entity,
  label_key: &str,
) -> Option<NormalizedKey> {
  let EntityKind::Coreference { source_text } = &entity.kind else {
    return None;
  };

  Some(NormalizedKey {
    label_key: label_key.to_owned(),
    text: normalize_entity_text(&entity.label, source_text),
  })
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

fn collect_reserved_placeholders(text: &str) -> BTreeSet<String> {
  let mut placeholders = BTreeSet::new();
  let mut remaining = text;

  while let Some(start) = remaining.find('[') {
    let candidate_start = start.saturating_add('['.len_utf8());
    let Some(after_open) = remaining.get(candidate_start..) else {
      break;
    };
    let Some(end) = after_open.find(']') else {
      break;
    };
    let Some(inner) = after_open.get(..end) else {
      break;
    };
    let valid = is_placeholder_inner(inner);
    if valid {
      placeholders.insert(format!("[{inner}]"));
    }

    let next_start = if valid {
      candidate_start
        .saturating_add(end)
        .saturating_add(']'.len_utf8())
    } else {
      candidate_start
    };
    remaining = remaining.get(next_start..).unwrap_or_default();
  }

  placeholders
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
