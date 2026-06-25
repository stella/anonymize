use std::sync::LazyLock;

use regex::Regex;

use crate::byte_offsets::ByteOffsets;
use crate::processors::DenyListFilterData;
use crate::resolution::{DetectionSource, PipelineEntity, SourceDetail};
use crate::types::{Error, Result};

const ADDRESS_LABEL: &str = "address";
const ORGANIZATION_LABEL: &str = "organization";
const PERSON_LABEL: &str = "person";
const REGISTRATION_NUMBER_LABEL: &str = "registration number";
const MAX_ORGANIZATION_LENGTH: usize = 80;
const MAX_PERSON_LENGTH: usize = 60;
const MAX_OPEN_ENDED_ORGANIZATION_WORDS: usize = 8;
const ALL_CAPS_LINE_LETTER_THRESHOLD: usize = 5;
const ALL_CAPS_LINE_RATIO: f64 = 0.95;
const ALL_CAPS_LINE_PROSE_EXTRA_LETTERS: usize = 20;
const ALL_CAPS_LINE_HEADING_WORD_LIMIT: usize = 5;

static POSTAL_CODE_RE: LazyLock<Option<Regex>> =
  LazyLock::new(|| Regex::new(r"\d{3}\s?\d{2}").ok());
static SECTION_NUMBER_RE: LazyLock<Option<Regex>> =
  LazyLock::new(|| Regex::new(r"^(?:§\s*)?\d{1,3}(?:\.\d{1,3}){0,4}\.?$").ok());

pub(crate) fn filter_entity_false_positives(
  entities: Vec<PipelineEntity>,
  full_text: &str,
  filters: Option<&DenyListFilterData>,
) -> Result<Vec<PipelineEntity>> {
  let offsets = ByteOffsets::new(full_text);
  let mut filtered = Vec::with_capacity(entities.len());
  for entity in entities {
    if is_caller_owned(&entity) {
      filtered.push(entity);
      continue;
    }

    let Some(normalized) =
      normalize_entity(&entity, full_text, &offsets, filters)?
    else {
      continue;
    };
    if should_reject_entity(&normalized, full_text, &offsets, filters)? {
      continue;
    }
    filtered.push(normalized);
  }

  Ok(filtered)
}

fn normalize_entity(
  entity: &PipelineEntity,
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  filters: Option<&DenyListFilterData>,
) -> Result<Option<PipelineEntity>> {
  let raw_text = offsets.slice(full_text, entity.start, entity.end)?;
  let mut start_byte = 0usize;
  let mut end_byte = raw_text.len();

  trim_leading_artifacts(&raw_text, &mut start_byte, end_byte);
  trim_leading_whitespace(&raw_text, &mut start_byte, end_byte);

  if entity.label == ADDRESS_LABEL
    && let Some(filters) = filters
  {
    if let Some(trimmed) =
      address_role_prefix_len(slice(&raw_text, start_byte, end_byte)?, filters)
    {
      start_byte = start_byte.saturating_add(trimmed);
      trim_leading_whitespace(&raw_text, &mut start_byte, end_byte);
    }

    let address_text = slice(&raw_text, start_byte, end_byte)?;
    if let Some(trimmed_end) =
      trim_trailing_address_prose(address_text, filters)
    {
      end_byte = start_byte.saturating_add(trimmed_end);
    }
  }

  trim_trailing_separators(&raw_text, start_byte, &mut end_byte);
  if start_byte >= end_byte {
    return Ok(None);
  }

  let cleaned_raw = slice(&raw_text, start_byte, end_byte)?;
  if !cleaned_raw.chars().any(char::is_alphanumeric) {
    return Ok(None);
  }

  let mut normalized = entity.clone();
  normalized.start = entity
    .start
    .saturating_add(byte_len(raw_text.get(..start_byte).unwrap_or_default()));
  normalized.end = normalized.start.saturating_add(byte_len(cleaned_raw));
  normalized.text = collapse_display_whitespace(cleaned_raw);
  Ok(Some(normalized))
}

