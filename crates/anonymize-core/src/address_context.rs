use std::collections::BTreeSet;

use regex::Regex;

use crate::byte_offsets::ByteOffsets;
use crate::resolution::{DetectionSource, PipelineEntity, SourceDetail};
use crate::types::{Error, Result};

const HEADER_ZONE_PERCENT: usize = 15;
// Legal-document headers are short structural regions, not a fixed share of an
// arbitrarily large body. Both bounds prevent header-only scans from growing
// with concatenated or unusually long documents.
const HEADER_ZONE_MAX_UTF16_UNITS: u32 = 32 * 1024;
const HEADER_ZONE_MAX_LINES: usize = 200;
// Finish a header's last physical line when it is short, without allowing a
// newline-free OCR/minified document to turn the header scan into a body scan.
const HEADER_SCAN_MAX_LINE_EXTENSION_UTF16_UNITS: u32 = 512;
const STREET_CONTEXT_WINDOW: u32 = 200;
const BARE_HOUSE_CONTEXT_WINDOW: u32 = 50;
const MAX_UTF8_BYTES_PER_UTF16_UNIT: u32 = 3;
const MAX_BACKWARD_WORDS: usize = 5;

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct AddressContextData {
  #[serde(default)]
  pub address_prepositions: Vec<String>,
  #[serde(default)]
  pub temporal_prepositions: Vec<String>,
  #[serde(default)]
  pub street_abbreviations: Vec<String>,
  #[serde(default)]
  pub bare_house_stopwords: Vec<String>,
}

pub(crate) struct PreparedAddressContextData {
  address_prepositions: BTreeSet<String>,
  temporal_prepositions: BTreeSet<String>,
  street_abbreviations: BTreeSet<String>,
  bare_house_stopwords: BTreeSet<String>,
  slash_house_number: Regex,
  bare_house_number: Regex,
  orphan_street_line: Regex,
}

struct WordBefore {
  start: usize,
  raw: String,
  normalized: String,
  has_dot: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ScanRange {
  start: usize,
  end: usize,
}

struct EntityProximityIndex<'a> {
  entities: Vec<&'a PipelineEntity>,
  prefix_max_ends: Vec<u32>,
}

struct NearbyEntities<'index, 'entity> {
  entities: &'index [&'entity PipelineEntity],
  prefix_max_ends: &'index [u32],
  next: usize,
  minimum_end: u32,
}

impl<'entity> Iterator for NearbyEntities<'_, 'entity> {
  type Item = &'entity PipelineEntity;

  fn next(&mut self) -> Option<Self::Item> {
    while self.next > 0 {
      let current = self.next.saturating_sub(1);
      self.next = current;
      if self.prefix_max_ends.get(current).copied()? < self.minimum_end {
        self.next = 0;
        return None;
      }
      let entity = self.entities.get(current).copied()?;
      if entity.end >= self.minimum_end {
        return Some(entity);
      }
    }
    None
  }
}

impl<'a> EntityProximityIndex<'a> {
  fn addresses(entities: impl Iterator<Item = &'a PipelineEntity>) -> Self {
    let entities = entities
      .filter(|entity| entity.label == crate::labels::ADDRESS_LABEL)
      .filter(|entity| !is_caller_owned_entity(entity))
      .collect::<Vec<_>>();
    Self::from_entities(entities)
  }

  fn orphan_context(
    entities: impl Iterator<Item = &'a PipelineEntity>,
  ) -> Self {
    let entities = entities
      .filter(|entity| {
        !(entity.label == crate::labels::ADDRESS_LABEL
          && is_caller_owned_entity(entity))
      })
      .collect::<Vec<_>>();
    Self::from_entities(entities)
  }

  fn from_entities(mut entities: Vec<&'a PipelineEntity>) -> Self {
    entities.sort_by_key(|entity| (entity.start, entity.end));
    let mut prefix_max_ends = Vec::with_capacity(entities.len());
    let mut maximum_end = 0_u32;
    for entity in &entities {
      maximum_end = maximum_end.max(entity.end);
      prefix_max_ends.push(maximum_end);
    }
    Self {
      entities,
      prefix_max_ends,
    }
  }

  fn entities(&self) -> &[&'a PipelineEntity] {
    &self.entities
  }

  fn is_within_context_window(
    &self,
    offsets: &ByteOffsets<'_>,
    start: u32,
    end: u32,
    window: u32,
  ) -> bool {
    self
      .nearby(start, end, window)
      .any(|entity| within_context_window(offsets, entity, start, end, window))
  }

