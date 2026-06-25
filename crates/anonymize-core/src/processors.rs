use std::collections::{BTreeMap, BTreeSet};

use crate::byte_offsets::ByteOffsets;
use crate::resolution::{DetectionSource, PipelineEntity, SourceDetail};
use crate::types::{Error, Result, SearchMatch};
use crate::validators::validate_id;

const GAZETTEER_EXACT_SCORE: f64 = 0.9;
const GAZETTEER_FUZZY_SCORE: f64 = 0.85;
const COUNTRY_SCORE: f64 = 0.95;
const DENY_LIST_SCORE: f64 = 0.9;
const MAX_GAZETTEER_PREFIX_OVERSHOOT: u32 = 7;
pub(crate) const CUSTOM_DENY_LIST_SOURCE: &str = "custom-deny-list";
const DENY_LIST_SOURCE: &str = "deny-list";
const CITY_SOURCE: &str = "city";
const FIRST_NAME_SOURCE: &str = "first-name";
const SURNAME_SOURCE: &str = "surname";
const TITLE_SOURCE: &str = "title";
const PERSON_LABEL: &str = "person";
const ADDRESS_LABEL: &str = "address";

#[derive(
  Clone,
  Copy,
  Debug,
  Default,
  Eq,
  PartialEq,
  serde::Deserialize,
  serde::Serialize,
)]
pub struct PatternSlice {
  pub start: u32,
  pub end: u32,
}

impl PatternSlice {
  #[must_use]
  pub const fn is_empty(self) -> bool {
    self.start >= self.end
  }

  #[must_use]
  pub const fn len(self) -> u32 {
    self.end.saturating_sub(self.start)
  }

  #[must_use]
  pub const fn contains(self, pattern: u32) -> bool {
    pattern >= self.start && pattern < self.end
  }

  pub(crate) fn local_index(self, pattern: u32) -> Option<usize> {
    if !self.contains(pattern) {
      return None;
    }
    usize::try_from(pattern.saturating_sub(self.start)).ok()
  }
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct RegexMatchMeta {
  pub label: String,
  pub score: f64,
  pub source_detail: Option<SourceDetail>,
  pub requires_validation: bool,
  pub validator_id: Option<String>,
  pub validator_input: Option<String>,
  pub min_byte_length: Option<u32>,
}

impl RegexMatchMeta {
  #[must_use]
  pub fn new(label: impl Into<String>, score: f64) -> Self {
    Self {
      label: label.into(),
      score,
      source_detail: None,
      requires_validation: false,
      validator_id: None,
      validator_input: None,
      min_byte_length: None,
    }
  }
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct GazetteerMatchData {
  pub labels: Vec<String>,
  pub is_fuzzy: Vec<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct CountryMatchData {
  pub labels: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct DenyListMatchData {
  pub labels: StringGroups,
  pub custom_labels: StringGroups,
  pub originals: Vec<String>,
  pub sources: StringGroups,
  pub filters: Option<DenyListFilterData>,
}

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct StringGroups {
  table: Vec<String>,
  groups: Vec<Vec<u32>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StringGroup<'a> {
  table: &'a [String],
  indexes: &'a [u32],
}

impl StringGroups {
  #[must_use]
  pub fn from_groups(groups: Vec<Vec<String>>) -> Self {
    let mut table = Vec::new();
    let mut table_indexes = BTreeMap::<String, u32>::new();
    let groups = groups
      .into_iter()
      .map(|group| {
        group
          .into_iter()
          .map(|value| {
            string_table_index(value, &mut table, &mut table_indexes)
          })
          .collect()
      })
      .collect();

    Self { table, groups }
  }

  pub fn from_table_indices(
    table: Vec<String>,
    groups: Vec<Vec<u32>>,
    field: &'static str,
  ) -> Result<Self> {
    for group in &groups {
      for &index in group {
        let Ok(index) = usize::try_from(index) else {
          return Err(Error::InvalidStaticData {
            field,
            reason: String::from("string table index exceeds usize range"),
          });
        };
        if index >= table.len() {
          return Err(Error::InvalidStaticData {
            field,
            reason: String::from("string table index out of range"),
          });
        }
      }
    }

    Ok(Self { table, groups })
  }

  #[must_use]
  pub fn empty_groups(len: usize) -> Self {
    Self {
      table: Vec::new(),
      groups: vec![Vec::new(); len],
    }
  }

  #[must_use]
  pub const fn len(&self) -> usize {
    self.groups.len()
  }

  #[must_use]
  pub const fn is_empty(&self) -> bool {
    self.groups.is_empty()
  }

  #[must_use]
  pub fn get(&self, index: usize) -> Option<StringGroup<'_>> {
    Some(StringGroup {
      table: &self.table,
      indexes: self.groups.get(index)?,
    })
  }

  pub fn iter(&self) -> impl Iterator<Item = StringGroup<'_>> {
    self.groups.iter().map(|indexes| StringGroup {
      table: &self.table,
      indexes,
    })
  }
}

impl From<Vec<Vec<String>>> for StringGroups {
  fn from(groups: Vec<Vec<String>>) -> Self {
    Self::from_groups(groups)
  }
}

impl<'a> StringGroup<'a> {
  #[must_use]
  pub const fn is_empty(self) -> bool {
    self.indexes.is_empty()
  }

  pub fn iter(self) -> impl Iterator<Item = &'a str> + 'a {
    self
      .indexes
      .iter()
      .filter_map(|index| usize::try_from(*index).ok())
      .filter_map(|index| self.table.get(index))
      .map(String::as_str)
  }

  #[must_use]
  pub fn contains(self, value: &str) -> bool {
    self.iter().any(|entry| entry == value)
  }

