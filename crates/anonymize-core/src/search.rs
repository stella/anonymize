use stella_text_search_core as text_search;

use crate::artifact_bytes::{ArtifactReader, ArtifactWriter};
use crate::types::{Error, Result, SearchEngine, SearchMatch};

const SEARCH_INDEX_ARTIFACTS_HEADER: [u8; 8] = *b"ANONIDX1";
const SEARCH_INDEX_ARTIFACTS_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub enum SearchPattern {
  Literal(String),
  LiteralWithOptions {
    pattern: String,
    case_insensitive: Option<bool>,
    whole_words: Option<bool>,
  },
  Regex(String),
  RegexWithOptions {
    pattern: String,
    lazy: bool,
    prefilter_any: Vec<String>,
    prefilter_case_insensitive: Option<bool>,
    prefilter_regex: Option<String>,
  },
  Fuzzy {
    pattern: String,
    distance: Option<u8>,
  },
}

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
pub struct SearchOptions {
  pub literal: LiteralSearchOptions,
  pub regex: RegexSearchOptions,
  pub fuzzy: FuzzySearchOptions,
}

#[derive(
  Clone,
  Copy,
  Debug,
  Default,
  Eq,
  Ord,
  PartialEq,
  PartialOrd,
  serde::Deserialize,
  serde::Serialize,
)]
pub struct LiteralSearchOptions {
  pub case_insensitive: bool,
  pub whole_words: bool,
}

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
pub struct RegexSearchOptions {
  pub whole_words: bool,
  pub overlap_all: bool,
}

#[derive(
  Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct FuzzySearchOptions {
  pub case_insensitive: bool,
  pub whole_words: bool,
  pub normalize_diacritics: bool,
}

impl Default for FuzzySearchOptions {
  fn default() -> Self {
    Self {
      case_insensitive: false,
      whole_words: true,
      normalize_diacritics: false,
    }
  }
}

pub struct SearchIndex {
  slots: Vec<SearchSlot>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SearchIndexArtifacts {
  pub slots: Vec<text_search::PreparedTextSearchArtifacts>,
}

impl SearchIndexArtifacts {
  pub fn to_bytes(&self) -> Result<Vec<u8>> {
    let mut writer = ArtifactWriter::new(
      SEARCH_INDEX_ARTIFACTS_HEADER,
      SEARCH_INDEX_ARTIFACTS_VERSION,
    );
    writer.write_len(self.slots.len(), "search_index.slots")?;
    for slot in &self.slots {
      let slot_bytes = slot.to_bytes().map_err(|error| search_error(&error))?;
      writer.write_len_prefixed_bytes("search_index.slot", &slot_bytes)?;
    }
    Ok(writer.into_bytes())
  }

  pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
    let mut reader = ArtifactReader::new(
      bytes,
      SEARCH_INDEX_ARTIFACTS_HEADER,
      SEARCH_INDEX_ARTIFACTS_VERSION,
      "search_index_artifacts",
    )?;
    let count = reader.read_usize()?;
    let mut slots = Vec::with_capacity(count);
    for _ in 0..count {
      slots.push(
        text_search::PreparedTextSearchArtifacts::from_bytes(
          reader.read_len_prefixed_bytes()?,
        )
        .map_err(|error| search_error(&error))?,
      );
    }
    reader.finish()?;
    Ok(Self { slots })
  }
}

struct SearchSlot {
  engine: SlotEngine,
  search: text_search::TextSearch,
  pattern_indexes: Vec<u32>,
}

#[derive(Clone, Copy)]
enum SlotEngine {
  Literal,
  Regex,
  Fuzzy,
}

struct SearchIndexParts {
  literals: Vec<text_search::PatternEntry>,
  literal_indexes: Vec<u32>,
  regex: Vec<text_search::PatternEntry>,
  regex_indexes: Vec<u32>,
  fuzzy: Vec<text_search::PatternEntry>,
  fuzzy_indexes: Vec<u32>,
}

struct SearchIndexArtifactCursor<'a> {
  slots: &'a [text_search::PreparedTextSearchArtifacts],
  index: usize,
}

