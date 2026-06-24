use crate::normalize::placeholder_fallback;
use crate::placeholders::build_placeholder_map;
use crate::types::{
  Entity, EntityKind, OperatorConfig, OperatorEntry, OperatorType,
  RedactionEntry, RedactionResult, Result,
};
use crate::utf16::Utf16Offsets;

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

  let offsets = Utf16Offsets::new(full_text);
  validate_spans(entities, &offsets)?;

  let placeholder_map = build_placeholder_map(entities, full_text);
  let mut sorted = entities.to_vec();
  sorted.sort_by_key(|entity| entity.start);

  let mut non_overlapping = Vec::<Entity>::new();
  let mut last_end = 0;
  for entity in sorted {
    if entity.start >= last_end {
      last_end = entity.end;
      non_overlapping.push(entity);
    }
  }

  let mut parts = Vec::<String>::new();
  let mut redaction_map = Vec::<RedactionEntry>::new();
  let mut operator_map = Vec::<OperatorEntry>::new();
  let mut cursor = 0;

  for entity in &non_overlapping {
    if entity.start > cursor {
      parts.push(offsets.slice(full_text, cursor, entity.start)?);
    }

    let placeholder = placeholder_map
      .get(&entity.label, &entity.text)
      .map_or_else(|| placeholder_fallback(&entity.label), ToOwned::to_owned);
    let operator = operator_for(config, &entity.label);
    let replacement = match operator {
      OperatorType::Replace => placeholder.clone(),
      OperatorType::Redact => config.redact_string.clone(),
    };

    parts.push(replacement);
    set_operator_entry(&mut operator_map, &placeholder, operator);

    if operator == OperatorType::Replace
      && redaction_value(&redaction_map, &placeholder).is_none()
    {
      redaction_map.push(RedactionEntry {
        placeholder: placeholder.clone(),
        original: entity_original_text(entity),
      });
    }

    cursor = entity.end;
  }

  let full_text_len = offsets.len()?;
  if cursor < full_text_len {
    parts.push(offsets.slice(full_text, cursor, full_text_len)?);
  }

  Ok(RedactionResult {
    redacted_text: parts.concat(),
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

fn validate_spans(entities: &[Entity], offsets: &Utf16Offsets) -> Result<()> {
  for entity in entities {
    if entity.start > entity.end {
      return Err(crate::types::Error::InvalidSpan {
        start: entity.start,
        end: entity.end,
      });
    }

    offsets.validate_offset(entity.start)?;
    offsets.validate_offset(entity.end)?;
  }

  Ok(())
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

fn redaction_value<'a>(
  redaction_map: &'a [RedactionEntry],
  placeholder: &str,
) -> Option<&'a str> {
  redaction_map
    .iter()
    .find(|entry| entry.placeholder == placeholder)
    .map(|entry| entry.original.as_str())
}

fn entity_original_text(entity: &Entity) -> String {
  match &entity.kind {
    EntityKind::Detected => entity.text.clone(),
    EntityKind::Coreference { source_text } => source_text.clone(),
  }
}