fn should_reject_entity(
  entity: &PipelineEntity,
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  filters: Option<&DenyListFilterData>,
) -> Result<bool> {
  let text = entity.text.trim();
  if is_template_placeholder(text) {
    return Ok(true);
  }
  if exceeds_label_length(entity) {
    return Ok(true);
  }
  if exceeds_open_ended_word_count(entity) {
    return Ok(true);
  }
  if is_section_number(text) && entity.source != DetectionSource::Trigger {
    return Ok(true);
  }
  if is_standalone_year(text) && entity.source != DetectionSource::Trigger {
    return Ok(true);
  }
  if entity.source != DetectionSource::Trigger
    && text.chars().next().is_some_and(|ch| ch.is_ascii_digit())
    && let Some(filters) = filters
    && has_number_abbrev_prefix(full_text, offsets, entity, filters)?
  {
    return Ok(true);
  }
  if entity.label == REGISTRATION_NUMBER_LABEL && is_short_letter_run(text) {
    return Ok(true);
  }
  if entity.label == PERSON_LABEL && text.chars().any(|ch| ch.is_ascii_digit())
  {
    return Ok(true);
  }
  if let Some(filters) = filters {
    if entity.label == PERSON_LABEL && is_single_person_stopword(text, filters)
    {
      return Ok(true);
    }
    if entity.label == PERSON_LABEL
      && ends_in_person_trailing_noun(entity, filters)
    {
      return Ok(true);
    }
    if role_exact_match(entity, filters) {
      return Ok(true);
    }
  }
  if entity.label == ORGANIZATION_LABEL
    && is_all_caps_candidate(text)
    && is_all_caps_boilerplate_line(full_text, offsets, entity)?
  {
    return Ok(true);
  }
  if entity.label == ORGANIZATION_LABEL
    && filters
      .is_some_and(|filters| is_document_structure_heading(text, filters))
  {
    return Ok(true);
  }
  if entity.label == ADDRESS_LABEL && should_reject_address(entity, filters) {
    return Ok(true);
  }

  Ok(false)
}

fn should_reject_address(
  entity: &PipelineEntity,
  filters: Option<&DenyListFilterData>,
) -> bool {
  let text = entity.text.trim();
  if filters.is_some_and(|filters| is_signing_place_address(text, filters)) {
    return true;
  }

  let has_digits = text.chars().any(|ch| ch.is_ascii_digit());
  let has_component =
    filters.is_some_and(|filters| has_address_component(text, filters));
  if filters.is_some_and(|filters| is_jurisdiction_address(text, filters)) {
    return false;
  }
  if entity.source == DetectionSource::Trigger && !has_digits {
    if filters.is_some_and(|filters| is_only_ambiguous_component(text, filters))
    {
      return true;
    }
    if !has_component {
      return true;
    }
  }

  text.chars().count() > 40
    && !has_digits
    && !regex_is_match(&POSTAL_CODE_RE, text)
    && !has_component
}

fn exceeds_label_length(entity: &PipelineEntity) -> bool {
  if entity.source == DetectionSource::LegalForm {
    return false;
  }
  let max = match entity.label.as_str() {
    ORGANIZATION_LABEL => MAX_ORGANIZATION_LENGTH,
    PERSON_LABEL => MAX_PERSON_LENGTH,
    _ => return false,
  };
  entity.text.chars().count() > max
}

fn exceeds_open_ended_word_count(entity: &PipelineEntity) -> bool {
  entity.label == ORGANIZATION_LABEL
    && matches!(
      entity.source,
      DetectionSource::Trigger | DetectionSource::Coreference
    )
    && word_count(&entity.text) > MAX_OPEN_ENDED_ORGANIZATION_WORDS
}

fn is_template_placeholder(text: &str) -> bool {
  let trimmed = text.trim();
  if trimmed.len() >= 3 && trimmed.chars().all(|ch| ch == '.' || ch == '_') {
    return true;
  }
  let Some(inner) = bracketed_inner(trimmed, '[', ']')
    .or_else(|| bracketed_inner(trimmed, '{', '}'))
  else {
    return false;
  };
  !inner.is_empty()
    && inner
      .chars()
      .all(|ch| ch == '_' || ch.is_alphanumeric() || ch.is_whitespace())
}

fn bracketed_inner(text: &str, open: char, close: char) -> Option<&str> {
  let mut chars = text.chars();
  if chars.next()? != open || chars.next_back()? != close {
    return None;
  }
  let start = open.len_utf8();
  let end = text.len().saturating_sub(close.len_utf8());
  text.get(start..end)
}

fn is_section_number(text: &str) -> bool {
  regex_is_match(&SECTION_NUMBER_RE, text.trim())
}