  #[must_use]
  pub fn to_strings(self) -> Vec<String> {
    self.iter().map(String::from).collect()
  }
}

fn string_table_index(
  value: String,
  table: &mut Vec<String>,
  table_indexes: &mut BTreeMap<String, u32>,
) -> u32 {
  if let Some(index) = table_indexes.get(&value) {
    return *index;
  }
  let index = u32::try_from(table.len()).unwrap_or(u32::MAX);
  table_indexes.insert(value.clone(), index);
  table.push(value);
  index
}

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct DenyListFilterData {
  pub stopwords: BTreeSet<String>,
  pub allow_list: BTreeSet<String>,
  pub person_stopwords: BTreeSet<String>,
  pub person_trailing_nouns: BTreeSet<String>,
  pub address_stopwords: BTreeSet<String>,
  pub address_jurisdiction_prefixes: BTreeSet<String>,
  pub street_types: BTreeSet<String>,
  pub first_names: BTreeSet<String>,
  pub generic_roles: BTreeSet<String>,
  pub sentence_starters: BTreeSet<String>,
  pub trailing_address_word_exclusions: BTreeSet<String>,
  pub defined_term_cues: BTreeSet<String>,
  pub signing_place_guards: Vec<SigningPlaceGuardData>,
}

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct SigningPlaceGuardData {
  pub prefix_phrases: BTreeSet<String>,
  pub suffix_phrases: BTreeSet<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RawDenyListMatch {
  start: u32,
  end: u32,
  labels: Vec<String>,
  custom_labels: Vec<String>,
  sources: Vec<String>,
  text: String,
}

pub fn process_regex_matches(
  matches: &[SearchMatch],
  slice: PatternSlice,
  full_text: &str,
  meta: &[RegexMatchMeta],
) -> Result<Vec<PipelineEntity>> {
  let offsets = ByteOffsets::new(full_text);
  let mut results = Vec::new();

  for found in matches {
    let pattern = found.pattern();
    let Some(local_index) = slice.local_index(pattern) else {
      continue;
    };
    let Some(entry) = meta.get(local_index) else {
      continue;
    };
    let text = offsets.slice(full_text, found.start(), found.end())?;
    if let Some(validator_id) = &entry.validator_id {
      if !validate_id(validator_id, &text, entry.validator_input.as_deref()) {
        continue;
      }
    } else if entry.requires_validation {
      return Err(Error::UnsupportedRegexValidation { pattern });
    }
    if entry
      .min_byte_length
      .is_some_and(|min| byte_len(&text) < min)
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

pub fn process_deny_list_matches(
  matches: &[SearchMatch],
  slice: PatternSlice,
  full_text: &str,
  data: &DenyListMatchData,
) -> Result<Vec<PipelineEntity>> {
  let offsets = ByteOffsets::new(full_text);
  let matches_by_pattern =
    collect_deny_list_matches(matches, slice, full_text, data, &offsets)?;

  let mut results = Vec::new();
  let mut name_hits = Vec::new();

  for pattern_matches in matches_by_pattern.values() {
    for found in pattern_matches {
      for label in &found.custom_labels {
        let mut entity = PipelineEntity::detected(
          found.start,
          found.end,
          label.clone(),
          found.text.clone(),
          DENY_LIST_SCORE,
          DetectionSource::DenyList,
        );
        entity.source_detail = Some(SourceDetail::CustomDenyList);
        results.push(entity);
      }
    }

    for found in pattern_matches {
      if found.labels.iter().any(|label| label == PERSON_LABEL)
        && !filter_contains(
          data
            .filters
            .as_ref()
            .map(|filters| &filters.person_stopwords),
          &found.text.to_lowercase(),
        )
      {
        name_hits.push(found.clone());
      }

      let suppress_address = should_suppress_address(full_text, data, found)?;
      for label in found.labels.iter().filter(|label| *label != PERSON_LABEL) {
        if label == ADDRESS_LABEL && suppress_address {
          continue;
        }
        results.push(PipelineEntity::detected(
          found.start,
          found.end,
          label.clone(),
          found.text.clone(),
          DENY_LIST_SCORE,
          DetectionSource::DenyList,
        ));
      }
    }
  }

  append_person_name_hits(
    &mut results,
    full_text,
    &offsets,
    data,
    &mut name_hits,
  )?;
  extend_city_districts(
    &mut results,
    full_text,
    &offsets,
    data.filters.as_ref(),
  )?;

  Ok(results)
}

fn collect_deny_list_matches(
  matches: &[SearchMatch],
  slice: PatternSlice,
  full_text: &str,
  data: &DenyListMatchData,
  offsets: &ByteOffsets<'_>,
) -> Result<BTreeMap<usize, Vec<RawDenyListMatch>>> {
  let mut matches_by_pattern = BTreeMap::<usize, Vec<RawDenyListMatch>>::new();

  for found in matches {
    let Some(local_index) = slice.local_index(found.pattern()) else {
      continue;
    };
    let Some(labels) = data.labels.get(local_index) else {
      continue;
    };
    let Some(sources) = data.sources.get(local_index) else {
      continue;
    };
    validate_deny_list_sources(sources)?;

    let match_text = offsets.slice(full_text, found.start(), found.end())?;
    let keyword = match_text.to_lowercase();
    let pattern = data.originals.get(local_index).map_or("", String::as_str);
    let custom_pattern_labels = data
      .custom_labels
      .get(local_index)
      .map(StringGroup::to_strings)
      .unwrap_or_default();
    let custom_edges_are_valid = custom_match_has_valid_edges(
      full_text,
      offsets,
      found.start(),
      found.end(),
      pattern,
    )?;
    let custom_labels = if custom_edges_are_valid {
      custom_pattern_labels.clone()
    } else {
      Vec::new()
    };

    if labels.is_empty() && custom_labels.is_empty() {
      continue;
    }

    let curated_labels = if has_curated_source(sources) {
      let filters = data.filters.as_ref().ok_or(Error::MissingStaticData {
        field: "deny_list.filters",
      })?;
      curated_labels_for_match(&CuratedDenyListMatch {
        full_text,
        offsets,
        start: found.start(),
        match_text: &match_text,
        keyword: &keyword,
        pattern,
        labels,
        custom_pattern_labels: &custom_pattern_labels,
        custom_edges_are_valid,
        filters,
      })?
    } else {
      Vec::new()
    };

    if curated_labels.is_empty() && custom_labels.is_empty() {
      continue;
    }

    matches_by_pattern
      .entry(local_index)
      .or_default()
      .push(RawDenyListMatch {
        start: found.start(),
        end: found.end(),
        labels: curated_labels,
        custom_labels,
        sources: sources.to_strings(),
        text: match_text,
      });
  }

  Ok(matches_by_pattern)
}

struct CuratedDenyListMatch<'a> {
  full_text: &'a str,
  offsets: &'a ByteOffsets<'a>,
  start: u32,
  match_text: &'a str,
  keyword: &'a str,
  pattern: &'a str,
  labels: StringGroup<'a>,
  custom_pattern_labels: &'a [String],
  custom_edges_are_valid: bool,
  filters: &'a DenyListFilterData,
}

fn curated_labels_for_match(
  args: &CuratedDenyListMatch<'_>,
) -> Result<Vec<String>> {
  let pattern_is_acronym = !args.pattern.is_empty()
    && args.pattern.len() <= 5
    && all_upper(args.pattern);
  let acronym_matches_acronym =
    !pattern_is_acronym || all_upper(args.match_text);
  let source_char = char_at(args.full_text, args.offsets, args.start)?;
  let passes_filters = source_char.is_some_and(char::is_uppercase)
    && !args.filters.stopwords.contains(args.keyword)
    && !args.filters.allow_list.contains(args.keyword)
    && acronym_matches_acronym
    && !all_upper(args.match_text);

  if !passes_filters || !args.custom_edges_are_valid {
    return Ok(Vec::new());
  }

  if is_dotted_acronym_suffix_collision(
    args.full_text,
    args.offsets,
    args.start,
    args.match_text,
  )? {
    return Ok(Vec::new());
  }

  Ok(
    args
      .labels
      .iter()
      .filter(|label| {
        !args
          .custom_pattern_labels
          .iter()
          .any(|custom| custom == label)
      })
      .map(String::from)
      .collect(),
  )
}

fn should_suppress_address(
  full_text: &str,
  data: &DenyListMatchData,
  found: &RawDenyListMatch,
) -> Result<bool> {
  if !is_single_word(found.text.as_str()) {
    return Ok(false);
  }
  let Some(filters) = &data.filters else {
    return Ok(false);
  };
  if is_signing_place_context(full_text, found.start, found.end, filters)? {
    return Ok(true);
  }
  let lower = found.text.to_lowercase();
  if !filters.address_stopwords.contains(&lower) {
    return Ok(false);
  }

  Ok(!has_adjacent_address_evidence(
    full_text,
    found.start,
    found.end,
    filters,
  )?)
}

fn is_signing_place_context(
  full_text: &str,
  start: u32,
  end: u32,
  filters: &DenyListFilterData,
) -> Result<bool> {
  if filters.signing_place_guards.is_empty() {
    return Ok(false);
  }

  let offsets = ByteOffsets::new(full_text);
  let start_byte = offsets.validate_offset(start)?;
  let end_byte = offsets.validate_offset(end)?;
  let before = full_text.get(..start_byte).unwrap_or_default();
  let after = full_text.get(end_byte..).unwrap_or_default();

  Ok(filters.signing_place_guards.iter().any(|guard| {
    !guard.prefix_phrases.is_empty()
      && !guard.suffix_phrases.is_empty()
      && context_before_matches_any_phrase(before, &guard.prefix_phrases)
      && context_after_matches_any_phrase(after, &guard.suffix_phrases)
  }))
}

fn context_before_matches_any_phrase(
  before: &str,
  phrases: &BTreeSet<String>,
) -> bool {
  phrases.iter().any(|phrase| {
    phrase.is_empty() || context_before_matches_phrase(before, phrase)
  })
}

fn context_after_matches_any_phrase(
  after: &str,
  phrases: &BTreeSet<String>,
) -> bool {
  phrases.iter().any(|phrase| {
    phrase.is_empty() || context_after_matches_phrase(after, phrase)
  })
}

fn context_before_matches_phrase(before: &str, phrase: &str) -> bool {
  let trimmed = before.trim_end_matches(char::is_whitespace);
  if trimmed.len() < phrase.len() {
    return false;
  }
  let lower = trimmed.to_lowercase();
  if !lower.ends_with(phrase) {
    return false;
  }
  let phrase_start = trimmed.len().saturating_sub(phrase.len());
  char_before_byte(trimmed, phrase_start).is_none_or(|ch| !ch.is_alphanumeric())
}

fn context_after_matches_phrase(after: &str, phrase: &str) -> bool {
  let trimmed = after.trim_start_matches(char::is_whitespace);
  let trimmed = trimmed.strip_prefix(',').map_or(trimmed, |value| {
    value.trim_start_matches(char::is_whitespace)
  });
  if trimmed.len() < phrase.len() {
    return false;
  }
  let lower = trimmed.to_lowercase();
  if !lower.starts_with(phrase) {
    return false;
  }
  char_after_byte(trimmed, phrase.len()).is_none_or(|ch| !ch.is_alphanumeric())
}

fn append_person_name_hits(
  results: &mut Vec<PipelineEntity>,
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  data: &DenyListMatchData,
  name_hits: &mut [RawDenyListMatch],
) -> Result<()> {
  name_hits.sort_by_key(|hit| hit.start);
  let mut consumed = BTreeSet::<usize>::new();

  for index in 0..name_hits.len() {
    if consumed.contains(&index) {
      continue;
    }
    let Some(hit) = name_hits.get(index) else {
      continue;
    };

    let mut chain = vec![hit.clone()];
    let mut cursor = index.saturating_add(1);

    while cursor < name_hits.len() && chain.len() < 5 {
      let Some(next) = name_hits.get(cursor) else {
        break;
      };
      let Some(prev) = chain.last() else {
        break;
      };
      let gap = offsets.slice(full_text, prev.end, next.start)?;
      if person_chain_breaks(prev.text.as_str(), gap.as_str()) {
        break;
      }

      chain.push(next.clone());
      cursor = cursor.saturating_add(1);
    }

    for consumed_index in index..index.saturating_add(chain.len()) {
      consumed.insert(consumed_index);
    }

    if !chain.iter().any(has_person_name_source) {
      continue;
    }

    let Some(first) = chain.first() else {
      continue;
    };
    let Some(last) = chain.last() else {
      continue;
    };
    let Some(filters) = &data.filters else {
      continue;
    };
    if is_suppressible_defined_term_quote(
      full_text,
      offsets,
      first.start,
      filters,
    )? {
      continue;
    }

    let extended =
      extend_person_name(full_text, offsets, first.start, last.end, filters)?;
    let score = if chain.len() >= 2 { 0.9 } else { 0.5 };

    if chain.len() == 1
      && !single_name_hit_has_context(full_text, offsets, last.end, filters)?
    {
      continue;
    }

    results.push(PipelineEntity::detected(
      first.start,
      extended.end,
      PERSON_LABEL,
      extended.text,
      score,
      DetectionSource::DenyList,
    ));
  }

  Ok(())
}

pub fn process_gazetteer_matches(
  matches: &[SearchMatch],
  slice: PatternSlice,
  full_text: &str,
  data: &GazetteerMatchData,
) -> Result<Vec<PipelineEntity>> {
  let offsets = ByteOffsets::new(full_text);
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
  let offsets = ByteOffsets::new(full_text);
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

pub(crate) fn ensure_supported_deny_list_sources(
  data: &DenyListMatchData,
) -> Result<()> {
  let mut needs_filters = false;
  for sources in data.sources.iter() {
    validate_deny_list_sources(sources)?;
    needs_filters |= has_curated_source(sources);
  }

  if needs_filters && data.filters.is_none() {
    return Err(Error::MissingStaticData {
      field: "deny_list.filters",
    });
  }

  Ok(())
}

fn validate_deny_list_sources(sources: StringGroup<'_>) -> Result<()> {
  if sources.is_empty() {
    return Err(Error::UnsupportedDenyListSource {
      source: String::from("<missing>"),
    });
  }

  for source in sources.iter() {
    match source {
      DENY_LIST_SOURCE
      | CITY_SOURCE
      | CUSTOM_DENY_LIST_SOURCE
      | FIRST_NAME_SOURCE
      | SURNAME_SOURCE
      | TITLE_SOURCE => {}
      _ => {
        return Err(Error::UnsupportedDenyListSource {
          source: String::from(source),
        });
      }
    }
  }

  Ok(())
}

fn has_curated_source(sources: StringGroup<'_>) -> bool {
  sources
    .iter()
    .any(|source| source != CUSTOM_DENY_LIST_SOURCE)
}

fn has_person_name_source(found: &RawDenyListMatch) -> bool {
  found
    .sources
    .iter()
    .any(|source| source == FIRST_NAME_SOURCE || source == SURNAME_SOURCE)
}

fn filter_contains(set: Option<&BTreeSet<String>>, value: &str) -> bool {
  set.is_some_and(|set| set.contains(value))
}

fn char_at(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  offset: u32,
) -> Result<Option<char>> {
  let byte = offsets.validate_offset(offset)?;
  Ok(full_text.get(byte..).and_then(|tail| tail.chars().next()))
}

fn char_before_byte(full_text: &str, byte: usize) -> Option<char> {
  full_text
    .get(..byte)
    .and_then(|prefix| prefix.chars().next_back())
}

fn char_after_byte(full_text: &str, byte: usize) -> Option<char> {
  full_text
    .get(byte..)
    .and_then(|suffix| suffix.chars().next())
}

fn byte_len(text: &str) -> u32 {
  u32::try_from(text.len()).unwrap_or(u32::MAX)
}

fn all_upper(text: &str) -> bool {
  let mut saw_letter = false;
  for ch in text.chars() {
    if !ch.is_alphabetic() || !ch.is_uppercase() {
      return false;
    }
    saw_letter = true;
  }
  saw_letter
}

fn is_single_word(text: &str) -> bool {
  let mut saw_letter = false;
  for ch in text.chars() {
    if !ch.is_alphabetic() {
      return false;
    }
    saw_letter = true;
  }
  saw_letter
}

fn is_dotted_acronym(text: &str) -> bool {
  if text.chars().count() < 3 {
    return false;
  }

  let mut segments = 0_u8;
  let mut chars = text.chars().peekable();
  while let Some(ch) = chars.next() {
    if !ch.is_alphabetic() {
      return false;
    }
    segments = segments.saturating_add(1);
    if segments > 4 {
      return false;
    }
    match chars.peek().copied() {
      Some('.') => {
        let _ = chars.next();
        if chars.peek().is_none() {
          break;
        }
      }
      None => break,
      Some(_) => return false,
    }
  }

  segments > 0
}

fn is_dotted_acronym_suffix_collision(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  match_text: &str,
) -> Result<bool> {
  if !is_dotted_acronym(match_text) {
    return Ok(false);
  }

  let start_byte = offsets.validate_offset(start)?;
  let prefix = full_text
    .get(..start_byte)
    .unwrap_or_default()
    .chars()
    .rev()
    .take(2)
    .collect::<Vec<_>>();

  Ok(matches!(
    (prefix.first().copied(), prefix.get(1).copied()),
    (Some('.'), Some(ch)) if ch.is_alphabetic()
  ))
}

fn has_adjacent_address_evidence(
  full_text: &str,
  start: u32,
  end: u32,
  filters: &DenyListFilterData,
) -> Result<bool> {
  let offsets = ByteOffsets::new(full_text);
  let full_len = offsets.len()?;
  let window_start = offsets.floor_offset(start.saturating_sub(40))?;
  let window_end =
    offsets.floor_offset(end.saturating_add(40).min(full_len))?;
  let window = offsets.slice(full_text, window_start, window_end)?;

  Ok(has_address_format(&window) || has_street_type(&window, filters))
}

fn has_address_format(text: &str) -> bool {
  has_state_after_comma(text)
    || has_us_zip(text)
    || has_cz_sk_postal_code(text)
    || has_pl_postal_code(text)
}

fn has_state_after_comma(text: &str) -> bool {
  let chars = text.chars().collect::<Vec<_>>();
  for index in 0..chars.len() {
    if chars.get(index) != Some(&',') {
      continue;
    }
    let mut cursor = index.saturating_add(1);
    while chars.get(cursor).is_some_and(|ch| ch.is_whitespace()) {
      cursor = cursor.saturating_add(1);
    }
    let first = chars.get(cursor).copied();
    let second = chars.get(cursor.saturating_add(1)).copied();
    let after = chars.get(cursor.saturating_add(2)).copied();
    if first.is_some_and(char::is_uppercase)
      && second.is_some_and(char::is_uppercase)
      && !after.is_some_and(char::is_alphanumeric)
    {
      return true;
    }
  }
  false
}

fn has_us_zip(text: &str) -> bool {
  let chars = text.chars().collect::<Vec<_>>();
  for index in 0..chars.len() {
    if !five_digits_at(&chars, index) {
      continue;
    }
    let after_five = index.saturating_add(5);
    let has_zip4 = chars.get(after_five) == Some(&'-')
      && four_digits_at(&chars, after_five.saturating_add(1));
    let end = if has_zip4 {
      after_five.saturating_add(5)
    } else {
      after_five
    };
    if !chars
      .get(index.wrapping_sub(1))
      .is_some_and(char::is_ascii_digit)
      && !chars.get(end).is_some_and(char::is_ascii_digit)
    {
      return true;
    }
  }
  false
}

fn has_cz_sk_postal_code(text: &str) -> bool {
  let chars = text.chars().collect::<Vec<_>>();
  for index in 0..chars.len() {
    if three_digits_at(&chars, index)
      && chars.get(index.saturating_add(3)) == Some(&' ')
      && two_digits_at(&chars, index.saturating_add(4))
    {
      return true;
    }
  }
  false
}

fn has_pl_postal_code(text: &str) -> bool {
  let chars = text.chars().collect::<Vec<_>>();
  for index in 0..chars.len() {
    if two_digits_at(&chars, index)
      && chars.get(index.saturating_add(2)) == Some(&'-')
      && three_digits_at(&chars, index.saturating_add(3))
    {
      return true;
    }
  }
  false
}

fn digits_at(chars: &[char], start: usize, len: usize) -> bool {
  start.checked_add(len).is_some_and(|end| end <= chars.len())
    && chars
      .get(start..start.saturating_add(len))
      .is_some_and(|slice| slice.iter().all(char::is_ascii_digit))
}

fn two_digits_at(chars: &[char], start: usize) -> bool {
  digits_at(chars, start, 2)
}

fn three_digits_at(chars: &[char], start: usize) -> bool {
  digits_at(chars, start, 3)
}

fn four_digits_at(chars: &[char], start: usize) -> bool {
  digits_at(chars, start, 4)
}

fn five_digits_at(chars: &[char], start: usize) -> bool {
  digits_at(chars, start, 5)
}

fn has_street_type(window: &str, filters: &DenyListFilterData) -> bool {
  let lower_window = window.to_lowercase();
  for street_type in &filters.street_types {
    if street_type.is_empty() {
      continue;
    }
    let lower_type = street_type.to_lowercase();
    if street_type_matches(lower_window.as_str(), lower_type.as_str()) {
      return true;
    }
  }
  false
}

fn street_type_matches(window: &str, street_type: &str) -> bool {
  for (byte, _) in window.match_indices(street_type) {
    let before = char_before_byte(window, byte);
    if before.is_some_and(char::is_alphanumeric) {
      continue;
    }
    let end = byte.saturating_add(street_type.len());
    let Some(last) = street_type.chars().next_back() else {
      continue;
    };
    if last.is_alphanumeric()
      && char_after_byte(window, end).is_some_and(char::is_alphanumeric)
    {
      continue;
    }
    return true;
  }
  false
}

fn person_chain_breaks(previous_text: &str, gap: &str) -> bool {
  byte_len(gap) > 4
    || gap.is_empty()
    || gap.contains('\n')
    || gap.contains('\t')
    || gap
      .chars()
      .any(|ch| matches!(ch, '!' | '?' | ';' | ':' | ','))
    || (gap.contains('.') && !is_initial_continuation_gap(previous_text, gap))
}

fn is_initial_continuation_gap(text: &str, gap: &str) -> bool {
  let mut chars = text.chars();
  let text_is_single_upper =
    chars.next().is_some_and(char::is_uppercase) && chars.next().is_none();
  if text_is_single_upper && dot_space_gap(gap) {
    return true;
  }

  let mut remaining = gap;
  let Some(after_space) = consume_horizontal_space(remaining, 1, 2) else {
    return false;
  };
  remaining = after_space;
  let mut consumed_initial = false;

  loop {
    let Some(ch) = remaining.chars().next() else {
      return consumed_initial;
    };
    if !ch.is_uppercase() {
      return false;
    }
    let Some(after_initial) = remaining.strip_prefix(ch) else {
      return false;
    };
    let Some(after_dot) = after_initial.strip_prefix('.') else {
      return false;
    };
    let Some(after_initial_gap) = consume_horizontal_space(after_dot, 1, 2)
    else {
      return false;
    };
    remaining = after_initial_gap;
    consumed_initial = true;
  }
}

fn dot_space_gap(gap: &str) -> bool {
  let Some(rest) = gap.strip_prefix('.') else {
    return false;
  };
  consume_horizontal_space(rest, 1, 2).is_some_and(str::is_empty)
}

fn consume_horizontal_space(
  text: &str,
  min: usize,
  max: usize,
) -> Option<&str> {
  let mut consumed = 0_usize;
  let mut byte = 0_usize;
  for ch in text.chars() {
    if ch == '\n' || !ch.is_whitespace() || consumed == max {
      break;
    }
    consumed = consumed.saturating_add(1);
    byte = byte.saturating_add(ch.len_utf8());
  }
  (consumed >= min).then(|| text.get(byte..)).flatten()
}

fn single_name_hit_has_context(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  end: u32,
  filters: &DenyListFilterData,
) -> Result<bool> {
  let tail = slice_from(full_text, offsets, end)?;
  let rest = tail.trim_start();
  let mut chars = rest.chars();
  let next_is_upper = chars.next().is_some_and(char::is_uppercase)
    && chars.next().is_some_and(char::is_lowercase);
  if !next_is_upper {
    return Ok(false);
  }

  let next_word = rest
    .chars()
    .take_while(|ch| ch.is_alphabetic())
    .collect::<String>();
  Ok(
    !filters
      .sentence_starters
      .contains(&next_word.to_lowercase()),
  )
}

fn slice_from<'a>(
  full_text: &'a str,
  offsets: &ByteOffsets<'_>,
  start: u32,
) -> Result<&'a str> {
  let byte = offsets.validate_offset(start)?;
  full_text
    .get(byte..)
    .ok_or(Error::ByteOffsetOutOfBounds { offset: start })
}

struct ExtendedName {
  end: u32,
  text: String,
}

fn extend_person_name(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  end: u32,
  filters: &DenyListFilterData,
) -> Result<ExtendedName> {
  let mut new_end = end;

  loop {
    if char_at(full_text, offsets, new_end)? != Some(' ') {
      break;
    }
    let word_start = new_end.saturating_add(1);
    let Some(first) = char_at(full_text, offsets, word_start)? else {
      break;
    };
    if !first.is_uppercase() {
      break;
    }

    let word = read_until_whitespace(full_text, offsets, word_start)?;
    let stripped = strip_trailing_name_punctuation(&word);
    if stripped.chars().count() < 2 {
      break;
    }
    let lower = stripped.to_lowercase();
    if filters.stopwords.contains(&lower)
      || filters.person_stopwords.contains(&lower)
    {
      break;
    }

    new_end = word_start.saturating_add(byte_len(stripped));
  }

  Ok(ExtendedName {
    end: new_end,
    text: offsets.slice(full_text, start, new_end)?,
  })
}

fn read_until_whitespace(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
) -> Result<String> {
  let tail = slice_from(full_text, offsets, start)?;
  Ok(tail.chars().take_while(|ch| !ch.is_whitespace()).collect())
}

fn strip_trailing_name_punctuation(word: &str) -> &str {
  word.trim_end_matches([',', ';', '.', '”', '"', '’', '\'', '“', '»'])
}

struct DefinedTermQuote {
  content: String,
  after_closing_quote: String,
}

fn is_suppressible_defined_term_quote(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  filters: &DenyListFilterData,
) -> Result<bool> {
  let Some(quote) =
    find_defined_term_quote_content(full_text, offsets, start, filters)?
  else {
    return Ok(false);
  };
  let words = quote
    .content
    .split(|ch: char| !ch.is_alphabetic())
    .filter(|word| !word.is_empty())
    .collect::<Vec<_>>();

  if words.len() >= 2
    && starts_with_known_first_name(&quote.content, filters)
    && has_person_role_definition(&quote.after_closing_quote, filters)
  {
    return Ok(false);
  }

  Ok(words.len() >= 2)
}

fn find_defined_term_quote_content(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  filters: &DenyListFilterData,
) -> Result<Option<DefinedTermQuote>> {
  let start_byte = offsets.validate_offset(start)?;
  let Some(quote_start) = find_opening_quote(full_text, start_byte) else {
    return Ok(None);
  };
  let Some((quote_end, quote_char)) =
    find_closing_quote(full_text, quote_start, start_byte)
  else {
    return Ok(None);
  };
  let after_start = quote_end.saturating_add(quote_char.len_utf8());
  let after = full_text.get(after_start..).unwrap_or_default();
  let after_window = take_bytes(after, 120);
  if strip_defined_term_cue(&after_window, filters).is_none() {
    return Ok(None);
  }

  let quote_width = full_text
    .get(quote_start..)
    .and_then(|tail| tail.chars().next())
    .map_or(0, char::len_utf8);
  let content_start = quote_start.saturating_add(quote_width);

  Ok(Some(DefinedTermQuote {
    content: full_text
      .get(content_start..quote_end)
      .unwrap_or_default()
      .to_owned(),
    after_closing_quote: after_window,
  }))
}

fn find_opening_quote(full_text: &str, start_byte: usize) -> Option<usize> {
  let prefix = full_text.get(..start_byte)?;
  let mut distance = 0_u32;
  for (byte, ch) in prefix.char_indices().rev() {
    distance = distance.saturating_add(byte_len(ch.encode_utf8(&mut [0; 4])));
    if distance > 80 || ch == '\n' {
      break;
    }
    if opening_quotes().contains(&ch) && is_quote_boundary(full_text, byte, ch)
    {
      return Some(byte);
    }
    if closing_quotes().contains(&ch) && is_quote_boundary(full_text, byte, ch)
    {
      break;
    }
  }
  None
}

fn find_closing_quote(
  full_text: &str,
  quote_start: usize,
  start_byte: usize,
) -> Option<(usize, char)> {
  let tail = full_text.get(start_byte..)?;
  let mut distance = byte_len(full_text.get(quote_start..start_byte)?);
  for (relative, ch) in tail.char_indices() {
    if distance > 120 {
      break;
    }
    let byte = start_byte.saturating_add(relative);
    if closing_quotes().contains(&ch) && is_quote_boundary(full_text, byte, ch)
    {
      return Some((byte, ch));
    }
    distance = distance.saturating_add(byte_len(ch.encode_utf8(&mut [0; 4])));
  }
  None
}

fn is_quote_boundary(full_text: &str, byte: usize, ch: char) -> bool {
  if ch != '\'' && ch != '’' {
    return true;
  }
  let after_byte = byte.saturating_add(ch.len_utf8());
  let before = char_before_byte(full_text, byte);
  let after = char_after_byte(full_text, after_byte);
  !(before.is_some_and(char::is_alphabetic)
    && after.is_some_and(char::is_alphabetic))
}

fn opening_quotes() -> &'static BTreeSet<char> {
  static QUOTES: std::sync::LazyLock<BTreeSet<char>> =
    std::sync::LazyLock::new(|| {
      BTreeSet::from(['"', '\'', '“', '„', '‟', '‘', '‛', '«'])
    });
  &QUOTES
}

fn closing_quotes() -> &'static BTreeSet<char> {
  static QUOTES: std::sync::LazyLock<BTreeSet<char>> =
    std::sync::LazyLock::new(|| {
      BTreeSet::from(['"', '\'', '”', '’', '»', '“'])
    });
  &QUOTES
}

fn take_bytes(text: &str, max: u32) -> String {
  let mut taken = String::new();
  let mut len = 0_u32;
  for ch in text.chars() {
    let width = byte_len(ch.encode_utf8(&mut [0; 4]));
    if len.saturating_add(width) > max {
      break;
    }
    taken.push(ch);
    len = len.saturating_add(width);
  }
  taken
}

fn strip_defined_term_cue<'a>(
  after: &'a str,
  filters: &DenyListFilterData,
) -> Option<&'a str> {
  let trimmed =
    after.trim_start_matches(|ch: char| ch.is_whitespace() || ch == ',');
  let lower = trimmed.to_lowercase();
  for cue in &filters.defined_term_cues {
    if lower.starts_with(cue) && word_boundary_after(lower.as_str(), cue.len())
    {
      return trimmed.get(cue.len()..);
    }
  }
  None
}

