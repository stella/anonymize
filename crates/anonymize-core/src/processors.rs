use crate::resolution::{DetectionSource, PipelineEntity, SourceDetail};
use crate::types::{Error, Result, SearchMatch};
use crate::utf16::Utf16Offsets;

const MIN_PHONE_LENGTH: usize = 7;
const GAZETTEER_EXACT_SCORE: f64 = 0.9;
const GAZETTEER_FUZZY_SCORE: f64 = 0.85;
const COUNTRY_SCORE: f64 = 0.95;
const MAX_GAZETTEER_PREFIX_OVERSHOOT: u32 = 7;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PatternSlice {
  pub start: u32,
  pub end: u32,
}

impl PatternSlice {
  #[must_use]
  pub const fn contains(self, pattern: u32) -> bool {
    pattern >= self.start && pattern < self.end
  }

  fn local_index(self, pattern: u32) -> Option<usize> {
    if !self.contains(pattern) {
      return None;
    }
    usize::try_from(pattern.saturating_sub(self.start)).ok()
  }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RegexMatchMeta {
  pub label: String,
  pub score: f64,
  pub source_detail: Option<SourceDetail>,
  pub requires_validation: bool,
}

impl RegexMatchMeta {
  #[must_use]
  pub fn new(label: impl Into<String>, score: f64) -> Self {
    Self {
      label: label.into(),
      score,
      source_detail: None,
      requires_validation: false,
    }
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GazetteerMatchData {
  pub labels: Vec<String>,
  pub is_fuzzy: Vec<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CountryMatchData {
  pub labels: Vec<String>,
}

pub fn process_regex_matches(
  matches: &[SearchMatch],
  slice: PatternSlice,
  full_text: &str,
  meta: &[RegexMatchMeta],
) -> Result<Vec<PipelineEntity>> {
  let offsets = Utf16Offsets::new(full_text);
  let mut results = Vec::new();

  for found in matches {
    let pattern = found.pattern();
    let Some(local_index) = slice.local_index(pattern) else {
      continue;
    };
    let Some(entry) = meta.get(local_index) else {
      continue;
    };
    if entry.requires_validation {
      return Err(Error::UnsupportedRegexValidation { pattern });
    }

    let text = offsets.slice(full_text, found.start(), found.end())?;
    if entry.source_detail != Some(SourceDetail::CustomRegex)
      && entry.label == "phone number"
      && text.encode_utf16().count() < MIN_PHONE_LENGTH
    {
      continue;
    }

    let mut entity = PipelineEntity::detected(
      found.start(),
      found.end(),
      entry.label.clone(),
      text,
      entry.score,
      DetectionSource::Regex,
    );
    entity.source_detail = entry.source_detail;
    results.push(entity);
  }

  Ok(results)
}

pub fn process_gazetteer_matches(
  matches: &[SearchMatch],
  slice: PatternSlice,
  full_text: &str,
  data: &GazetteerMatchData,
) -> Result<Vec<PipelineEntity>> {
  let offsets = Utf16Offsets::new(full_text);
  let mut results = Vec::new();
  let mut exact_spans = Vec::<(u32, u32)>::new();

  for found in matches {
    let Some(local_index) = slice.local_index(found.pattern()) else {
      continue;
    };
    if data.is_fuzzy.get(local_index).copied().unwrap_or(false) {
      continue;
    }

    let Some(label) = data.labels.get(local_index) else {
      continue;
    };
    let extended = try_gazetteer_prefix_extension(full_text, &offsets, found)?;
    let (end, text, source_detail) = if let Some(extension) = extended {
      extension
    } else {
      (
        found.end(),
        offsets.slice(full_text, found.start(), found.end())?,
        None,
      )
    };

    exact_spans.push((found.start(), end));
    let mut entity = PipelineEntity::detected(
      found.start(),
      end,
      label.clone(),
      text,
      GAZETTEER_EXACT_SCORE,
      DetectionSource::Gazetteer,
    );
    entity.source_detail = source_detail;
    results.push(entity);
  }

  for found in matches {
    let Some(local_index) = slice.local_index(found.pattern()) else {
      continue;
    };
    if !data.is_fuzzy.get(local_index).copied().unwrap_or(false) {
      continue;
    }
    if fuzzy_distance(found) == Some(0) {
      continue;
    }

    let Some(label) = data.labels.get(local_index) else {
      continue;
    };
    if exact_spans
      .iter()
      .any(|(start, end)| found.start() < *end && found.end() > *start)
    {
      continue;
    }

    results.push(PipelineEntity::detected(
      found.start(),
      found.end(),
      label.clone(),
      offsets.slice(full_text, found.start(), found.end())?,
      GAZETTEER_FUZZY_SCORE,
      DetectionSource::Gazetteer,
    ));
  }

  Ok(results)
}

pub fn process_country_matches(
  matches: &[SearchMatch],
  slice: PatternSlice,
  full_text: &str,
  data: &CountryMatchData,
) -> Result<Vec<PipelineEntity>> {
  let offsets = Utf16Offsets::new(full_text);
  let mut results = Vec::new();

  for found in matches {
    let Some(local_index) = slice.local_index(found.pattern()) else {
      continue;
    };
    let Some(label) = data.labels.get(local_index) else {
      continue;
    };
    if !starts_as_proper_noun(full_text, &offsets, found.start())? {
      continue;
    }

    results.push(PipelineEntity::detected(
      found.start(),
      found.end(),
      label.clone(),
      offsets.slice(full_text, found.start(), found.end())?,
      COUNTRY_SCORE,
      DetectionSource::Country,
    ));
  }

  Ok(results)
}

fn try_gazetteer_prefix_extension(
  full_text: &str,
  offsets: &Utf16Offsets,
  found: &SearchMatch,
) -> Result<Option<(u32, String, Option<SourceDetail>)>> {
  let full_len = offsets.len()?;
  let max_end = found
    .end()
    .saturating_add(MAX_GAZETTEER_PREFIX_OVERSHOOT)
    .min(full_len);
  if max_end <= found.end().saturating_add(1) {
    return Ok(None);
  }

  let after = offsets.slice(full_text, found.end(), max_end)?;
  if !after.starts_with(' ') {
    return Ok(None);
  }

  let suffix_end = next_space_offset_after_initial(&after);
  if suffix_end <= 1 {
    return Ok(None);
  }

  let new_end = found.end().saturating_add(suffix_end);
  Ok(Some((
    new_end,
    offsets.slice(full_text, found.start(), new_end)?,
    Some(SourceDetail::GazetteerExtension),
  )))
}

fn next_space_offset_after_initial(text: &str) -> u32 {
  let mut offset = 0_u32;

  for ch in text.chars() {
    let width = u32::try_from(ch.len_utf16()).unwrap_or(u32::MAX);
    if offset > 0 && ch == ' ' {
      return offset;
    }
    offset = offset.saturating_add(width);
  }

  offset
}

fn starts_as_proper_noun(
  full_text: &str,
  offsets: &Utf16Offsets,
  start: u32,
) -> Result<bool> {
  let start_byte = offsets.validate_offset(start)?;
  let Some(ch) = full_text
    .get(start_byte..)
    .and_then(|tail| tail.chars().next())
  else {
    return Ok(false);
  };

  let upper = ch.to_uppercase().to_string();
  let lower = ch.to_lowercase().to_string();
  if upper == lower {
    return Ok(true);
  }

  Ok(ch.to_string() == upper)
}

const fn fuzzy_distance(found: &SearchMatch) -> Option<u32> {
  let SearchMatch::Fuzzy { distance, .. } = found else {
    return None;
  };
  Some(*distance)
}