impl<'a> SearchIndexArtifactCursor<'a> {
  const fn new(slots: &'a [text_search::PreparedTextSearchArtifacts]) -> Self {
    Self { slots, index: 0 }
  }

  fn next(&mut self) -> Result<&'a text_search::PreparedTextSearchArtifacts> {
    let index = self.index;
    let Some(artifacts) = self.slots.get(index) else {
      return Err(search_message(format!(
        "Missing prepared text-search artifact at slot {index}"
      )));
    };
    self.index = self.index.saturating_add(1);
    Ok(artifacts)
  }

  fn finish(&self) -> Result<()> {
    if self.index == self.slots.len() {
      return Ok(());
    }
    Err(search_message(format!(
      "Expected {} prepared text-search artifacts, got {}",
      self.index,
      self.slots.len()
    )))
  }
}

impl SearchIndex {
  pub fn new(
    patterns: Vec<SearchPattern>,
    options: SearchOptions,
  ) -> Result<Self> {
    let parts = partition_patterns(patterns)?;
    build_search_index(parts, options, None)
  }

  pub fn prepare_artifacts(
    patterns: Vec<SearchPattern>,
    options: SearchOptions,
  ) -> Result<SearchIndexArtifacts> {
    let parts = partition_patterns(patterns)?;
    let mut slots = Vec::new();
    capture_slot_artifacts(
      &mut slots,
      parts.literals,
      literal_options(options.literal),
    )?;
    capture_slot_artifacts(
      &mut slots,
      parts.regex,
      regex_options(options.regex),
    )?;
    capture_slot_artifacts(
      &mut slots,
      parts.fuzzy,
      fuzzy_options(options.fuzzy),
    )?;
    Ok(SearchIndexArtifacts { slots })
  }

  pub fn new_with_artifacts(
    patterns: Vec<SearchPattern>,
    options: SearchOptions,
    artifacts: &SearchIndexArtifacts,
  ) -> Result<Self> {
    if patterns.is_empty() && !artifacts.slots.is_empty() {
      return Self::new_all_literal_with_artifacts(options, artifacts);
    }

    let parts = partition_patterns(patterns)?;
    let mut cursor = SearchIndexArtifactCursor::new(&artifacts.slots);
    let search = build_search_index(parts, options, Some(&mut cursor))?;
    cursor.finish()?;
    Ok(search)
  }

  fn new_all_literal_with_artifacts(
    options: SearchOptions,
    artifacts: &SearchIndexArtifacts,
  ) -> Result<Self> {
    let mut cursor = SearchIndexArtifactCursor::new(&artifacts.slots);
    let slot_artifacts = cursor.next()?;
    let search = text_search::TextSearch::with_prepared_all_literal_artifacts(
      literal_options(options.literal),
      slot_artifacts,
    )
    .map_err(|error| search_error(&error))?;
    cursor.finish()?;
    let pattern_indexes = (0..search.len())
      .map(pattern_index)
      .collect::<Result<Vec<_>>>()?;
    Ok(Self {
      slots: vec![SearchSlot {
        engine: SlotEngine::Literal,
        search,
        pattern_indexes,
      }],
    })
  }

  pub fn find_iter(&self, haystack: &str) -> Result<Vec<SearchMatch>> {
    let mut matches = Vec::new();
    for slot in &self.slots {
      for found in slot
        .search
        .find_iter(haystack)
        .map_err(|error| search_error(&error))?
      {
        let pattern = remap_pattern(slot, found.pattern)?;
        matches.push(match slot.engine {
          SlotEngine::Literal => SearchMatch::Literal {
            pattern,
            start: found.start,
            end: found.end,
          },
          SlotEngine::Regex => SearchMatch::Regex {
            pattern,
            start: found.start,
            end: found.end,
          },
          SlotEngine::Fuzzy => SearchMatch::Fuzzy {
            pattern,
            start: found.start,
            end: found.end,
            distance: found.distance.unwrap_or(0),
          },
        });
      }
    }

    matches.sort_by(|left, right| {
      left
        .start()
        .cmp(&right.start())
        .then_with(|| left.end().cmp(&right.end()))
        .then_with(|| left.pattern().cmp(&right.pattern()))
    });
    Ok(matches)
  }