  fn nearby(
    &self,
    start: u32,
    end: u32,
    window: u32,
  ) -> NearbyEntities<'_, 'a> {
    let window_bytes = window.saturating_mul(MAX_UTF8_BYTES_PER_UTF16_UNIT);
    let minimum_end = start.saturating_sub(window_bytes);
    let maximum_start = end.saturating_add(window_bytes);
    let next = self
      .entities
      .partition_point(|entity| entity.start <= maximum_start);
    NearbyEntities {
      entities: &self.entities,
      prefix_max_ends: &self.prefix_max_ends,
      next,
      minimum_end,
    }
  }
}

impl PreparedAddressContextData {
  pub(crate) fn new(data: AddressContextData) -> Result<Self> {
    Ok(Self {
      address_prepositions: lowercased_set(data.address_prepositions),
      temporal_prepositions: lowercased_set(data.temporal_prepositions),
      street_abbreviations: lowercased_set(data.street_abbreviations),
      bare_house_stopwords: lowercased_set(data.bare_house_stopwords),
      slash_house_number: compile_regex(
        "address_context.slash_house_number",
        r"(?u)\b(?:\d{1,4}/\d+[A-Za-z]\b|\d{3,4}/\d+\b|(?:1[3-9]|[2-9]\d)/\d{3,}\b)",
      )?,
      bare_house_number: compile_regex(
        "address_context.bare_house_number",
        r"(?u)(?:^|\s)(?P<value>\p{Lu}\p{Ll}[\p{Ll}\p{Lu}]+\s+\d{1,3})\b",
      )?,
      orphan_street_line: compile_regex(
        "address_context.orphan_street_line",
        r"(?um)^[^\S\n]*(?P<value>\p{Lu}[\p{Ll}\p{Lu}]+(?:[^\S\n]+[\p{Lu}\p{Ll}][\p{Ll}]+)*[^\S\n]+\d{2,4}[A-Za-z]?)[^\S\n]*$",
      )?,
    })
  }

  pub(crate) fn process(
    &self,
    full_text: &str,
    existing_entities: &[PipelineEntity],
  ) -> Result<Vec<PipelineEntity>> {
    let mut results = self
      .detect_street_patterns_near_addresses(full_text, existing_entities)?;
    let mut orphan_context =
      Vec::with_capacity(existing_entities.len().saturating_add(results.len()));
    orphan_context.extend_from_slice(existing_entities);
    orphan_context.extend(results.iter().cloned());
    results
      .extend(self.detect_orphan_street_lines(full_text, &orphan_context)?);
    Ok(results)
  }

  fn detect_street_patterns_near_addresses(
    &self,
    full_text: &str,
    existing_entities: &[PipelineEntity],
  ) -> Result<Vec<PipelineEntity>> {
    let mut results = Vec::new();
    let address_entities =
      EntityProximityIndex::addresses(existing_entities.iter());
    let header_end = header_end(full_text);
    let offsets = ByteOffsets::new(full_text);
    let scan_ranges = address_context_scan_ranges(
      full_text,
      &offsets,
      header_end,
      address_entities.entities(),
    )?;

    for range in scan_ranges {
      let Some(segment) = full_text.get(range.start..range.end) else {
        continue;
      };
      for found in self.slash_house_number.find_iter(segment) {
        let num_start_byte = range.start.saturating_add(found.start());
        let num_end_byte = range.start.saturating_add(found.end());
        if !self.full_slash_house_match_is_identical(
          full_text,
          num_start_byte,
          num_end_byte,
        ) {
          continue;
        }
        let num_start =
          usize_to_u32("address_context.num_start", num_start_byte)?;
        let num_end = usize_to_u32("address_context.num_end", num_end_byte)?;
        if covered_by(existing_entities, num_start, num_end) {
          continue;
        }

        let in_header = num_start < header_end;
        let near_address = address_entities.is_within_context_window(
          &offsets,
          num_start,
          num_end,
          STREET_CONTEXT_WINDOW,
        );
        if !in_header && !near_address {
          continue;
        }

        let Some(scan_start) = skip_whitespace_back(full_text, num_start_byte)
        else {
          continue;
        };
        let Some((street_start, has_temporal_prep)) =
          self.scan_street_start(full_text, scan_start)?
        else {
          continue;
        };
        let street_start_u32 =
          usize_to_u32("address_context.street_start", street_start)?;
        if has_temporal_prep {
          continue;
        }
        if covered_by(existing_entities, street_start_u32, num_end) {
          continue;
        }

        let street_text = text_slice(full_text, street_start_u32, num_end)?;
        if street_text.len() < 4 {
          continue;
        }
        let score = address_context_score(full_text, street_start, in_header);
        results.push(address_context_entity(
          street_start_u32,
          num_end,
          "address",
          street_text,
          score,
          DetectionSource::Regex,
        ));
      }
    }

    self.detect_bare_house_numbers(
      full_text,
      existing_entities,
      &address_entities,
      &mut results,
    )?;
    Ok(results)
  }

