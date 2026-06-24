use stella_text_search_core as text_search;

use crate::types::{Error, Result, SearchEngine, SearchMatch};

#[derive(Clone, Debug, Eq, PartialEq)]
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SearchOptions {
  pub literal: LiteralSearchOptions,
  pub regex: RegexSearchOptions,
  pub fuzzy: FuzzySearchOptions,
}

#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
pub struct LiteralSearchOptions {
  pub case_insensitive: bool,
  pub whole_words: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RegexSearchOptions {
  pub whole_words: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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

impl SearchIndex {
  pub fn new(
    patterns: Vec<SearchPattern>,
    options: SearchOptions,
  ) -> Result<Self> {
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
          literals.push(text_search::PatternEntry::Literal(
            text_search::LiteralPattern {
              pattern,
              name: None,
              case_insensitive: None,
              whole_words: None,
            },
          ));
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

    let mut slots = Vec::new();
    push_slot(
      &mut slots,
      SlotEngine::Literal,
      literals,
      literal_indexes,
      literal_options(options.literal),
    )?;
    push_slot(
      &mut slots,
      SlotEngine::Regex,
      regex,
      regex_indexes,
      regex_options(options.regex),
    )?;
    push_slot(
      &mut slots,
      SlotEngine::Fuzzy,
      fuzzy,
      fuzzy_indexes,
      fuzzy_options(options.fuzzy),
    )?;

    Ok(Self { slots })
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
}

fn push_slot(
  slots: &mut Vec<SearchSlot>,
  engine: SlotEngine,
  patterns: Vec<text_search::PatternEntry>,
  pattern_indexes: Vec<u32>,
  options: text_search::TextSearchOptions,
) -> Result<()> {
  if patterns.is_empty() {
    return Ok(());
  }

  let search = text_search::TextSearch::new(patterns, options)
    .map_err(|error| search_error(&error))?;
  slots.push(SearchSlot {
    engine,
    search,
    pattern_indexes,
  });
  Ok(())
}

fn literal_options(
  options: LiteralSearchOptions,
) -> text_search::TextSearchOptions {
  text_search::TextSearchOptions {
    case_insensitive: options.case_insensitive,
    whole_words: options.whole_words,
    overlap_strategy: text_search::OverlapStrategy::All,
    ..text_search::TextSearchOptions::default()
  }
}

fn regex_options(
  options: RegexSearchOptions,
) -> text_search::TextSearchOptions {
  text_search::TextSearchOptions {
    whole_words: options.whole_words,
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
  Error::Search {
    engine: SearchEngine::Text,
    reason: error.to_string(),
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
