use crate::byte_offsets::ByteOffsets;
use crate::types::Result;

use super::common::{byte_len, is_caller_owned};
use super::{DetectionSource, PipelineEntity, SourceDetail};

const LEGAL_PERIOD_SUFFIXES: &str =
  include_str!("../../data/legal-period-suffixes.txt");
const ADDRESS_FINAL_ABBREVS: &str =
  include_str!("../../data/address-final-abbrevs.txt");

#[must_use]
pub fn sanitize_entities(entities: &[PipelineEntity]) -> Vec<PipelineEntity> {
  let mut sanitized = Vec::new();

  for entity in entities {
    if is_caller_owned(entity) || has_curated_literal_boundary(entity) {
      sanitized.push(entity.clone());
      continue;
    }

    let Some(cleaned) = clean_entity_text_only(entity, &entity.text) else {
      continue;
    };
    sanitized.push(cleaned);
  }

  sanitized
}

pub(crate) fn sanitize_entities_with_source(
  entities: &[PipelineEntity],
  full_text: &str,
) -> Result<Vec<PipelineEntity>> {
  let offsets = ByteOffsets::new(full_text);
  let mut sanitized = Vec::new();

  for entity in entities {
    if is_caller_owned(entity) || has_curated_literal_boundary(entity) {
      sanitized.push(entity.clone());
      continue;
    }

    let raw_text = offsets.slice(entity.start, entity.end)?;
    let Some(cleaned) = clean_entity_text(entity, &raw_text) else {
      continue;
    };
    sanitized.push(cleaned);
  }

  Ok(sanitized)
}

fn clean_entity_text_only(
  entity: &PipelineEntity,
  raw_text: &str,
) -> Option<PipelineEntity> {
  let mut start_byte = 0;
  let mut end_byte = raw_text.len();

  while let Some((ch, len)) = first_char(raw_text.get(start_byte..end_byte)?) {
    if ch.is_whitespace() || is_leading_trim(ch, &entity.label) {
      start_byte = start_byte.saturating_add(len);
      continue;
    }
    break;
  }

  trim_leading_date_artifacts(entity, raw_text, &mut start_byte, end_byte);

  while let Some((ch, len)) = first_char(raw_text.get(start_byte..end_byte)?) {
    if ch.is_whitespace() {
      start_byte = start_byte.saturating_add(len);
      continue;
    }
    break;
  }

  while let Some((ch, len)) = last_char(raw_text.get(start_byte..end_byte)?) {
    if ch.is_whitespace() || is_trailing_trim(ch, &entity.label) {
      end_byte = end_byte.saturating_sub(len);
      continue;
    }
    break;
  }

  if should_strip_period(entity, raw_text, start_byte, end_byte) {
    end_byte = end_byte.saturating_sub('.'.len_utf8());
  }

  while let Some((ch, len)) = last_char(raw_text.get(start_byte..end_byte)?) {
    if ch.is_whitespace() || is_trailing_trim(ch, &entity.label) {
      end_byte = end_byte.saturating_sub(len);
      continue;
    }
    break;
  }

  if start_byte >= end_byte {
    return None;
  }

  let cleaned_raw = raw_text.get(start_byte..end_byte)?;
  if !cleaned_raw.chars().any(char::is_alphanumeric) {
    return None;
  }

  let display_text = collapse_display_whitespace(cleaned_raw);
  let mut cleaned = entity.clone();
  cleaned.text = display_text;
  Some(cleaned)
}