  fn full_slash_house_match_is_identical(
    &self,
    full_text: &str,
    start: usize,
    end: usize,
  ) -> bool {
    self
      .slash_house_number
      .find_at(full_text, start)
      .is_some_and(|found| found.start() == start && found.end() == end)
  }

  fn scan_street_start(
    &self,
    full_text: &str,
    mut scan_pos: usize,
  ) -> Result<Option<(usize, bool)>> {
    let mut has_temporal_prep = false;
    let mut street_start = scan_pos;
    let mut word_count = 0usize;

    while word_count < MAX_BACKWARD_WORDS {
      let Some(word) = word_before(full_text, scan_pos)? else {
        break;
      };
      if word.normalized.is_empty() {
        break;
      }

      let is_street_abbrev = word.has_dot
        && self.street_abbreviations.contains(&word.raw.to_lowercase());
      let lower_word = word.normalized.to_lowercase();
      let is_prep = self.address_prepositions.contains(&lower_word);
      let is_upper = word
        .normalized
        .chars()
        .next()
        .is_some_and(char::is_uppercase);
      let is_digit_token = is_short_ascii_digit_token(&word.normalized);
      if !is_upper && !is_prep && !is_street_abbrev && !is_digit_token {
        break;
      }
      if is_prep && self.temporal_prepositions.contains(&lower_word) {
        has_temporal_prep = true;
      }

      street_start = word.start;
      word_count = word_count.saturating_add(1);

      let before_word = skip_whitespace_back(full_text, word.start);
      let Some(next_scan_pos) = before_word else {
        break;
      };
      let Some((_, previous)) = previous_char(full_text, next_scan_pos) else {
        break;
      };
      if matches!(previous, '\n' | '\t' | ';' | ',') {
        break;
      }
      scan_pos = next_scan_pos;
    }

    if word_count == 0 {
      return Ok(None);
    }
    Ok(Some((street_start, has_temporal_prep)))
  }

  fn detect_bare_house_numbers(
    &self,
    full_text: &str,
    existing_entities: &[PipelineEntity],
    existing_address_entities: &EntityProximityIndex<'_>,
    results: &mut Vec<PipelineEntity>,
  ) -> Result<()> {
    let offsets = ByteOffsets::new(full_text);
    let ranges =
      bare_house_scan_ranges(full_text, &offsets, existing_entities, results)?;
    for range in ranges {
      let Some(segment) = full_text.get(range.start..range.end) else {
        continue;
      };
      for captures in self.bare_house_number.captures_iter(segment) {
        let Some(full_match) = captures.get(0) else {
          continue;
        };
        let match_start = range.start.saturating_add(full_match.start());
        let match_end = range.start.saturating_add(full_match.end());
        if !self.full_bare_house_match_is_identical(
          full_text,
          match_start,
          match_end,
        ) {
          continue;
        }
        let Some(captured) = captures.name("value") else {
          continue;
        };
        let start = usize_to_u32(
          "address_context.bare_start",
          range.start.saturating_add(captured.start()),
        )?;
        let end = usize_to_u32(
          "address_context.bare_end",
          range.start.saturating_add(captured.end()),
        )?;
        if !near_confirmed_address_same_line(
          full_text,
          existing_address_entities,
          results,
          start,
          end,
        )? {
          continue;
        }

        let word = captured
          .as_str()
          .split_whitespace()
          .next()
          .unwrap_or("")
          .to_lowercase();
        if self.bare_house_stopwords.contains(&word) {
          continue;
        }
        if overlaps_any(existing_entities, start, end)
          || overlaps_any(results, start, end)
        {
          continue;
        }

        results.push(address_context_entity(
          start,
          end,
          "address",
          captured.as_str(),
          0.75,
          DetectionSource::Regex,
        ));
      }
    }
    Ok(())
  }