fn word_boundary_after(text: &str, byte: usize) -> bool {
  text
    .get(byte..)
    .and_then(|tail| tail.chars().next())
    .is_none_or(|ch| !ch.is_alphabetic())
}

fn starts_with_known_first_name(
  quote_content: &str,
  filters: &DenyListFilterData,
) -> bool {
  let first_word = quote_content
    .trim()
    .chars()
    .take_while(|ch| ch.is_alphabetic())
    .collect::<String>();
  !first_word.is_empty()
    && filters.first_names.contains(&first_word.to_lowercase())
}

fn has_person_role_definition(
  after_closing_quote: &str,
  filters: &DenyListFilterData,
) -> bool {
  let Some(after_cue) = strip_defined_term_cue(after_closing_quote, filters)
  else {
    return false;
  };
  after_cue
    .split(|ch: char| !ch.is_alphabetic())
    .filter(|word| !word.is_empty())
    .take(8)
    .any(|word| filters.generic_roles.contains(&word.to_lowercase()))
}

fn extend_city_districts(
  entities: &mut [PipelineEntity],
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  filters: Option<&DenyListFilterData>,
) -> Result<()> {
  for entity in entities {
    if entity.label != ADDRESS_LABEL
      || entity.source_detail == Some(SourceDetail::CustomDenyList)
    {
      continue;
    }

    if let Some(suffix) =
      match_district_suffix(slice_from(full_text, offsets, entity.end)?)
    {
      entity.end = entity.end.saturating_add(byte_len(suffix));
      entity.text = offsets.slice(full_text, entity.start, entity.end)?;
    }

    if let Some(suffix) =
      match_dash_district(slice_from(full_text, offsets, entity.end)?)
    {
      entity.end = entity.end.saturating_add(byte_len(suffix));
      entity.text = offsets.slice(full_text, entity.start, entity.end)?;
    }

    let before = offsets.slice(
      full_text,
      offsets.floor_offset(entity.start.saturating_sub(10))?,
      entity.start,
    )?;
    if let Some(prefix) = postal_prefix(&before) {
      entity.start = entity.start.saturating_sub(byte_len(prefix));
      entity.text = offsets.slice(full_text, entity.start, entity.end)?;
    }

    if let Some(filters) = filters
      && let Some(suffix) = match_trailing_address_word(
        slice_from(full_text, offsets, entity.end)?,
        filters,
      )
    {
      entity.end = entity.end.saturating_add(byte_len(suffix));
      entity.text = offsets.slice(full_text, entity.start, entity.end)?;
    }
  }

  Ok(())
}

