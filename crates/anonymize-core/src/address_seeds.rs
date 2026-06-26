use std::collections::BTreeSet;

use regex::Regex;

use crate::processors::PatternSlice;
use crate::resolution::{DetectionSource, PipelineEntity, SourceDetail};
use crate::search::{SearchIndex, SearchOptions, SearchPattern};
use crate::types::{Error, Result, SearchEngine, SearchMatch};

const ADDRESS_SCORE_BASE: f64 = 0.5;
const ADDRESS_SCORE_MAX: f64 = 0.95;
const ADDRESS_CLUSTER_MAX_GAP: usize = 150;
const ADDRESS_RIGHT_EXPAND_LIMIT: usize = 200;
const BR_CEP_CONTEXT_WINDOW: usize = 200;
const PLAIN_POSTAL_CONTEXT_WINDOW: usize = 120;
const US_ZIP_CONTEXT_WINDOW: usize = 120;

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct AddressSeedData {
  #[serde(default)]
  pub boundary_words: Vec<String>,
  #[serde(default)]
  pub br_cep_cue_words: Vec<String>,
  #[serde(default)]
  pub unit_abbreviations: Vec<String>,
}

pub(crate) struct PreparedAddressSeedData {
  boundary_search: Option<SearchIndex>,
  br_cep_cue_search: Option<SearchIndex>,
  unit_abbreviations: BTreeSet<String>,
  postal_code_re: Regex,
  br_cep_shape_re: Regex,
  us_zip_plus_four_shape_re: Regex,
  us_state_before_zip_re: Regex,
  house_number_before_street_re: Regex,
  house_number_after_street_re: Regex,
  italian_cap_re: Regex,
  street_number_re: Regex,
}

impl PreparedAddressSeedData {
  pub(crate) fn new(data: AddressSeedData) -> Result<Self> {
    Ok(Self {
      boundary_search: literal_search(data.boundary_words)?,
      br_cep_cue_search: literal_search(data.br_cep_cue_words)?,
      unit_abbreviations: lowercased_set(data.unit_abbreviations),
      postal_code_re: compile_regex(
        r"(?u)(?:\d{5}[-‐‑‒–—―]\d{4}|\d{5}[-‐‑‒–—―]\d{3}|\d{3}\s\d{2}|\d{2}[-‐‑‒–—―]\d{3}|\d{5})",
      )?,
      br_cep_shape_re: compile_regex(r"(?u)^\d{5}[-‐‑‒–—―]\d{3}$")?,
      us_zip_plus_four_shape_re: compile_regex(r"(?u)^\d{5}[-‐‑‒–—―]\d{4}$")?,
      us_state_before_zip_re: compile_regex(
        r"(?u)(?:^|[^A-Za-z0-9])(?P<state>A[KLRZ]|C[AOT]|D[CE]|F[LM]|G[AU]|HI|I[ADLN]|K[SY]|LA|M[ADEHINOPST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AIT]|W[AIVY])\s*,?\s*$",
      )?,
      house_number_before_street_re: compile_regex(
        r"(?u)\b\d{1,6}(?:[-/]\d{1,6})?\s+(?:\p{Lu}\p{L}+[^\S\n\t]+){0,4}$",
      )?,
      house_number_after_street_re: compile_regex(
        r"(?u)^[^\S\n\t]+\d{1,6}(?:[-/]\d{1,6})?\b",
      )?,
      italian_cap_re: compile_regex(r"(?u)\b(?P<cap>\d{5})\s+\p{Lu}\p{L}+")?,
      street_number_re: compile_regex(
        r"(?u)\b(?P<street>\p{Lu}\p{Ll}{2,})\s+(?P<num>\d{1,5}(?:/\d{1,5})?)\s*[,\n]",
      )?,
    })
  }

  pub(crate) fn process(
    &self,
    matches: &[SearchMatch],
    street_type_slice: PatternSlice,
    full_text: &str,
    existing_entities: &[PipelineEntity],
  ) -> Result<Vec<PipelineEntity>> {
    let seeds = self.collect_seeds(
      matches,
      street_type_slice,
      full_text,
      existing_entities,
    )?;
    let clusters = cluster_seeds(&seeds, full_text, existing_entities);
    let mut results = Vec::new();

    for cluster in clusters {
      let score = score_cluster(&cluster);
      if score < 0.6 {
        continue;
      }
      let span = self.expand_cluster(full_text, &cluster, existing_entities);
      let Some(raw_text) = full_text.get(span.start..span.end) else {
        continue;
      };
      let resolution = resolve_newline_boundary(span.start, raw_text, &cluster);
      if resolution == NewlineBoundaryResolution::Drop {
        continue;
      }
      let relative_end = match resolution {
        NewlineBoundaryResolution::Keep => raw_text.len(),
        NewlineBoundaryResolution::Drop => 0,
        NewlineBoundaryResolution::Trim { relative_end } => relative_end,
      };
      let effective_raw = raw_text.get(..relative_end).unwrap_or_default();
      let leading = effective_raw
        .len()
        .saturating_sub(effective_raw.trim_start().len());
      let start = span.start.saturating_add(leading);
      let end = trim_address_tail(
        full_text,
        start,
        span.start.saturating_add(effective_raw.len()),
      );
      let effective_text = full_text.get(start..end).unwrap_or_default();
      let effective_len = text_units(effective_text);
      if !(5..=300).contains(&effective_len) {
        continue;
      }
      results.push(PipelineEntity::detected(
        u32::try_from(start).unwrap_or(u32::MAX),
        u32::try_from(end).unwrap_or(u32::MAX),
        "address",
        effective_text,
        score,
        DetectionSource::Regex,
      ));
    }

    Ok(results)
  }