fn clean_entity_text(
  entity: &PipelineEntity,
  raw_text: &str,
) -> Option<PipelineEntity> {
  let mut start_byte = 0;
  let mut end_byte = raw_text.len();

  while let Some((ch, len)) = first_char(raw_text.get(start_byte..end_byte)?) {
    if ch.is_whitespace() || is_leading_trim(ch, &entity.label) {
      start_byte = start_byte.saturating_add(len);
      continue;
    }
    break;
  }

  trim_leading_date_artifacts(entity, raw_text, &mut start_byte, end_byte);

  while let Some((ch, len)) = first_char(raw_text.get(start_byte..end_byte)?) {
    if ch.is_whitespace() {
      start_byte = start_byte.saturating_add(len);
      continue;
    }
    break;
  }

  while let Some((ch, len)) = last_char(raw_text.get(start_byte..end_byte)?) {
    if ch.is_whitespace() || is_trailing_trim(ch, &entity.label) {
      end_byte = end_byte.saturating_sub(len);
      continue;
    }
    break;
  }

  if should_strip_period(entity, raw_text, start_byte, end_byte) {
    end_byte = end_byte.saturating_sub('.'.len_utf8());
  }

  while let Some((ch, len)) = last_char(raw_text.get(start_byte..end_byte)?) {
    if ch.is_whitespace() || is_trailing_trim(ch, &entity.label) {
      end_byte = end_byte.saturating_sub(len);
      continue;
    }
    break;
  }

  if start_byte >= end_byte {
    return None;
  }

  let cleaned_raw = raw_text.get(start_byte..end_byte)?;
  if !cleaned_raw.chars().any(char::is_alphanumeric) {
    return None;
  }

  let display_text = collapse_display_whitespace(cleaned_raw);
  let start = entity
    .start
    .saturating_add(byte_len(raw_text.get(..start_byte).unwrap_or_default()));
  let end = start.saturating_add(byte_len(cleaned_raw));

  let mut cleaned = entity.clone();
  cleaned.start = start;
  cleaned.end = end;
  cleaned.text = display_text;
  Some(cleaned)
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

fn trim_leading_date_artifacts(
  entity: &PipelineEntity,
  raw_text: &str,
  start_byte: &mut usize,
  end_byte: usize,
) {
  if !matches!(entity.label.as_str(), "date" | "date of birth") {
    return;
  }

  let Some(text) = raw_text.get(*start_byte..end_byte) else {
    return;
  };
  let dot_len = leading_dot_run_len(text);
  if dot_len == 0 {
    return;
  }

  let should_trim = dot_len >= 2
    || text
      .get(dot_len..)
      .and_then(|suffix| suffix.chars().next())
      .is_some_and(char::is_whitespace);
  if should_trim {
    *start_byte = (*start_byte).saturating_add(dot_len);
  }
}

fn leading_dot_run_len(text: &str) -> usize {
  let mut len = 0usize;
  for ch in text.chars() {
    if ch != '.' {
      break;
    }
    len = len.saturating_add(ch.len_utf8());
  }
  len
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
  raw_text: &str,
  start_byte: usize,
  end_byte: usize,
) -> bool {
  if !matches!(
    entity.label.as_str(),
    "organization" | "location" | "address"
  ) {
    return false;
  }
  let Some(text) = raw_text.get(start_byte..end_byte) else {
    return false;
  };
  if !text.ends_with('.') || known_period_suffix(text) {
    return false;
  }
  if entity.source == DetectionSource::LegalForm {
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

fn collapse_display_whitespace(text: &str) -> String {
  let mut output = String::new();
  let mut whitespace = String::new();

  for ch in text.chars() {
    if ch.is_whitespace() {
      whitespace.push(ch);
      continue;
    }

    flush_whitespace(&mut output, &mut whitespace);
    output.push(ch);
  }

  flush_whitespace(&mut output, &mut whitespace);
  output
}

fn flush_whitespace(output: &mut String, whitespace: &mut String) {
  if whitespace.is_empty() {
    return;
  }

  if whitespace.chars().any(|ch| matches!(ch, '\n' | '\r'))
    || whitespace.chars().count() >= 2
  {
    output.push(' ');
  } else if let Some(ch) = whitespace.chars().next() {
    output.push(ch);
  }

  whitespace.clear();
}

fn first_char(text: &str) -> Option<(char, usize)> {
  text.chars().next().map(|ch| (ch, ch.len_utf8()))
}

fn last_char(text: &str) -> Option<(char, usize)> {
  text.chars().next_back().map(|ch| (ch, ch.len_utf8()))
}