fn match_district_suffix(after: &str) -> Option<&str> {
  let rest = after.strip_prefix(' ')?;
  let suffix = numeric_district(rest).or_else(|| roman_district(rest))?;
  let end = ' '.len_utf8().saturating_add(suffix.len());
  let next = after.get(end..).and_then(|tail| tail.chars().next());
  next
    .is_none_or(is_district_boundary)
    .then(|| after.get(..end))
    .flatten()
}

fn numeric_district(text: &str) -> Option<&str> {
  let digits = text
    .chars()
    .take_while(char::is_ascii_digit)
    .collect::<String>();
  if digits.is_empty() || digits.len() > 2 {
    return None;
  }
  text.get(..digits.len())
}

fn roman_district(text: &str) -> Option<&str> {
  roman_districts()
    .iter()
    .find_map(|roman| text.starts_with(roman).then_some(*roman))
}

const fn roman_districts() -> &'static [&'static str] {
  &[
    "XXX", "XXIX", "XXVIII", "XXVII", "XXVI", "XXV", "XXIV", "XXIII", "XXII",
    "XXI", "XX", "XIX", "XVIII", "XVII", "XVI", "XV", "XIV", "XIII", "XII",
    "XI", "X", "IX", "VIII", "VII", "VI", "IV", "III", "II",
  ]
}