  fn collect_seeds(
    &self,
    matches: &[SearchMatch],
    street_type_slice: PatternSlice,
    full_text: &str,
    existing_entities: &[PipelineEntity],
  ) -> Result<Vec<Seed>> {
    let mut seeds =
      self.collect_street_type_seeds(matches, street_type_slice, full_text)?;
    collect_existing_entity_seeds(&mut seeds, full_text, existing_entities);
    self.collect_street_number_seeds(&mut seeds, full_text, existing_entities);
    self.collect_postal_code_seeds(&mut seeds, full_text);
    self.collect_italian_cap_seeds(&mut seeds, full_text);
    seeds.sort_by(|left, right| {
      left
        .start
        .cmp(&right.start)
        .then_with(|| left.end.cmp(&right.end))
        .then_with(|| left.kind.cmp(&right.kind))
    });
    Ok(seeds)
  }

  fn collect_street_type_seeds(
    &self,
    matches: &[SearchMatch],
    street_type_slice: PatternSlice,
    full_text: &str,
  ) -> Result<Vec<Seed>> {
    let mut seeds = Vec::new();
    for found in matches {
      if street_type_slice.local_index(found.pattern()).is_none() {
        continue;
      }
      let Some(seed) = seed_from_match(full_text, found, SeedType::StreetWord)?
      else {
        continue;
      };
      if is_lowercase_street_word_in_prose(full_text, &seed, self) {
        continue;
      }
      seeds.push(seed);
    }
    Ok(seeds)
  }

  fn collect_postal_code_seeds(&self, seeds: &mut Vec<Seed>, full_text: &str) {
    for found in self.postal_code_re.find_iter(full_text) {
      let start = found.start();
      let end = found.end();
      let text = found.as_str();
      if !postal_boundaries(full_text, start, end) {
        continue;
      }
      let is_plain_five_digit = is_plain_five_digit_postal_code(text);
      if seed_covered(seeds, start, end) && !is_plain_five_digit {
        continue;
      }
      if is_plain_five_digit
        && !self.has_plain_postal_context(full_text, start, end, seeds)
      {
        continue;
      }
      if self.br_cep_shape_re.is_match(text)
        && !self.has_br_cue_nearby(full_text, start, end)
      {
        continue;
      }
      if self.us_zip_plus_four_shape_re.is_match(text) {
        let context = self.us_zip_plus_four_context(full_text, start, seeds);
        if !context.has_context {
          continue;
        }
        if let Some(state_seed) = context.state_seed
          && !seed_covered(seeds, state_seed.start, state_seed.end)
        {
          seeds.push(state_seed);
        }
      }
      seeds.push(Seed {
        kind: SeedType::PostalCode,
        start,
        end,
        text: text.to_owned(),
      });
    }
  }

  fn has_plain_postal_context(
    &self,
    full_text: &str,
    start: usize,
    end: usize,
    seeds: &[Seed],
  ) -> bool {
    seeds.iter().any(|seed| {
      within_text_window(
        full_text,
        seed.start,
        start,
        PLAIN_POSTAL_CONTEXT_WINDOW,
      ) && match seed.kind {
        SeedType::AddressTrigger => true,
        SeedType::City | SeedType::State => {
          seed.end >= start && seed.start <= end.saturating_add(4)
            || seed.end <= start
              && full_text.get(seed.end..start).is_some_and(is_city_zip_gap)
        }
        SeedType::StreetWord => {
          has_house_number_near_street_word(full_text, seed, self)
        }
        SeedType::PostalCode => false,
      }
    })
  }

  fn collect_italian_cap_seeds(&self, seeds: &mut Vec<Seed>, full_text: &str) {
    for captures in self.italian_cap_re.captures_iter(full_text) {
      let Some(found) = captures.name("cap") else {
        continue;
      };
      let start = found.start();
      let end = found.end();
      if seed_covered(seeds, start, end) {
        continue;
      }
      if !has_nearby_italian_cap_evidence(full_text, seeds, start) {
        continue;
      }
      seeds.push(Seed {
        kind: SeedType::PostalCode,
        start,
        end,
        text: found.as_str().to_owned(),
      });
    }
  }