fn is_standalone_year(text: &str) -> bool {
  let trimmed = text.trim();
  trimmed.len() == 4
    && trimmed.chars().all(|ch| ch.is_ascii_digit())
    && (trimmed.starts_with("19") || trimmed.starts_with("20"))
}

fn has_number_abbrev_prefix(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  entity: &PipelineEntity,
  filters: &DenyListFilterData,
) -> Result<bool> {
  let start = offsets.validate_offset(entity.start)?;
  let before = full_text.get(..start).ok_or(Error::InvalidSpan {
    start: entity.start,
    end: entity.end,
  })?;
  Ok(ends_with_number_abbrev(before, filters))
}

fn ends_with_number_abbrev(text: &str, filters: &DenyListFilterData) -> bool {
  let lower = text.trim_end().to_lowercase();
  filters.number_abbrev_prefixes.iter().any(|prefix| {
    let Some(before_prefix) = lower.strip_suffix(prefix) else {
      return false;
    };
    before_prefix
      .chars()
      .next_back()
      .is_none_or(|ch| ch.is_whitespace() || ch == '(')
  })
}

fn is_document_structure_heading(
  text: &str,
  filters: &DenyListFilterData,
) -> bool {
  let Some((word_end, word)) = first_word(text.trim_start()) else {
    return false;
  };
  if !filters
    .document_heading_words
    .contains(&word.to_lowercase())
  {
    return false;
  }
  let Some(rest) = text.trim_start().get(word_end..) else {
    return false;
  };
  starts_with_ordinal_marker_digit(rest, filters)
}

fn starts_with_ordinal_marker_digit(
  text: &str,
  filters: &DenyListFilterData,
) -> bool {
  let trimmed = text.trim_start();
  let lower = trimmed.to_lowercase();
  filters
    .document_heading_ordinal_markers
    .iter()
    .any(|marker| {
      if marker.is_empty() {
        return false;
      }
      if !lower.starts_with(marker) {
        return false;
      }
      let Some(rest) = trimmed.get(marker.len()..) else {
        return false;
      };
      rest
        .trim_start()
        .chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_digit())
    })
}

fn is_short_letter_run(text: &str) -> bool {
  let letters = text.trim();
  (1..=2).contains(&letters.chars().count())
    && letters.chars().all(char::is_alphabetic)
}

fn is_single_person_stopword(text: &str, filters: &DenyListFilterData) -> bool {
  let token = trim_token_punctuation(text);
  !token.is_empty()
    && !token.chars().any(char::is_whitespace)
    && filters.person_stopwords.contains(&token.to_lowercase())
}

fn ends_in_person_trailing_noun(
  entity: &PipelineEntity,
  filters: &DenyListFilterData,
) -> bool {
  if matches!(
    entity.source_detail,
    Some(SourceDetail::CustomDenyList | SourceDetail::CustomRegex)
  ) {
    return false;
  }

  let mut words = entity
    .text
    .split(|ch: char| !ch.is_alphabetic())
    .filter(|word| !word.is_empty());
  if words.next().is_none() {
    return false;
  }
  let Some(last) = words.next_back() else {
    return false;
  };
  filters.person_trailing_nouns.contains(&last.to_lowercase())
}

fn role_exact_match(
  entity: &PipelineEntity,
  filters: &DenyListFilterData,
) -> bool {
  matches!(entity.label.as_str(), PERSON_LABEL | ORGANIZATION_LABEL)
    && filters
      .generic_roles
      .contains(&entity.text.trim().to_lowercase())
}

fn is_all_caps_candidate(text: &str) -> bool {
  let mut has_upper = false;
  for ch in text.chars().filter(|ch| ch.is_alphabetic()) {
    if ch.is_lowercase() {
      return false;
    }
    has_upper |= ch.is_uppercase();
  }
  has_upper
}