const fn is_district_boundary(ch: char) -> bool {
  ch.is_whitespace() || matches!(ch, ',' | ';' | '.' | ')' | '"')
}

fn match_dash_district(after: &str) -> Option<&str> {
  let (space_len, after_space) = consume_spaces_or_tabs(after, 1, 4)?;
  let dash = after_space.chars().next()?;
  if dash != '-' && dash != '–' {
    return None;
  }
  let after_dash = after_space.get(dash.len_utf8()..)?;
  let (post_dash_spaces, word_start) =
    consume_spaces_or_tabs(after_dash, 0, usize::MAX)
      .unwrap_or((0, after_dash));
  let mut chars = word_start.chars();
  let first = chars.next()?;
  let second = chars.next()?;
  if !first.is_uppercase() || !second.is_lowercase() {
    return None;
  }
  let word_len = first
    .len_utf8()
    .saturating_add(second.len_utf8())
    .saturating_add(
      chars
        .take_while(|ch| ch.is_lowercase())
        .map(char::len_utf8)
        .sum::<usize>(),
    );
  let total = space_len
    .saturating_add(dash.len_utf8())
    .saturating_add(post_dash_spaces)
    .saturating_add(word_len);
  after.get(..total)
}

fn consume_spaces_or_tabs(
  text: &str,
  min: usize,
  max: usize,
) -> Option<(usize, &str)> {
  let mut consumed = 0_usize;
  let mut byte = 0_usize;
  for ch in text.chars() {
    if (ch != ' ' && ch != '\t') || consumed == max {
      break;
    }
    consumed = consumed.saturating_add(1);
    byte = byte.saturating_add(ch.len_utf8());
  }
  (consumed >= min)
    .then(|| text.get(byte..).map(|rest| (byte, rest)))
    .flatten()
}

