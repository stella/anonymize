use std::borrow::Cow;
use std::collections::HashSet;

use crate::byte_offsets::ByteOffsets;
use crate::normalize::placeholder_fallback;
use crate::placeholders::build_placeholder_map;
use crate::types::{
  Entity, EntityKind, OperatorConfig, OperatorEntry, OperatorType,
  RedactionEntry, RedactionResult, Result,
};

pub fn redact_text(
  full_text: &str,
  entities: &[Entity],
  config: &OperatorConfig,
) -> Result<RedactionResult> {
  if entities.is_empty() {
    return Ok(RedactionResult {
      redacted_text: full_text.to_owned(),
      redaction_map: Vec::new(),
      operator_map: Vec::new(),
      entity_count: 0,
    });
  }

  let offsets = ByteOffsets::new(full_text);
  let placeholder_map = build_placeholder_map(entities, full_text);
  let mut sorted = redaction_spans(full_text, entities, &offsets)?;
  sorted.sort_by_key(|span| span.entity.start);

  // Existing contract: first accepted span wins overlaps.
  let mut non_overlapping = Vec::<RedactionSpan<'_>>::new();
  let mut last_end = 0;
  for span in sorted {
    if span.entity.start >= last_end {
      last_end = span.entity.end;
      non_overlapping.push(span);
    }
  }

  let mut redacted_text = String::with_capacity(full_text.len());
  let mut redaction_map = Vec::<RedactionEntry>::new();
  let mut operator_map = Vec::<OperatorEntry>::new();
  let mut redacted_placeholders = HashSet::<String>::new();
  let mut cursor = 0;

  for span in &non_overlapping {
    let entity = &span.entity;
    if entity.start > cursor {
      redacted_text.push_str(source_slice(
        full_text,
        &offsets,
        cursor,
        entity.start,
      )?);
    }

    let placeholder = placeholder_map.get_entity(entity).map_or_else(
      || Cow::Owned(placeholder_fallback(&entity.label)),
      Cow::Borrowed,
    );
    let operator = operator_for(config, &entity.label);
    match operator {
      OperatorType::Replace => redacted_text.push_str(&placeholder),
      OperatorType::Redact => redacted_text.push_str(&config.redact_string),
    }
    set_operator_entry(&mut operator_map, &placeholder, operator);

    if operator == OperatorType::Replace
      && !redacted_placeholders.contains(placeholder.as_ref())
    {
      let placeholder = placeholder.into_owned();
      redacted_placeholders.insert(placeholder.clone());
      redaction_map.push(RedactionEntry {
        placeholder,
        original: redaction_original_text(span),
      });
    }

    cursor = entity.end;
  }

  let full_text_len = offsets.len()?;
  if cursor < full_text_len {
    redacted_text.push_str(source_slice(
      full_text,
      &offsets,
      cursor,
      full_text_len,
    )?);
  }

  Ok(RedactionResult {
    redacted_text,
    redaction_map,
    operator_map,
    entity_count: non_overlapping.len(),
  })
}

#[must_use]
pub fn deanonymise(
  redacted_text: &str,
  redaction_map: &[RedactionEntry],
) -> String {
  let mut result = redacted_text.to_owned();

  for entry in redaction_map {
    result = result.replace(&entry.placeholder, &entry.original);
  }

  result
}

struct RedactionSpan<'a> {
  entity: &'a Entity,
  source_text: &'a str,
}

fn redaction_spans<'a>(
  full_text: &'a str,
  entities: &'a [Entity],
  offsets: &ByteOffsets<'_>,
) -> Result<Vec<RedactionSpan<'a>>> {
  let mut resolved = Vec::with_capacity(entities.len());

  for entity in entities {
    // Empty spans would insert without redacting.
    if entity.start >= entity.end {
      return Err(crate::types::Error::InvalidSpan {
        start: entity.start,
        end: entity.end,
      });
    }

    resolved.push(RedactionSpan {
      entity,
      source_text: source_slice(full_text, offsets, entity.start, entity.end)?,
    });
  }

  Ok(resolved)
}

fn source_slice<'a>(
  full_text: &'a str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  end: u32,
) -> Result<&'a str> {
  if start > end {
    return Err(crate::types::Error::InvalidSpan { start, end });
  }

  let start_byte = offsets.validate_offset(start)?;
  let end_byte = offsets.validate_offset(end)?;
  full_text
    .get(start_byte..end_byte)
    .ok_or(crate::types::Error::InvalidSpan { start, end })
}

fn operator_for(config: &OperatorConfig, label: &str) -> OperatorType {
  config
    .operators
    .get(label)
    .copied()
    .unwrap_or(OperatorType::Replace)
}

fn set_operator_entry(
  operator_map: &mut Vec<OperatorEntry>,
  placeholder: &str,
  operator: OperatorType,
) {
  if let Some(entry) = operator_map
    .iter_mut()
    .find(|entry| entry.placeholder == placeholder)
  {
    entry.operator = operator;
    return;
  }

  operator_map.push(OperatorEntry {
    placeholder: placeholder.to_owned(),
    operator,
  });
}

fn redaction_original_text(span: &RedactionSpan<'_>) -> String {
  match &span.entity.kind {
    EntityKind::Detected => span.source_text.to_owned(),
    EntityKind::Coreference { source_text } => source_text.clone(),
  }
}