fn is_all_caps_boilerplate_line(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  entity: &PipelineEntity,
) -> Result<bool> {
  let start = offsets.validate_offset(entity.start)?;
  let end = offsets.validate_offset(entity.end)?;
  let before = full_text.get(..start).ok_or(Error::InvalidSpan {
    start: entity.start,
    end: entity.end,
  })?;
  let line_start = before
    .rfind('\n')
    .map_or(0usize, |index| index.saturating_add('\n'.len_utf8()));
  let after = full_text.get(end..).ok_or(Error::InvalidSpan {
    start: entity.start,
    end: entity.end,
  })?;
  let line_end = after
    .find('\n')
    .map_or(full_text.len(), |index| end.saturating_add(index));
  let line = full_text
    .get(line_start..line_end)
    .ok_or(Error::InvalidSpan {
      start: entity.start,
      end: entity.end,
    })?;
  let entity_rel_start = start.saturating_sub(line_start);
  let entity_rel_end = end.saturating_sub(line_start);

  let mut letter_count = 0usize;
  let mut upper_count = 0usize;
  let mut outside_entity_letters = 0usize;
  for (index, ch) in line.char_indices() {
    if !ch.is_alphabetic() {
      continue;
    }
    letter_count = letter_count.saturating_add(1);
    if ch.is_uppercase() {
      upper_count = upper_count.saturating_add(1);
    }
    if index < entity_rel_start || index >= entity_rel_end {
      outside_entity_letters = outside_entity_letters.saturating_add(1);
    }
  }

  if letter_count <= ALL_CAPS_LINE_LETTER_THRESHOLD {
    return Ok(false);
  }
  if !uppercase_ratio_at_least(upper_count, letter_count) {
    return Ok(false);
  }
  if starts_with_section_heading_prefix(line) {
    return Ok(true);
  }
  if outside_entity_letters >= ALL_CAPS_LINE_PROSE_EXTRA_LETTERS {
    return Ok(true);
  }
  Ok(
    word_count(&entity.text) > ALL_CAPS_LINE_HEADING_WORD_LIMIT
      && !entity.text.contains(','),
  )
}

fn starts_with_section_heading_prefix(line: &str) -> bool {
  let mut chars = line.trim_start().chars().peekable();
  if chars.peek().is_some_and(|ch| *ch == '§') {
    chars.next();
    while chars.peek().is_some_and(|ch| ch.is_whitespace()) {
      chars.next();
    }
  }

  let mut saw_digit = false;
  let mut group_digits = 0usize;
  while let Some(ch) = chars.peek().copied() {
    if ch.is_ascii_digit() {
      saw_digit = true;
      group_digits = group_digits.saturating_add(1);
      if group_digits > 3 {
        return false;
      }
      chars.next();
      continue;
    }
    if ch == '.' && saw_digit {
      group_digits = 0;
      chars.next();
      continue;
    }
    break;
  }
  if !saw_digit {
    return false;
  }
  while chars.peek().is_some_and(|ch| ch.is_whitespace()) {
    chars.next();
  }
  chars.next().is_some_and(char::is_uppercase)
}

fn trim_leading_artifacts(text: &str, start: &mut usize, end: usize) {
  while let Some(rest) = text.get(*start..end) {
    if !rest.starts_with('.') {
      break;
    }
    let after_dot_start = '.'.len_utf8();
    let Some(after_dot) = rest.get(after_dot_start..) else {
      break;
    };
    let whitespace = leading_whitespace_len(after_dot);
    if whitespace == 0 {
      break;
    }
    *start =
      (*start).saturating_add(after_dot_start.saturating_add(whitespace));
  }
}

fn trim_leading_whitespace(text: &str, start: &mut usize, end: usize) {
  let Some(rest) = text.get(*start..end) else {
    return;
  };
  *start = (*start).saturating_add(leading_whitespace_len(rest));
}

fn trim_trailing_separators(text: &str, start: usize, end: &mut usize) {
  while let Some(slice) = text.get(start..*end) {
    let Some((index, ch)) = slice.char_indices().next_back() else {
      break;
    };
    if ch.is_whitespace() || ch == ',' {
      *end = start.saturating_add(index);
      continue;
    }
    break;
  }
}

fn address_role_prefix_len(
  text: &str,
  filters: &DenyListFilterData,
) -> Option<usize> {
  let (word_end, word) = first_word(text)?;
  if !filters.generic_roles.contains(&word.to_lowercase()) {
    return None;
  }
  let rest = text.get(word_end..)?;
  let whitespace = leading_whitespace_len(rest);
  if whitespace == 0 {
    return None;
  }
  let candidate = rest.get(whitespace..)?;
  if looks_like_address_start(candidate, filters) {
    return Some(word_end.saturating_add(whitespace));
  }
  None
}