fn postal_prefix(before: &str) -> Option<&str> {
  let trimmed_end = before.trim_end();
  let suffix_ws = before.len().saturating_sub(trimmed_end.len());
  let before_dash =
    trimmed_end.trim_end_matches(|ch: char| ch.is_whitespace() || is_dash(ch));
  let dash_ws = trimmed_end.len().saturating_sub(before_dash.len());

  if let Some(code) = trailing_postal_code(before_dash) {
    let start = before_dash.len().saturating_sub(code.len());
    let end = before
      .len()
      .saturating_sub(suffix_ws)
      .saturating_add(dash_ws);
    return before.get(start..end);
  }
  None
}

fn trailing_postal_code(text: &str) -> Option<&str> {
  let chars = text.chars().collect::<Vec<_>>();
  if chars.len() >= 5 {
    let start = chars.len().saturating_sub(5);
    if five_digits_at(&chars, start) {
      return text.get(byte_index_for_char(text, start)..);
    }
  }
  if chars.len() >= 6 {
    let start = chars.len().saturating_sub(6);
    if three_digits_at(&chars, start)
      && chars.get(start.saturating_add(3)) == Some(&' ')
      && two_digits_at(&chars, start.saturating_add(4))
    {
      return text.get(byte_index_for_char(text, start)..);
    }
  }
  None
}