  fn detect_orphan_street_lines(
    &self,
    full_text: &str,
    existing_entities: &[PipelineEntity],
  ) -> Result<Vec<PipelineEntity>> {
    let header_end = header_end(full_text);
    let offsets = ByteOffsets::new(full_text);
    let header_scan_end = header_scan_end(full_text, &offsets, header_end)?;
    let header =
      full_text
        .get(..header_scan_end)
        .ok_or_else(|| Error::InvalidSpan {
          start: 0,
          end: u32::try_from(header_scan_end).unwrap_or(u32::MAX),
        })?;
    let context_entities =
      EntityProximityIndex::orphan_context(existing_entities.iter());
    let mut results = Vec::new();

    for captures in self.orphan_street_line.captures_iter(header) {
      let Some(captured) = captures.name("value") else {
        continue;
      };
      let start =
        usize_to_u32("address_context.orphan_start", captured.start())?;
      let end = usize_to_u32("address_context.orphan_end", captured.end())?;
      if start >= header_end || covered_by(existing_entities, start, end) {
        continue;
      }
      let has_context = context_entities.is_within_context_window(
        &offsets,
        start,
        end,
        STREET_CONTEXT_WINDOW,
      );
      if !has_context {
        continue;
      }

      results.push(address_context_entity(
        start,
        end,
        "address",
        captured.as_str(),
        0.85,
        DetectionSource::Regex,
      ));
    }
    Ok(results)
  }

  fn full_bare_house_match_is_identical(
    &self,
    full_text: &str,
    start: usize,
    end: usize,
  ) -> bool {
    self
      .bare_house_number
      .find_at(full_text, start)
      .is_some_and(|found| found.start() == start && found.end() == end)
  }
}

fn lowercased_set(values: Vec<String>) -> BTreeSet<String> {
  values
    .into_iter()
    .map(|value| value.to_lowercase())
    .collect()
}

fn address_context_scan_ranges(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  header_end: u32,
  address_entities: &[&PipelineEntity],
) -> Result<Vec<ScanRange>> {
  let mut ranges = Vec::new();
  let header_end = offsets.validate_offset(header_end)?;
  if header_end > 0 {
    ranges.push(ScanRange {
      start: 0,
      end: header_end,
    });
  }

  for entity in address_entities {
    let start =
      offsets.offset_before_utf16_units(entity.start, STREET_CONTEXT_WINDOW)?;
    let end =
      offsets.offset_after_utf16_units(entity.end, STREET_CONTEXT_WINDOW)?;
    push_scan_range(full_text, &mut ranges, start, end)?;
  }

  Ok(merge_scan_ranges(ranges))
}

fn bare_house_scan_ranges(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  existing_entities: &[PipelineEntity],
  new_entities: &[PipelineEntity],
) -> Result<Vec<ScanRange>> {
  let mut ranges = Vec::new();
  for entity in existing_entities.iter().chain(new_entities.iter()) {
    if entity.label != "address" || is_caller_owned_entity(entity) {
      continue;
    }
    let start = offsets
      .offset_before_utf16_units(entity.start, BARE_HOUSE_CONTEXT_WINDOW)?;
    let end = offsets
      .offset_after_utf16_units(entity.end, BARE_HOUSE_CONTEXT_WINDOW)?;
    ranges.push(line_expanded_scan_range(full_text, offsets, start, end)?);
  }
  Ok(merge_scan_ranges(ranges))
}

fn push_scan_range(
  full_text: &str,
  ranges: &mut Vec<ScanRange>,
  start: u32,
  end: u32,
) -> Result<()> {
  if start >= end {
    return Ok(());
  }
  let start = usize::try_from(start)
    .map_err(|_| Error::ByteOffsetOutOfBounds { offset: start })?;
  let end = usize::try_from(end)
    .map_err(|_| Error::ByteOffsetOutOfBounds { offset: end })?;
  if start > full_text.len() || end > full_text.len() {
    return Err(Error::ByteOffsetOutOfBounds { offset: u32::MAX });
  }
  ranges.push(ScanRange { start, end });
  Ok(())
}