  pub fn is_match(&self, haystack: &str) -> Result<bool> {
    for slot in &self.slots {
      if slot
        .search
        .is_match(haystack)
        .map_err(|error| search_error(&error))?
      {
        return Ok(true);
      }
    }

    Ok(false)
  }

  #[must_use]
  pub fn len(&self) -> usize {
    self
      .slots
      .iter()
      .map(|slot| slot.pattern_indexes.len())
      .fold(0usize, usize::saturating_add)
  }

  #[must_use]
  pub fn is_empty(&self) -> bool {
    self
      .slots
      .iter()
      .all(|slot| slot.pattern_indexes.is_empty())
  }
}

fn partition_patterns(
  patterns: Vec<SearchPattern>,
) -> Result<SearchIndexParts> {
  let mut literals = Vec::new();
  let mut literal_indexes = Vec::new();
  let mut regex = Vec::new();
  let mut regex_indexes = Vec::new();
  let mut fuzzy = Vec::new();
  let mut fuzzy_indexes = Vec::new();

  for (index, entry) in patterns.into_iter().enumerate() {
    let pattern_index = pattern_index(index)?;
    match entry {
      SearchPattern::Literal(pattern) => {
        literals.push(text_search::PatternEntry::Auto(pattern));
        literal_indexes.push(pattern_index);
      }
      SearchPattern::LiteralWithOptions {
        pattern,
        case_insensitive,
        whole_words,
      } => {
        literals.push(text_search::PatternEntry::Literal(
          text_search::LiteralPattern {
            pattern,
            name: None,
            case_insensitive,
            whole_words,
          },
        ));
        literal_indexes.push(pattern_index);
      }
      SearchPattern::Regex(pattern) => {
        regex.push(text_search::PatternEntry::Regex(
          text_search::RegexPattern::new(pattern),
        ));
        regex_indexes.push(pattern_index);
      }
      SearchPattern::RegexWithOptions {
        pattern,
        lazy,
        prefilter_any,
        prefilter_case_insensitive,
        prefilter_regex,
      } => {
        let mut regex_pattern = text_search::RegexPattern::new(pattern);
        regex_pattern.lazy = lazy;
        regex_pattern.prefilter_any = prefilter_any;
        regex_pattern.prefilter_case_insensitive = prefilter_case_insensitive;
        regex_pattern.prefilter_regex = prefilter_regex;
        regex.push(text_search::PatternEntry::Regex(regex_pattern));
        regex_indexes.push(pattern_index);
      }
      SearchPattern::Fuzzy { pattern, distance } => {
        fuzzy.push(text_search::PatternEntry::Fuzzy(
          text_search::FuzzyPattern::new(
            pattern,
            distance.map_or(
              text_search::FuzzyDistance::Auto,
              text_search::FuzzyDistance::Exact,
            ),
          ),
        ));
        fuzzy_indexes.push(pattern_index);
      }
    }
  }

  Ok(SearchIndexParts {
    literals,
    literal_indexes,
    regex,
    regex_indexes,
    fuzzy,
    fuzzy_indexes,
  })
}

fn build_search_index(
  parts: SearchIndexParts,
  options: SearchOptions,
  mut artifacts: Option<&mut SearchIndexArtifactCursor<'_>>,
) -> Result<SearchIndex> {
  let mut slots = Vec::new();
  let literal_artifacts = slot_artifacts(&parts.literals, &mut artifacts)?;
  push_slot(
    &mut slots,
    SlotEngine::Literal,
    parts.literals,
    parts.literal_indexes,
    literal_options(options.literal),
    literal_artifacts,
  )?;
  let regex_artifacts = slot_artifacts(&parts.regex, &mut artifacts)?;
  push_slot(
    &mut slots,
    SlotEngine::Regex,
    parts.regex,
    parts.regex_indexes,
    regex_options(options.regex),
    regex_artifacts,
  )?;
  let fuzzy_artifacts = slot_artifacts(&parts.fuzzy, &mut artifacts)?;
  push_slot(
    &mut slots,
    SlotEngine::Fuzzy,
    parts.fuzzy,
    parts.fuzzy_indexes,
    fuzzy_options(options.fuzzy),
    fuzzy_artifacts,
  )?;

  Ok(SearchIndex { slots })
}