fn byte_index_for_char(text: &str, char_index: usize) -> usize {
  text
    .char_indices()
    .nth(char_index)
    .map_or(text.len(), |(byte, _)| byte)
}

const fn is_dash(ch: char) -> bool {
  matches!(ch, '-' | '–' | '—')
}

fn match_trailing_address_word<'a>(
  after: &'a str,
  filters: &DenyListFilterData,
) -> Option<&'a str> {
  let (space_len, word_start) = consume_whitespace_no_newline(after, 1, 4)?;
  let mut chars = word_start.chars();
  let first = chars.next()?;
  let second = chars.next()?;
  if !first.is_uppercase() || !second.is_lowercase() {
    return None;
  }
  let rest_len = chars
    .take_while(|ch| ch.is_lowercase())
    .map(char::len_utf8)
    .sum::<usize>();
  let word_len = first
    .len_utf8()
    .saturating_add(second.len_utf8())
    .saturating_add(rest_len);
  let word = word_start.get(..word_len)?;
  if filters
    .trailing_address_word_exclusions
    .contains(&word.to_lowercase())
  {
    return None;
  }
  after.get(..space_len.saturating_add(word_len))
}

fn consume_whitespace_no_newline(
  text: &str,
  min: usize,
  max: usize,
) -> Option<(usize, &str)> {
  let mut consumed = 0_usize;
  let mut byte = 0_usize;
  for ch in text.chars() {
    if ch == '\n' || !ch.is_whitespace() || consumed == max {
      break;
    }
    consumed = consumed.saturating_add(1);
    byte = byte.saturating_add(ch.len_utf8());
  }
  (consumed >= min)
    .then(|| text.get(byte..).map(|rest| (byte, rest)))
    .flatten()
}