fn merge_scan_ranges(mut ranges: Vec<ScanRange>) -> Vec<ScanRange> {
  ranges.sort_by_key(|range| (range.start, range.end));
  let mut merged = Vec::<ScanRange>::new();
  for range in ranges {
    let Some(last) = merged.last_mut() else {
      merged.push(range);
      continue;
    };
    if range.start <= last.end {
      last.end = last.end.max(range.end);
      continue;
    }
    merged.push(range);
  }
  merged
}

fn line_expanded_scan_range(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  end: u32,
) -> Result<ScanRange> {
  let start = offsets.validate_offset(start)?;
  let end = offsets.validate_offset(end)?;
  let line_start = full_text
    .get(..start)
    .and_then(|prefix| prefix.rfind('\n').map(|index| index.saturating_add(1)))
    .unwrap_or(0);
  let line_end = full_text
    .get(end..)
    .and_then(|suffix| suffix.find('\n').map(|index| end.saturating_add(index)))
    .unwrap_or(full_text.len());
  Ok(ScanRange {
    start: line_start,
    end: line_end,
  })
}

fn header_scan_end(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  header_end: u32,
) -> Result<usize> {
  let header_end = offsets.validate_offset(header_end)?;
  let bounded_end = offsets.offset_after_utf16_units(
    u32::try_from(header_end).unwrap_or(u32::MAX),
    HEADER_SCAN_MAX_LINE_EXTENSION_UTF16_UNITS,
  )?;
  let bounded_end = offsets.validate_offset(bounded_end)?;
  let tail =
    full_text
      .get(header_end..bounded_end)
      .ok_or(Error::InvalidSpan {
        start: u32::try_from(header_end).unwrap_or(u32::MAX),
        end: u32::try_from(bounded_end).unwrap_or(u32::MAX),
      })?;
  let Some(relative_newline) = tail.find('\n') else {
    return Ok(bounded_end);
  };
  Ok(header_end.saturating_add(relative_newline))
}

fn compile_regex(field: &'static str, pattern: &str) -> Result<Regex> {
  Regex::new(pattern).map_err(|error| Error::InvalidStaticData {
    field,
    reason: error.to_string(),
  })
}

fn header_end(full_text: &str) -> u32 {
  let text_len = full_text.chars().map(char::len_utf16).sum::<usize>();
  let percentage_cutoff =
    text_len.saturating_mul(HEADER_ZONE_PERCENT).div_euclid(100);
  let absolute_cutoff =
    usize::try_from(HEADER_ZONE_MAX_UTF16_UNITS).unwrap_or(usize::MAX);
  let cutoff = percentage_cutoff.min(absolute_cutoff);
  let line_cutoff = full_text
    .match_indices('\n')
    .nth(HEADER_ZONE_MAX_LINES.saturating_sub(1))
    .map_or(full_text.len(), |(byte, _)| byte.saturating_add(1));
  let mut units = 0usize;
  for (byte, ch) in full_text.char_indices() {
    if units >= cutoff || byte >= line_cutoff {
      return u32::try_from(byte).unwrap_or(u32::MAX);
    }
    units = units.saturating_add(ch.len_utf16());
  }
  u32::try_from(full_text.len()).unwrap_or(u32::MAX)
}

const fn is_caller_owned_entity(entity: &PipelineEntity) -> bool {
  matches!(
    entity.source_detail,
    Some(SourceDetail::CustomDenyList | SourceDetail::CustomRegex)
  )
}

fn covered_by(entities: &[PipelineEntity], start: u32, end: u32) -> bool {
  entities
    .iter()
    .any(|entity| entity.start <= start && entity.end >= end)
}

fn overlaps_any(entities: &[PipelineEntity], start: u32, end: u32) -> bool {
  entities
    .iter()
    .any(|entity| entity.start < end && entity.end > start)
}

fn address_context_entity(
  start: u32,
  end: u32,
  label: impl Into<String>,
  text: impl Into<String>,
  score: f64,
  source: DetectionSource,
) -> PipelineEntity {
  let mut entity =
    PipelineEntity::detected(start, end, label, text, score, source);
  entity.source_detail = Some(SourceDetail::AddressContext);
  entity
}

fn skip_whitespace_back(full_text: &str, mut pos: usize) -> Option<usize> {
  while let Some((index, ch)) = previous_char(full_text, pos) {
    if !is_space(ch) {
      return Some(pos);
    }
    pos = index;
  }
  None
}

fn previous_char(full_text: &str, pos: usize) -> Option<(usize, char)> {
  full_text.get(..pos)?.char_indices().next_back()
}