fn looks_like_address_start(text: &str, filters: &DenyListFilterData) -> bool {
  let trimmed = text.trim_start();
  trimmed.chars().next().is_some_and(|ch| {
    ch.is_ascii_digit()
      || ch.is_uppercase()
      || has_address_component(trimmed, filters)
  })
}

fn trim_trailing_address_prose(
  text: &str,
  filters: &DenyListFilterData,
) -> Option<usize> {
  for (index, ch) in text.char_indices() {
    if ch != '.' {
      continue;
    }
    let before = text.get(..index)?;
    if !before.chars().any(|candidate| candidate.is_ascii_digit()) {
      continue;
    }
    if text_ends_with_address_component(before.trim_end(), filters) {
      continue;
    }
    let after = text
      .get(index.saturating_add('.'.len_utf8())..)?
      .trim_start();
    if after.len() < 5 || has_address_component(after, filters) {
      continue;
    }
    if after.chars().next().is_some_and(char::is_uppercase) {
      return Some(before.trim_end().len());
    }
  }
  None
}

fn has_address_component(text: &str, filters: &DenyListFilterData) -> bool {
  let lower = text.to_lowercase();
  filters
    .street_types
    .iter()
    .any(|component| contains_component(&lower, component))
    || filters
      .address_component_terms
      .iter()
      .any(|component| contains_component(&lower, component))
}

fn is_only_ambiguous_component(
  text: &str,
  filters: &DenyListFilterData,
) -> bool {
  filters
    .ambiguous_street_type_terms
    .iter()
    .any(|term| is_only_ambiguous_component_term(text, filters, term))
}

fn is_only_ambiguous_component_term(
  text: &str,
  filters: &DenyListFilterData,
  term: &str,
) -> bool {
  if term.is_empty() {
    return false;
  }
  let Some((start, end)) = find_ambiguous_component_occurrence(text, term)
  else {
    return false;
  };
  if text
    .get(end..)
    .is_some_and(starts_with_capitalized_token_after_space)
  {
    return false;
  }
  let mut stripped = String::with_capacity(text.len());
  stripped.push_str(text.get(..start).unwrap_or_default());
  stripped.push(' ');
  stripped.push_str(text.get(end..).unwrap_or_default());
  !has_address_component(&stripped, filters)
}

fn find_ambiguous_component_occurrence(
  text: &str,
  term: &str,
) -> Option<(usize, usize)> {
  text.match_indices(term).find_map(|(start, _)| {
    let end = start.saturating_add(term.len());
    let left_ok = text
      .get(..start)
      .and_then(|prefix| prefix.chars().next_back())
      .is_none_or(is_left_component_boundary);
    let right_ok = text
      .get(end..)
      .and_then(|suffix| suffix.chars().next())
      .is_none_or(is_right_component_boundary);
    (left_ok && right_ok).then_some((start, end))
  })
}

fn starts_with_capitalized_token_after_space(text: &str) -> bool {
  let leading = leading_whitespace_len(text);
  if leading == 0 {
    return false;
  }
  text
    .get(leading..)
    .and_then(|tail| tail.chars().next())
    .is_some_and(char::is_uppercase)
}

fn is_jurisdiction_address(text: &str, filters: &DenyListFilterData) -> bool {
  let lower = text.to_lowercase();
  filters.address_jurisdiction_prefixes.iter().any(|prefix| {
    let Some(rest) = lower.strip_prefix(prefix) else {
      return false;
    };
    rest.chars().next().is_some_and(char::is_whitespace)
      && rest.chars().any(char::is_alphabetic)
  })
}

fn text_ends_with_address_component(
  text: &str,
  filters: &DenyListFilterData,
) -> bool {
  let lower = text.to_lowercase();
  filters.street_types.iter().any(|component| {
    if component.is_empty() || !lower.ends_with(component) {
      return false;
    }
    let prefix_len = lower.len().saturating_sub(component.len());
    lower
      .get(..prefix_len)
      .and_then(|prefix| prefix.chars().next_back())
      .is_none_or(is_left_component_boundary)
  })
}

fn contains_component(text: &str, component: &str) -> bool {
  if component.is_empty() {
    return false;
  }
  text.match_indices(component).any(|(start, _)| {
    let end = start.saturating_add(component.len());
    let left_ok = text
      .get(..start)
      .and_then(|prefix| prefix.chars().next_back())
      .is_none_or(is_left_component_boundary);
    let right_ok = text
      .get(end..)
      .and_then(|suffix| suffix.chars().next())
      .is_none_or(is_right_component_boundary);
    left_ok && right_ok
  })
}