  fn collect_street_number_seeds(
    &self,
    seeds: &mut Vec<Seed>,
    full_text: &str,
    existing_entities: &[PipelineEntity],
  ) {
    for captures in self.street_number_re.captures_iter(full_text) {
      let Some(full) = captures.get(0) else {
        continue;
      };
      let Some(street) = captures.name("street") else {
        continue;
      };
      let Some(number) = captures.name("num") else {
        continue;
      };
      let start = full.start();
      let end = number.end();
      if range_overlaps_non_address(start, end, existing_entities) {
        continue;
      }
      seeds.push(Seed {
        kind: SeedType::StreetWord,
        start,
        end,
        text: format!("{} {}", street.as_str(), number.as_str()),
      });
    }
  }

  fn has_br_cue_nearby(
    &self,
    full_text: &str,
    start: usize,
    end: usize,
  ) -> bool {
    let Some(search) = &self.br_cep_cue_search else {
      return false;
    };
    let window_start =
      offset_before_text_units(full_text, start, BR_CEP_CONTEXT_WINDOW);
    let window_end =
      offset_after_text_units(full_text, end, BR_CEP_CONTEXT_WINDOW);
    full_text
      .get(window_start..window_end)
      .is_some_and(|window| search.is_match(window).unwrap_or(false))
  }

  fn us_zip_plus_four_context(
    &self,
    full_text: &str,
    start: usize,
    seeds: &[Seed],
  ) -> UsZipPlusFourContext {
    if let Some(state_seed) = self.us_state_seed_before_zip(full_text, start) {
      return UsZipPlusFourContext {
        state_seed: Some(state_seed),
        has_context: true,
      };
    }

    let has_context = seeds.iter().any(|seed| {
      within_text_window(full_text, seed.start, start, US_ZIP_CONTEXT_WINDOW)
        && match seed.kind {
          SeedType::AddressTrigger => true,
          SeedType::City => {
            seed.end <= start
              && full_text.get(seed.end..start).is_some_and(is_city_zip_gap)
          }
          SeedType::StreetWord => {
            has_house_number_near_street_word(full_text, seed, self)
          }
          SeedType::PostalCode | SeedType::State => false,
        }
    });

    UsZipPlusFourContext {
      state_seed: None,
      has_context,
    }
  }

  fn us_state_seed_before_zip(
    &self,
    full_text: &str,
    start: usize,
  ) -> Option<Seed> {
    let window_start = floor_char_boundary(full_text, start.saturating_sub(24));
    let window = full_text.get(window_start..start)?;
    let captures = self.us_state_before_zip_re.captures(window)?;
    let state = captures.name("state")?;
    Some(Seed {
      kind: SeedType::State,
      start: window_start.saturating_add(state.start()),
      end: window_start.saturating_add(state.end()),
      text: state.as_str().to_owned(),
    })
  }

  fn expand_cluster(
    &self,
    full_text: &str,
    cluster: &SeedCluster,
    existing_entities: &[PipelineEntity],
  ) -> Span {
    let left_bound = nearest_left_non_address(
      full_text,
      cluster.start,
      existing_entities,
      cluster_starts_with_street_type_word(cluster),
    );
    let left_pos = expand_left(full_text, cluster.start, left_bound);
    if !cluster.has_expandable_address_context() {
      return Span {
        start: left_pos.min(cluster.start),
        end: cluster.end,
      };
    }

    let right_pos = self.expand_right(full_text, cluster, existing_entities);
    Span {
      start: left_pos.min(cluster.start),
      end: right_pos.max(cluster.end),
    }
  }

  fn expand_right(
    &self,
    full_text: &str,
    cluster: &SeedCluster,
    existing_entities: &[PipelineEntity],
  ) -> usize {
    let right_pos = cluster.end;
    let remaining = full_text.get(right_pos..).unwrap_or_default();
    let mut nearest_boundary =
      utf16_cap_at_char_boundary(remaining, ADDRESS_RIGHT_EXPAND_LIMIT);

    if let Some(boundary) = self.nearest_boundary_word(full_text, right_pos) {
      nearest_boundary = nearest_boundary.min(boundary);
    }
    if let Some(entity_boundary) =
      nearest_right_non_address(right_pos, existing_entities)
    {
      nearest_boundary = nearest_boundary.min(entity_boundary);
    }
    if let Some(double_newline) = remaining.find("\n\n") {
      nearest_boundary = nearest_boundary.min(double_newline);
    }
    if let Some(sentence_boundary) =
      sentence_boundary(remaining, &self.unit_abbreviations)
    {
      nearest_boundary = nearest_boundary.min(sentence_boundary);
    }

    let end = right_pos.saturating_add(nearest_boundary);
    trim_address_tail(full_text, right_pos, end)
  }