fn word_before(full_text: &str, pos: usize) -> Result<Option<WordBefore>> {
  let Some((last_index, last_ch)) = previous_char(full_text, pos) else {
    return Ok(None);
  };
  let mut scan_pos = pos;
  let has_dot = last_ch == '.';
  if has_dot {
    scan_pos = last_index;
  }

  let mut word_start = scan_pos;
  while let Some((previous_index, previous_ch)) =
    previous_char(full_text, word_start)
  {
    if !is_word_char(previous_ch) {
      break;
    }
    word_start = previous_index;
  }

  let raw = full_text
    .get(word_start..pos)
    .ok_or_else(|| Error::InvalidSpan {
      start: u32::try_from(word_start).unwrap_or(u32::MAX),
      end: u32::try_from(pos).unwrap_or(u32::MAX),
    })?
    .to_owned();
  let normalized = full_text
    .get(word_start..scan_pos)
    .ok_or_else(|| Error::InvalidSpan {
      start: u32::try_from(word_start).unwrap_or(u32::MAX),
      end: u32::try_from(scan_pos).unwrap_or(u32::MAX),
    })?
    .to_owned();
  Ok(Some(WordBefore {
    start: word_start,
    raw,
    normalized,
    has_dot,
  }))
}

fn is_word_char(ch: char) -> bool {
  ch.is_alphabetic() || ch.is_ascii_digit() || is_combining_mark(ch)
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

const fn is_space(ch: char) -> bool {
  ch.is_whitespace() || ch == '\u{00a0}'
}

fn near_confirmed_address_same_line(
  full_text: &str,
  existing_entities: &EntityProximityIndex<'_>,
  results: &[PipelineEntity],
  start: u32,
  end: u32,
) -> Result<bool> {
  let offsets = ByteOffsets::new(full_text);
  let nearby_existing =
    existing_entities.nearby(start, end, BARE_HOUSE_CONTEXT_WINDOW);
  let nearby_results = results.iter().filter(|entity| {
    entity.label == crate::labels::ADDRESS_LABEL
      && !is_caller_owned_entity(entity)
      && byte_ranges_may_be_within_window(
        entity,
        start,
        end,
        BARE_HOUSE_CONTEXT_WINDOW,
      )
  });
  for entity in nearby_existing.chain(nearby_results) {
    let dist = span_gap_utf16_units(&offsets, entity, start, end)?;
    if dist > BARE_HOUSE_CONTEXT_WINDOW {
      continue;
    }
    let lo = entity.start.min(start);
    let hi = entity.end.max(end);
    if !text_slice(full_text, lo, hi)?.contains('\n') {
      return Ok(true);
    }
  }
  Ok(false)
}

fn span_gap_utf16_units(
  offsets: &ByteOffsets<'_>,
  entity: &PipelineEntity,
  start: u32,
  end: u32,
) -> Result<u32> {
  if entity.end <= start {
    return offsets.utf16_units_between(entity.end, start);
  }
  if end <= entity.start {
    return offsets.utf16_units_between(end, entity.start);
  }
  Ok(0)
}

fn within_context_window(
  offsets: &ByteOffsets<'_>,
  entity: &PipelineEntity,
  start: u32,
  end: u32,
  window: u32,
) -> bool {
  span_gap_utf16_units(offsets, entity, start, end)
    .is_ok_and(|distance| distance < window)
}

const fn byte_ranges_may_be_within_window(
  entity: &PipelineEntity,
  start: u32,
  end: u32,
  window: u32,
) -> bool {
  let window_bytes = window.saturating_mul(MAX_UTF8_BYTES_PER_UTF16_UNIT);
  entity.end.saturating_add(window_bytes) >= start
    && entity.start <= end.saturating_add(window_bytes)
}

fn is_short_ascii_digit_token(value: &str) -> bool {
  let mut count = 0usize;
  for ch in value.chars() {
    if !ch.is_ascii_digit() {
      return false;
    }
    count = count.saturating_add(1);
  }
  (1..=2).contains(&count)
}

fn address_context_score(
  full_text: &str,
  street_start: usize,
  in_header: bool,
) -> f64 {
  let before_start = street_start.saturating_sub(5);
  let has_colon = full_text
    .get(before_start..street_start)
    .is_some_and(|before| before.contains(':'));
  if has_colon {
    return 0.95;
  }
  if in_header {
    return 0.85;
  }
  0.8
}

fn text_slice(full_text: &str, start: u32, end: u32) -> Result<&str> {
  let start_usize = usize::try_from(start)
    .map_err(|_| Error::ByteOffsetOutOfBounds { offset: start })?;
  let end_usize = usize::try_from(end)
    .map_err(|_| Error::ByteOffsetOutOfBounds { offset: end })?;
  full_text
    .get(start_usize..end_usize)
    .ok_or(Error::InvalidSpan { start, end })
}

fn usize_to_u32(field: &'static str, value: usize) -> Result<u32> {
  u32::try_from(value).map_err(|_| Error::InvalidStaticData {
    field,
    reason: "span offset exceeds u32 range".to_owned(),
  })
}

#[cfg(test)]
mod tests {
  use super::{
    BARE_HOUSE_CONTEXT_WINDOW, EntityProximityIndex,
    HEADER_SCAN_MAX_LINE_EXTENSION_UTF16_UNITS, HEADER_ZONE_MAX_UTF16_UNITS,
    STREET_CONTEXT_WINDOW, header_end, header_scan_end, within_context_window,
  };
  use crate::byte_offsets::ByteOffsets;
  use crate::resolution::{DetectionSource, PipelineEntity};

  #[test]
  fn header_zone_has_an_absolute_size_limit() {
    let text = "x".repeat(1024 * 1024);

    assert_eq!(header_end(&text), HEADER_ZONE_MAX_UTF16_UNITS);
  }

  #[test]
  fn header_zone_has_a_line_limit() {
    let lines = "x\n".repeat(250);
    let text = format!("{lines}{}", "x".repeat(100_000));

    assert_eq!(header_end(&text), 400);
  }

  #[test]
  fn header_scan_stays_bounded_without_newlines() {
    let text = "x".repeat(1024 * 1024);
    let offsets = ByteOffsets::new(&text);
    let header_end = header_end(&text);

    assert_eq!(
      header_scan_end(&text, &offsets, header_end).unwrap(),
      usize::try_from(
        header_end.saturating_add(HEADER_SCAN_MAX_LINE_EXTENSION_UTF16_UNITS,),
      )
      .unwrap(),
    );
  }

  #[test]
  fn proximity_index_matches_linear_utf16_distance_checks() {
    let text = format!(
      "{}Alice at Praha 10 {} Bob at Brno {} Charlie",
      "á".repeat(240),
      "😀".repeat(120),
      "č".repeat(240),
    );
    let entities = ["Alice", "Praha 10", "Bob", "Brno", "Charlie"]
      .into_iter()
      .map(|needle| entity_at(&text, needle))
      .collect::<Vec<_>>();
    let index = EntityProximityIndex::addresses(entities.iter());
    let offsets = ByteOffsets::new(&text);

    for needle in ["Alice", "Praha 10", "Bob", "Brno", "Charlie"] {
      let start = u32::try_from(text.find(needle).unwrap_or(0)).unwrap_or(0);
      let end = start.saturating_add(u32::try_from(needle.len()).unwrap_or(0));
      for window in [BARE_HOUSE_CONTEXT_WINDOW, STREET_CONTEXT_WINDOW] {
        let expected = entities.iter().any(|entity| {
          within_context_window(&offsets, entity, start, end, window)
        });
        assert_eq!(
          index.is_within_context_window(&offsets, start, end, window),
          expected,
        );
      }
    }
  }

  #[test]
  fn proximity_index_limits_candidate_visits() {
    let entities = (0..10_000_u32)
      .map(|index| {
        let start = index.saturating_mul(1_000);
        PipelineEntity::detected(
          start,
          start.saturating_add(20),
          "address",
          "Synthetic address",
          1.0,
          DetectionSource::Regex,
        )
      })
      .collect::<Vec<_>>();
    let index = EntityProximityIndex::addresses(entities.iter());

    assert!(
      index
        .nearby(5_000_000, 5_000_020, STREET_CONTEXT_WINDOW)
        .count()
        <= 3,
    );
  }

  fn entity_at(text: &str, needle: &str) -> PipelineEntity {
    let start = u32::try_from(text.find(needle).unwrap_or(0)).unwrap_or(0);
    let end = start.saturating_add(u32::try_from(needle.len()).unwrap_or(0));
    PipelineEntity::detected(
      start,
      end,
      "address",
      needle,
      1.0,
      DetectionSource::Regex,
    )
  }
}