fn try_gazetteer_prefix_extension(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  found: &SearchMatch,
) -> Result<Option<(u32, String, Option<SourceDetail>)>> {
  let full_len = offsets.len()?;
  let max_end = found
    .end()
    .saturating_add(MAX_GAZETTEER_PREFIX_OVERSHOOT)
    .min(full_len);
  let max_end = offsets.floor_offset(max_end)?;
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
    let width = u32::try_from(ch.len_utf8()).unwrap_or(u32::MAX);
    if offset > 0 && ch == ' ' {
      return offset;
    }
    offset = offset.saturating_add(width);
  }

  offset
}

fn starts_as_proper_noun(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
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

fn custom_match_has_valid_edges(
  full_text: &str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  end: u32,
  pattern: &str,
) -> Result<bool> {
  if !pattern.chars().any(char::is_alphanumeric) {
    return Ok(true);
  }

  let start_byte = offsets.validate_offset(start)?;
  let end_byte = offsets.validate_offset(end)?;
  let previous = full_text
    .get(..start_byte)
    .and_then(|prefix| prefix.chars().next_back());
  if previous.is_some_and(char::is_alphanumeric) {
    return Ok(false);
  }

  let next = full_text
    .get(end_byte..)
    .and_then(|suffix| suffix.chars().next());
  if next.is_some_and(char::is_alphanumeric) {
    return Ok(false);
  }

  Ok(true)
}

const fn fuzzy_distance(found: &SearchMatch) -> Option<u32> {
  let SearchMatch::Fuzzy { distance, .. } = found else {
    return None;
  };
  Some(*distance)
}