fn slot_artifacts<'a>(
  patterns: &[text_search::PatternEntry],
  artifacts: &mut Option<&mut SearchIndexArtifactCursor<'a>>,
) -> Result<Option<&'a text_search::PreparedTextSearchArtifacts>> {
  if patterns.is_empty() {
    return Ok(None);
  }
  let Some(cursor) = artifacts else {
    return Ok(None);
  };
  cursor.next().map(Some)
}

fn push_slot(
  slots: &mut Vec<SearchSlot>,
  engine: SlotEngine,
  patterns: Vec<text_search::PatternEntry>,
  pattern_indexes: Vec<u32>,
  options: text_search::TextSearchOptions,
  artifacts: Option<&text_search::PreparedTextSearchArtifacts>,
) -> Result<()> {
  if patterns.is_empty() {
    return Ok(());
  }

  let search = if let Some(artifacts) = artifacts {
    text_search::TextSearch::with_prepared_artifacts(
      patterns, options, artifacts,
    )
  } else {
    text_search::TextSearch::new(patterns, options)
  }
  .map_err(|error| search_error(&error))?;
  slots.push(SearchSlot {
    engine,
    search,
    pattern_indexes,
  });
  Ok(())
}

fn capture_slot_artifacts(
  slots: &mut Vec<text_search::PreparedTextSearchArtifacts>,
  patterns: Vec<text_search::PatternEntry>,
  options: text_search::TextSearchOptions,
) -> Result<()> {
  if patterns.is_empty() {
    return Ok(());
  }
  slots.push(
    text_search::TextSearch::prepare_artifacts(patterns, options)
      .map_err(|error| search_error(&error))?,
  );
  Ok(())
}

fn literal_options(
  options: LiteralSearchOptions,
) -> text_search::TextSearchOptions {
  text_search::TextSearchOptions {
    case_insensitive: options.case_insensitive,
    whole_words: options.whole_words,
    overlap_strategy: text_search::OverlapStrategy::All,
    all_literal: true,
    ..text_search::TextSearchOptions::default()
  }
}

fn regex_options(
  options: RegexSearchOptions,
) -> text_search::TextSearchOptions {
  text_search::TextSearchOptions {
    whole_words: options.whole_words,
    overlap_strategy: if options.overlap_all {
      text_search::OverlapStrategy::All
    } else {
      text_search::OverlapStrategy::Longest
    },
    ..text_search::TextSearchOptions::default()
  }
}

fn fuzzy_options(
  options: FuzzySearchOptions,
) -> text_search::TextSearchOptions {
  text_search::TextSearchOptions {
    case_insensitive: options.case_insensitive,
    whole_words: options.whole_words,
    normalize_diacritics: options.normalize_diacritics,
    ..text_search::TextSearchOptions::default()
  }
}

fn remap_pattern(slot: &SearchSlot, local_pattern: u32) -> Result<u32> {
  let index = usize::try_from(local_pattern).map_err(|_| {
    Error::PatternIndexNotAddressable {
      pattern: local_pattern,
    }
  })?;
  slot
    .pattern_indexes
    .get(index)
    .copied()
    .ok_or_else(|| Error::Search {
      engine: slot.engine.into(),
      reason: format!("Missing pattern map entry for {local_pattern}"),
    })
}

fn search_error(error: &text_search::Error) -> Error {
  search_message(error.to_string())
}

const fn search_message(reason: String) -> Error {
  Error::Search {
    engine: SearchEngine::Text,
    reason,
  }
}

impl From<SlotEngine> for SearchEngine {
  fn from(value: SlotEngine) -> Self {
    match value {
      SlotEngine::Literal => Self::Literal,
      SlotEngine::Regex => Self::Regex,
      SlotEngine::Fuzzy => Self::Fuzzy,
    }
  }
}

fn pattern_index(index: usize) -> Result<u32> {
  u32::try_from(index).map_err(|_| Error::PatternIndexOutOfRange { index })
}