const fn is_left_component_boundary(ch: char) -> bool {
  ch.is_whitespace() || ch == ',' || ch == '(' || ch == '['
}

const fn is_right_component_boundary(ch: char) -> bool {
  ch.is_whitespace() || matches!(ch, ',' | '.' | '/' | ')' | ']')
}

fn is_signing_place_address(text: &str, filters: &DenyListFilterData) -> bool {
  let lower = text.to_lowercase();
  filters.signing_place_guards.iter().any(|guard| {
    guard.prefix_phrases.iter().any(|prefix| {
      !prefix.is_empty()
        && lower.starts_with(prefix)
        && guard
          .suffix_phrases
          .iter()
          .any(|suffix| !suffix.is_empty() && lower.ends_with(suffix))
    })
  })
}

fn first_word(text: &str) -> Option<(usize, &str)> {
  let mut end = 0usize;
  for (index, ch) in text.char_indices() {
    if !ch.is_alphabetic() {
      break;
    }
    end = index.saturating_add(ch.len_utf8());
  }
  if end == 0 {
    return None;
  }
  text.get(..end).map(|word| (end, word))
}

fn word_count(text: &str) -> usize {
  let mut count = 0usize;
  let mut in_word = false;
  for ch in text.chars() {
    let word_char =
      ch.is_alphanumeric() || matches!(ch, '\'' | '’' | '-' | '.');
    if word_char && !in_word {
      count = count.saturating_add(1);
    }
    in_word = word_char;
  }
  count
}

fn trim_token_punctuation(text: &str) -> &str {
  text
    .trim()
    .trim_matches(|ch: char| matches!(ch, '.' | ',' | ';' | ':' | '!' | '?'))
}

fn leading_whitespace_len(text: &str) -> usize {
  let mut len = 0usize;
  for ch in text.chars() {
    if !ch.is_whitespace() {
      break;
    }
    len = len.saturating_add(ch.len_utf8());
  }
  len
}

fn slice(text: &str, start: usize, end: usize) -> Result<&str> {
  text.get(start..end).ok_or_else(|| Error::InvalidSpan {
    start: u32::try_from(start).unwrap_or(u32::MAX),
    end: u32::try_from(end).unwrap_or(u32::MAX),
  })
}