  fn nearest_boundary_word(
    &self,
    full_text: &str,
    right_pos: usize,
  ) -> Option<usize> {
    let search = self.boundary_search.as_ref()?;
    search
      .find_iter(full_text)
      .ok()?
      .into_iter()
      .filter_map(|found| {
        let start = usize::try_from(found.start()).ok()?;
        (start >= right_pos).then_some(start.saturating_sub(right_pos))
      })
      .min()
  }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum SeedType {
  StreetWord,
  PostalCode,
  City,
  State,
  AddressTrigger,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Seed {
  kind: SeedType,
  start: usize,
  end: usize,
  text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SeedCluster {
  seeds: Vec<Seed>,
  start: usize,
  end: usize,
}

impl SeedCluster {
  fn has_expandable_address_context(&self) -> bool {
    self.seeds.iter().any(|seed| {
      matches!(
        seed.kind,
        SeedType::StreetWord | SeedType::PostalCode | SeedType::AddressTrigger
      )
    })
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Span {
  start: usize,
  end: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct UsZipPlusFourContext {
  state_seed: Option<Seed>,
  has_context: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NewlineBoundaryResolution {
  Keep,
  Drop,
  Trim { relative_end: usize },
}

fn literal_search(patterns: Vec<String>) -> Result<Option<SearchIndex>> {
  let patterns = patterns
    .into_iter()
    .filter(|pattern| !pattern.is_empty())
    .map(|pattern| SearchPattern::LiteralWithOptions {
      pattern,
      case_insensitive: Some(true),
      whole_words: Some(true),
    })
    .collect::<Vec<_>>();
  if patterns.is_empty() {
    return Ok(None);
  }
  Ok(Some(SearchIndex::new(patterns, SearchOptions::default())?))
}

fn lowercased_set(values: Vec<String>) -> BTreeSet<String> {
  values
    .into_iter()
    .map(|value| value.to_lowercase())
    .collect()
}

fn compile_regex(pattern: &str) -> Result<Regex> {
  Regex::new(pattern).map_err(|error| Error::Search {
    engine: SearchEngine::Regex,
    reason: error.to_string(),
  })
}

fn seed_from_match(
  full_text: &str,
  found: &SearchMatch,
  kind: SeedType,
) -> Result<Option<Seed>> {
  let start = usize::try_from(found.start()).map_err(|_| {
    Error::PatternIndexNotAddressable {
      pattern: found.pattern(),
    }
  })?;
  let end = usize::try_from(found.end()).map_err(|_| {
    Error::PatternIndexNotAddressable {
      pattern: found.pattern(),
    }
  })?;
  let Some(text) = full_text.get(start..end) else {
    return Ok(None);
  };
  Ok(Some(Seed {
    kind,
    start,
    end,
    text: text.to_owned(),
  }))
}

fn collect_existing_entity_seeds(
  seeds: &mut Vec<Seed>,
  full_text: &str,
  existing_entities: &[PipelineEntity],
) {
  for entity in existing_entities {
    if entity.label != "address" {
      continue;
    }
    if entity.source_detail == Some(SourceDetail::CustomDenyList) {
      continue;
    }
    if overlaps_non_address(entity, existing_entities) {
      continue;
    }
    let Some(kind) = kind_for_existing_entity(entity) else {
      continue;
    };
    if let Some(seed) = postal_seed_from_existing_address(full_text, entity) {
      seeds.push(seed);
    }
    seeds.push(Seed {
      kind,
      start: usize::try_from(entity.start).unwrap_or(usize::MAX),
      end: usize::try_from(entity.end).unwrap_or(usize::MAX),
      text: entity.text.clone(),
    });
  }
}

fn postal_seed_from_existing_address(
  full_text: &str,
  entity: &PipelineEntity,
) -> Option<Seed> {
  if entity.source != DetectionSource::DenyList {
    return None;
  }
  let mut start = usize::try_from(entity.start).ok()?;
  let entity_end = usize::try_from(entity.end).ok()?;
  while let Some((previous_start, ch)) = previous_char(full_text, start) {
    if !ch.is_ascii_digit() {
      break;
    }
    start = previous_start;
  }

  let mut end = start;
  while let Some((next_start, ch)) = next_char(full_text, end) {
    if !ch.is_ascii_digit() {
      break;
    }
    end = next_start.saturating_add(ch.len_utf8());
  }
  if end > entity_end {
    return None;
  }
  let text = full_text.get(start..end)?;
  if !is_plain_five_digit_postal_code(text) {
    return None;
  }
  Some(Seed {
    kind: SeedType::PostalCode,
    start,
    end,
    text: text.to_owned(),
  })
}

fn kind_for_existing_entity(entity: &PipelineEntity) -> Option<SeedType> {
  match entity.source {
    DetectionSource::DenyList => Some(SeedType::City),
    DetectionSource::Trigger if starts_with_digit(&entity.text) => {
      Some(SeedType::PostalCode)
    }
    DetectionSource::Trigger => Some(SeedType::AddressTrigger),
    _ => None,
  }
}

fn starts_with_digit(text: &str) -> bool {
  text.chars().next().is_some_and(|ch| ch.is_ascii_digit())
}

fn is_lowercase_street_word_in_prose(
  full_text: &str,
  seed: &Seed,
  data: &PreparedAddressSeedData,
) -> bool {
  starts_lowercase(&seed.text)
    && full_text
      .get(seed.end..)
      .is_some_and(starts_with_whitespace_then_lowercase)
    && !has_house_number_near_street_word(full_text, seed, data)
}

fn starts_lowercase(text: &str) -> bool {
  text.chars().next().is_some_and(char::is_lowercase)
}

fn starts_with_whitespace_then_lowercase(text: &str) -> bool {
  let mut saw_whitespace = false;
  for ch in text.chars() {
    if ch.is_whitespace() {
      saw_whitespace = true;
      continue;
    }
    return saw_whitespace && ch.is_lowercase();
  }
  false
}

fn has_house_number_near_street_word(
  full_text: &str,
  seed: &Seed,
  data: &PreparedAddressSeedData,
) -> bool {
  if seed.text.chars().any(|ch| ch.is_ascii_digit()) {
    return true;
  }

  let before_start =
    floor_char_boundary(full_text, seed.start.saturating_sub(50));
  let before = full_text.get(before_start..seed.start).unwrap_or_default();
  if data.house_number_before_street_re.is_match(before) {
    return true;
  }

  let after_end = ceil_char_boundary(
    full_text,
    seed.end.saturating_add(24).min(full_text.len()),
  );
  let after = full_text.get(seed.end..after_end).unwrap_or_default();
  data.house_number_after_street_re.is_match(after)
}

fn postal_boundaries(full_text: &str, start: usize, end: usize) -> bool {
  let before_ok = previous_char(full_text, start)
    .is_none_or(|(_, ch)| !is_postal_adjacent(ch));
  let after_ok =
    next_char(full_text, end).is_none_or(|(_, ch)| !is_postal_adjacent(ch));
  before_ok && after_ok
}

fn is_postal_adjacent(ch: char) -> bool {
  ch.is_alphanumeric() || ch == '_' || is_dash(ch)
}

fn is_plain_five_digit_postal_code(text: &str) -> bool {
  text.len() == 5 && text.chars().all(|ch| ch.is_ascii_digit())
}

const fn is_dash(ch: char) -> bool {
  matches!(ch, '-' | '‐' | '‑' | '‒' | '–' | '—' | '―')
}

fn seed_covered(seeds: &[Seed], start: usize, end: usize) -> bool {
  seeds
    .iter()
    .any(|seed| seed.start <= start && seed.end >= end)
}

fn has_nearby_italian_cap_evidence(
  full_text: &str,
  seeds: &[Seed],
  start: usize,
) -> bool {
  seeds.iter().any(|seed| {
    within_text_window(full_text, seed.start, start, 80)
      && match seed.kind {
        SeedType::AddressTrigger | SeedType::City | SeedType::PostalCode => {
          true
        }
        SeedType::StreetWord => seed.text.to_lowercase() != "via",
        SeedType::State => false,
      }
  })
}

fn is_city_zip_gap(text: &str) -> bool {
  !text.is_empty() && text.chars().all(|ch| ch.is_whitespace() || ch == ',')
}

fn cluster_seeds(
  seeds: &[Seed],
  full_text: &str,
  existing_entities: &[PipelineEntity],
) -> Vec<SeedCluster> {
  let Some(first) = seeds.first() else {
    return Vec::new();
  };

  let mut clusters = Vec::new();
  let mut current = SeedCluster {
    seeds: vec![first.clone()],
    start: first.start,
    end: first.end,
  };

  for seed in seeds.iter().skip(1) {
    let gap_ok = within_text_window(
      full_text,
      current.end,
      seed.start,
      ADDRESS_CLUSTER_MAX_GAP,
    ) && !has_cluster_barrier(
      full_text,
      current.end,
      seed.start,
      existing_entities,
    );
    if gap_ok {
      current.seeds.push(seed.clone());
      current.end = current.end.max(seed.end);
      continue;
    }
    clusters.push(current);
    current = SeedCluster {
      seeds: vec![seed.clone()],
      start: seed.start,
      end: seed.end,
    };
  }
  clusters.push(current);
  clusters
}

fn within_text_window(
  full_text: &str,
  left: usize,
  right: usize,
  max_units: usize,
) -> bool {
  let start = left.min(right);
  let end = left.max(right);
  full_text
    .get(start..end)
    .is_some_and(|gap| text_units(gap) <= max_units)
}

fn text_units(text: &str) -> usize {
  text.chars().map(char::len_utf16).sum()
}

fn offset_before_text_units(
  full_text: &str,
  end: usize,
  max_units: usize,
) -> usize {
  let Some(prefix) = full_text.get(..end) else {
    return 0;
  };
  let mut units = 0usize;
  for (index, ch) in prefix.char_indices().rev() {
    let width = ch.len_utf16();
    if units.saturating_add(width) > max_units {
      return index.saturating_add(ch.len_utf8());
    }
    units = units.saturating_add(width);
  }
  0
}

fn offset_after_text_units(
  full_text: &str,
  start: usize,
  max_units: usize,
) -> usize {
  let Some(tail) = full_text.get(start..) else {
    return full_text.len();
  };
  let mut units = 0usize;
  for (relative, ch) in tail.char_indices() {
    let width = ch.len_utf16();
    if units.saturating_add(width) > max_units {
      return start.saturating_add(relative);
    }
    units = units.saturating_add(width);
  }
  full_text.len()
}

fn has_cluster_barrier(
  full_text: &str,
  gap_start: usize,
  gap_end: usize,
  existing_entities: &[PipelineEntity],
) -> bool {
  full_text
    .get(gap_start..gap_end)
    .is_some_and(has_paragraph_break)
    || existing_entities.iter().any(|entity| {
      non_address_label(&entity.label)
        && usize::try_from(entity.start)
          .is_ok_and(|start| start >= gap_start && start < gap_end)
        && usize::try_from(entity.end).is_ok_and(|end| end > gap_start)
    })
}

fn overlaps_non_address(
  entity: &PipelineEntity,
  existing_entities: &[PipelineEntity],
) -> bool {
  let start = usize::try_from(entity.start).unwrap_or(usize::MAX);
  let end = usize::try_from(entity.end).unwrap_or(usize::MAX);
  range_overlaps_non_address(start, end, existing_entities)
}

fn range_overlaps_non_address(
  start: usize,
  end: usize,
  existing_entities: &[PipelineEntity],
) -> bool {
  existing_entities.iter().any(|existing| {
    non_address_label(&existing.label)
      && usize::try_from(existing.end).is_ok_and(|existing_end| {
        existing_end > start
          && usize::try_from(existing.start)
            .is_ok_and(|existing_start| existing_start < end)
      })
  })
}

fn has_paragraph_break(text: &str) -> bool {
  let mut saw_newline = false;
  for ch in text.chars() {
    if ch == '\n' {
      if saw_newline {
        return true;
      }
      saw_newline = true;
      continue;
    }
    if !ch.is_whitespace() {
      saw_newline = false;
    }
  }
  false
}

fn score_cluster(cluster: &SeedCluster) -> f64 {
  let mut has_street_word = false;
  let mut has_postal_code = false;
  let mut has_city = false;
  let mut has_state = false;
  let mut has_address_trigger = false;

  for seed in &cluster.seeds {
    match seed.kind {
      SeedType::StreetWord => has_street_word = true,
      SeedType::PostalCode => has_postal_code = true,
      SeedType::City => has_city = true,
      SeedType::State => has_state = true,
      SeedType::AddressTrigger => has_address_trigger = true,
    }
  }

  let type_count = [
    has_street_word,
    has_postal_code,
    has_city,
    has_state,
    has_address_trigger,
  ]
  .into_iter()
  .filter(|seen| *seen)
  .count();
  if type_count < 2 {
    return 0.0;
  }

  let mut score = ADDRESS_SCORE_BASE;
  if has_postal_code {
    score += 0.15;
  }
  if has_city {
    score += 0.15;
  }
  if has_state {
    score += 0.15;
  }
  if has_street_word {
    score += 0.15;
  }
  if has_address_trigger {
    score += 0.1;
  }
  score.min(ADDRESS_SCORE_MAX)
}

fn nearest_left_non_address(
  full_text: &str,
  start: usize,
  existing_entities: &[PipelineEntity],
  ignore_date_prefix: bool,
) -> usize {
  existing_entities
    .iter()
    .filter_map(|entity| {
      if !non_address_label(&entity.label) {
        return None;
      }
      let end = usize::try_from(entity.end).ok()?;
      if ignore_date_prefix
        && date_label(&entity.label)
        && date_can_prefix_street_name(full_text, end, start)
      {
        return None;
      }
      (end <= start).then_some(end)
    })
    .max()
    .unwrap_or(0)
}

fn nearest_right_non_address(
  right_pos: usize,
  existing_entities: &[PipelineEntity],
) -> Option<usize> {
  existing_entities
    .iter()
    .filter(|entity| non_address_label(&entity.label))
    .filter_map(|entity| {
      let start = usize::try_from(entity.start).ok()?;
      let offset = start.saturating_sub(right_pos);
      (offset > 0).then_some(offset)
    })
    .min()
}

fn non_address_label(label: &str) -> bool {
  matches!(
    label,
    "registration number"
      | "tax identification number"
      | "national identification number"
      | "social security number"
      | "birth number"
      | "identity card number"
      | "date"
      | "date of birth"
      | "person"
      | "bank account number"
      | "email address"
      | "phone number"
      | "organization"
      | "iban"
  )
}

fn date_label(label: &str) -> bool {
  matches!(label, "date" | "date of birth")
}

fn cluster_starts_with_street_type_word(cluster: &SeedCluster) -> bool {
  cluster.seeds.iter().any(|seed| {
    seed.start == cluster.start
      && seed.kind == SeedType::StreetWord
      && !seed.text.chars().any(|ch| ch.is_ascii_digit())
  })
}

fn date_can_prefix_street_name(
  full_text: &str,
  date_end: usize,
  street_start: usize,
) -> bool {
  if date_end > street_start {
    return false;
  }
  full_text.get(date_end..street_start).is_some_and(|gap| {
    !gap.contains('\n') && gap.chars().all(char::is_whitespace)
  })
}

fn expand_left(full_text: &str, start: usize, left_bound: usize) -> usize {
  let mut left_pos = start;
  while left_pos > left_bound {
    let Some((word_start, word_end, word)) =
      word_before_for_address(full_text, left_pos, left_bound)
    else {
      break;
    };
    if word.len() < 2
      || !starts_uppercase_or_digit(word)
      || is_left_address_label(word)
    {
      break;
    }
    if full_text
      .get(word_start..left_pos)
      .is_some_and(|slice| slice.contains('\n'))
    {
      break;
    }
    left_pos = word_start;
    if word_end <= left_bound {
      break;
    }
  }
  left_pos
}

fn word_before_for_address(
  text: &str,
  pos: usize,
  left_bound: usize,
) -> Option<(usize, usize, &str)> {
  let mut end = pos;
  while end > left_bound {
    let Some((prev_start, ch)) = previous_char(text, end) else {
      break;
    };
    if ch == ' ' || ch == ',' {
      end = prev_start;
      continue;
    }
    break;
  }
  if end <= left_bound {
    return None;
  }

  let mut start = end;
  while start > left_bound {
    let Some((prev_start, ch)) = previous_char(text, start) else {
      break;
    };
    if ch.is_whitespace() {
      break;
    }
    start = prev_start;
  }
  let word = text.get(start..end)?;
  Some((start, end, word))
}

fn starts_uppercase_or_digit(text: &str) -> bool {
  text
    .chars()
    .next()
    .is_some_and(|ch| ch.is_uppercase() || ch.is_ascii_digit())
}

fn is_left_address_label(text: &str) -> bool {
  text.ends_with(':')
}

fn trim_address_tail(full_text: &str, start: usize, mut end: usize) -> usize {
  while end > start {
    let Some((prev_start, ch)) = previous_char(full_text, end) else {
      break;
    };
    if is_address_trailing_trim(ch) {
      end = prev_start;
      continue;
    }
    break;
  }
  end
}

fn sentence_boundary(
  text: &str,
  unit_abbreviations: &BTreeSet<String>,
) -> Option<usize> {
  let mut iter = text.char_indices().peekable();
  while let Some((index, ch)) = iter.next() {
    if !matches!(ch, '.' | '!' | '?') {
      continue;
    }
    if ch == '.' && is_unit_abbreviation(text, index, unit_abbreviations) {
      continue;
    }
    let mut saw_whitespace = false;
    while let Some((_, next)) = iter.peek().copied() {
      if !next.is_whitespace() {
        break;
      }
      saw_whitespace = true;
      iter.next();
    }
    let Some((_, next)) = iter.peek().copied() else {
      return Some(index);
    };
    if saw_whitespace && (next.is_uppercase() || next.is_ascii_digit()) {
      return Some(index);
    }
  }
  None
}

fn is_unit_abbreviation(
  text: &str,
  dot_index: usize,
  unit_abbreviations: &BTreeSet<String>,
) -> bool {
  let mut start = dot_index;
  while let Some((previous_start, ch)) = previous_char(text, start) {
    if ch.is_alphanumeric() || ch == '.' {
      start = previous_start;
      continue;
    }
    break;
  }
  if start == dot_index {
    return false;
  }
  text
    .get(start..dot_index.saturating_add(1))
    .is_some_and(|token| unit_abbreviations.contains(&token.to_lowercase()))
}

const fn is_address_trailing_trim(ch: char) -> bool {
  ch.is_whitespace()
    || matches!(
      ch,
      ','
        | ';'
        | ':'
        | '('
        | '['
        | '{'
        | '"'
        | '\''
        | '“'
        | '”'
        | '‘'
        | '’'
        | '′'
    )
}

fn resolve_newline_boundary(
  span_start: usize,
  text: &str,
  cluster: &SeedCluster,
) -> NewlineBoundaryResolution {
  let mut newline_positions = text.match_indices('\n').map(|(index, _)| index);
  let Some(relative_newline) = newline_positions.next() else {
    return NewlineBoundaryResolution::Keep;
  };
  if newline_positions.next().is_some() {
    return NewlineBoundaryResolution::Drop;
  }

  let newline_abs = span_start.saturating_add(relative_newline);
  let mut street_above = false;
  let mut street_below = false;
  let mut destination_above = false;
  let mut destination_below = false;

  for seed in &cluster.seeds {
    let is_above = seed.end <= newline_abs;
    let is_street = matches!(seed.kind, SeedType::StreetWord);
    let is_destination =
      matches!(seed.kind, SeedType::PostalCode | SeedType::City);
    if is_street && is_above {
      street_above = true;
    }
    if is_street && !is_above {
      street_below = true;
    }
    if is_destination && is_above {
      destination_above = true;
    }
    if is_destination && !is_above {
      destination_below = true;
    }
  }

  if (street_above && destination_below) || (street_below && destination_above)
  {
    return NewlineBoundaryResolution::Keep;
  }
  if street_above && destination_above {
    return NewlineBoundaryResolution::Trim {
      relative_end: relative_newline,
    };
  }
  NewlineBoundaryResolution::Drop
}

fn utf16_cap_at_char_boundary(text: &str, cap: usize) -> usize {
  let mut units = 0usize;
  for (index, ch) in text.char_indices() {
    let width = ch.len_utf16();
    if units.saturating_add(width) > cap {
      return index;
    }
    units = units.saturating_add(width);
  }
  text.len()
}

fn floor_char_boundary(text: &str, mut byte: usize) -> usize {
  byte = byte.min(text.len());
  while byte > 0 && !text.is_char_boundary(byte) {
    byte = byte.saturating_sub(1);
  }
  byte
}

fn ceil_char_boundary(text: &str, mut byte: usize) -> usize {
  byte = byte.min(text.len());
  while byte < text.len() && !text.is_char_boundary(byte) {
    byte = byte.saturating_add(1);
  }
  byte
}

fn previous_char(text: &str, byte: usize) -> Option<(usize, char)> {
  text.get(..byte)?.char_indices().next_back()
}

fn next_char(text: &str, byte: usize) -> Option<(usize, char)> {
  let suffix = text.get(byte..)?;
  let (relative, ch) = suffix.char_indices().next()?;
  Some((byte.saturating_add(relative), ch))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn entity(
    full_text: &str,
    text: &str,
    label: &str,
    source: DetectionSource,
  ) -> Result<PipelineEntity> {
    let Some(start) = full_text.find(text) else {
      return Err(Error::InvalidStaticData {
        field: "address_seed_test_fixture",
        reason: String::from("fixture text should exist"),
      });
    };
    let end = start.saturating_add(text.len());
    Ok(PipelineEntity::detected(
      u32::try_from(start).map_err(|_| Error::InvalidStaticData {
        field: "address_seed_test_fixture",
        reason: String::from("fixture start should fit u32"),
      })?,
      u32::try_from(end).map_err(|_| Error::InvalidStaticData {
        field: "address_seed_test_fixture",
        reason: String::from("fixture end should fit u32"),
      })?,
      label,
      text,
      0.9,
      source,
    ))
  }

  #[test]
  fn expands_compound_street_with_plain_postal_city() -> Result<()> {
    let data = PreparedAddressSeedData::new(AddressSeedData {
      boundary_words: vec![String::from("steuer-id")],
      br_cep_cue_words: Vec::new(),
      unit_abbreviations: Vec::new(),
    })?;
    let full_text = concat!(
      "(2) Frau Karoline M. Brentano,\n",
      "    geboren am 09. Juli 1982,\n",
      "    wohnhaft Bismarckring 18, 65183 Wiesbaden,\n",
      "    Steuer-ID: 78 123 456 789",
    );
    let existing = vec![
      entity(
        full_text,
        "Frau Karoline M. Brentano",
        "person",
        DetectionSource::DenyList,
      )?,
      entity(
        full_text,
        "09. Juli 1982",
        "date of birth",
        DetectionSource::Trigger,
      )?,
      entity(
        full_text,
        "5183 Wiesbaden",
        "address",
        DetectionSource::DenyList,
      )?,
    ];

    let result =
      data.process(&[], PatternSlice::default(), full_text, &existing)?;

    assert!(
      result
        .iter()
        .any(|entity| entity.text == "Bismarckring 18, 65183 Wiesbaden"),
      "address seed entities: {result:?}",
    );
    Ok(())
  }
}