fn collapse_display_whitespace(text: &str) -> String {
  let mut out = String::new();
  let mut whitespace = String::new();

  for ch in text.chars() {
    if ch.is_whitespace() {
      whitespace.push(ch);
      continue;
    }

    flush_whitespace(&mut out, &mut whitespace);
    out.push(ch);
  }

  flush_whitespace(&mut out, &mut whitespace);
  out
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

fn byte_len(text: &str) -> u32 {
  u32::try_from(text.len()).unwrap_or(u32::MAX)
}

fn regex_is_match(regex: &LazyLock<Option<Regex>>, text: &str) -> bool {
  regex
    .as_ref()
    .is_some_and(|compiled| compiled.is_match(text))
}

fn uppercase_ratio_at_least(upper_count: usize, letter_count: usize) -> bool {
  let Some(upper) = u32::try_from(upper_count).ok().map(f64::from) else {
    return true;
  };
  let Some(total) = u32::try_from(letter_count).ok().map(f64::from) else {
    return true;
  };
  upper / total >= ALL_CAPS_LINE_RATIO
}

const fn is_caller_owned(entity: &PipelineEntity) -> bool {
  matches!(
    entity.source_detail,
    Some(SourceDetail::CustomDenyList | SourceDetail::CustomRegex)
  )
}

#[cfg(test)]
mod tests {
  #![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

  use std::collections::BTreeSet;

  use super::*;

  #[test]
  fn rejects_template_placeholders() {
    let entities = filter_entity_false_positives(
      vec![entity(
        "[NAME]",
        "[NAME]",
        PERSON_LABEL,
        DetectionSource::Regex,
      )],
      "[NAME]",
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn rejects_generic_false_positives_without_deny_list_filters() {
    let text = "[NAME]\n17. NO ASSIGNMENT.\n";
    let heading_start = text.find("NO ASSIGNMENT").unwrap();
    let heading_end = heading_start.saturating_add("NO ASSIGNMENT".len());
    let entities = filter_entity_false_positives(
      vec![
        entity("[NAME]", "[NAME]", PERSON_LABEL, DetectionSource::Regex),
        PipelineEntity::detected(
          u32::try_from(heading_start).unwrap(),
          u32::try_from(heading_end).unwrap(),
          ORGANIZATION_LABEL,
          "NO ASSIGNMENT",
          0.8,
          DetectionSource::Regex,
        ),
      ],
      text,
      None,
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn trims_address_role_prefix_from_shared_role_data() {
    let text = "sídlo prodávajícího Na Květnici 1";
    let start = text.find("prodávajícího").unwrap();
    let filters = DenyListFilterData {
      generic_roles: set(["prodávajícího"]),
      ..DenyListFilterData::default()
    };

    let entities = filter_entity_false_positives(
      vec![PipelineEntity::detected(
        u32::try_from(start).unwrap(),
        u32::try_from(text.len()).unwrap(),
        ADDRESS_LABEL,
        "prodávajícího Na Květnici 1",
        0.8,
        DetectionSource::Trigger,
      )],
      text,
      Some(&filters),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Na Květnici 1");
    assert_eq!(
      entities[0].start,
      u32::try_from("sídlo prodávajícího ".len()).unwrap()
    );
  }

  #[test]
  fn preserves_single_non_breaking_space_in_entity_text() {
    let text = "Městským soudem v\u{00a0}Praze";
    let entities = filter_entity_false_positives(
      vec![entity(
        text,
        text,
        ORGANIZATION_LABEL,
        DetectionSource::Trigger,
      )],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, text);
  }

  #[test]
  fn rejects_trigger_address_without_digits_or_street_component() {
    let entities = filter_entity_false_positives(
      vec![entity(
        "Nejsme plátci DPH",
        "Nejsme plátci DPH",
        ADDRESS_LABEL,
        DetectionSource::Trigger,
      )],
      "Nejsme plátci DPH",
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn keeps_trigger_address_with_street_component() {
    let filters = DenyListFilterData {
      street_types: set(["street"]),
      ..DenyListFilterData::default()
    };
    let entities = filter_entity_false_positives(
      vec![entity(
        "West Street",
        "West Street",
        ADDRESS_LABEL,
        DetectionSource::Trigger,
      )],
      "West Street",
      Some(&filters),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
  }

  #[test]
  fn keeps_configured_jurisdiction_addresses_without_digits() {
    let filters = DenyListFilterData {
      address_jurisdiction_prefixes: set(["state of"]),
      ..DenyListFilterData::default()
    };
    let entities = filter_entity_false_positives(
      vec![entity(
        "State of Delaware",
        "State of Delaware",
        ADDRESS_LABEL,
        DetectionSource::Trigger,
      )],
      "State of Delaware",
      Some(&filters),
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
  }

  #[test]
  fn rejects_person_stopwords() {
    let filters = DenyListFilterData {
      person_stopwords: set(["tato"]),
      ..DenyListFilterData::default()
    };
    let entities = filter_entity_false_positives(
      vec![entity("Tato", "Tato", PERSON_LABEL, DetectionSource::Regex)],
      "Tato",
      Some(&filters),
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  #[test]
  fn rejects_all_caps_section_heading_organizations() {
    let text = "17. NO ASSIGNMENT.\n";
    let start = text.find("NO ASSIGNMENT").unwrap();
    let end = start.saturating_add("NO ASSIGNMENT".len());
    let entities = filter_entity_false_positives(
      vec![PipelineEntity::detected(
        u32::try_from(start).unwrap(),
        u32::try_from(end).unwrap(),
        ORGANIZATION_LABEL,
        "NO ASSIGNMENT",
        0.8,
        DetectionSource::Regex,
      )],
      text,
      Some(&DenyListFilterData::default()),
    )
    .unwrap();

    assert!(entities.is_empty());
  }

  fn entity(
    full_text: &str,
    text: &str,
    label: &str,
    source: DetectionSource,
  ) -> PipelineEntity {
    PipelineEntity::detected(
      0,
      u32::try_from(full_text.len()).expect("fixture length fits u32"),
      label,
      text,
      0.8,
      source,
    )
  }

  fn set<const N: usize>(values: [&str; N]) -> BTreeSet<String> {
    values.into_iter().map(String::from).collect()
  }
}
