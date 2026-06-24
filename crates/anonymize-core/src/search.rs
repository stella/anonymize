use stella_aho_corasick_core as literal_core;
use stella_fuzzy_search_core as fuzzy_core;
use stella_regex_set_core as regex_core;

use crate::types::{Error, Result, SearchEngine, SearchMatch};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SearchPattern {
  Literal(String),
  Regex(String),
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
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
  literal: Option<literal_core::AhoCorasick>,
  literal_pattern_indexes: Vec<u32>,
  regex: Option<regex_core::RegexSet>,
  regex_pattern_indexes: Vec<u32>,
  fuzzy: Option<fuzzy_core::FuzzySearch>,
  fuzzy_pattern_indexes: Vec<u32>,
}

impl SearchIndex {
  pub fn new(
    patterns: Vec<SearchPattern>,
    options: SearchOptions,
  ) -> Result<Self> {
    let mut literal_patterns = Vec::<String>::new();
    let mut literal_pattern_indexes = Vec::<u32>::new();
    let mut regex_patterns = Vec::<String>::new();
    let mut regex_pattern_indexes = Vec::<u32>::new();
    let mut fuzzy_patterns = Vec::<fuzzy_core::PatternEntry>::new();
    let mut fuzzy_pattern_indexes = Vec::<u32>::new();

    for (index, entry) in patterns.into_iter().enumerate() {
      let pattern_index = pattern_index(index)?;
      match entry {
        SearchPattern::Literal(value) => {
          literal_patterns.push(value);
          literal_pattern_indexes.push(pattern_index);
        }
        SearchPattern::Regex(value) => {
          regex_patterns.push(value);
          regex_pattern_indexes.push(pattern_index);
        }
        SearchPattern::Fuzzy {
          pattern: fuzzy_pattern,
          distance,
        } => {
          fuzzy_patterns.push(fuzzy_core::PatternEntry {
            pattern: fuzzy_pattern,
            distance,
          });
          fuzzy_pattern_indexes.push(pattern_index);
        }
      }
    }

    let literal = build_literal(literal_patterns, options)?;
    let regex = build_regex(regex_patterns, options)?;
    let fuzzy = build_fuzzy(fuzzy_patterns, options)?;

    Ok(Self {
      literal,
      literal_pattern_indexes,
      regex,
      regex_pattern_indexes,
      fuzzy,
      fuzzy_pattern_indexes,
    })
  }

  pub fn find_iter(&self, haystack: &str) -> Result<Vec<SearchMatch>> {
    let mut matches = Vec::new();

    if let Some(literal) = &self.literal {
      extend_triple_matches(
        &mut matches,
        SearchEngine::Literal,
        &self.literal_pattern_indexes,
        &literal
          .find_overlapping_iter_packed(haystack)
          .map_err(|err| Error::Search {
            engine: SearchEngine::Literal,
            reason: err.to_string(),
          })?,
        |pattern, start, end| SearchMatch::Literal {
          pattern,
          start,
          end,
        },
      )?;
    }

    if let Some(regex) = &self.regex {
      extend_triple_matches(
        &mut matches,
        SearchEngine::Regex,
        &self.regex_pattern_indexes,
        &regex
          .find_iter_packed(haystack)
          .map_err(|err| Error::Search {
            engine: SearchEngine::Regex,
            reason: err.to_string(),
          })?,
        |pattern, start, end| SearchMatch::Regex {
          pattern,
          start,
          end,
        },
      )?;
    }

    if let Some(fuzzy) = &self.fuzzy {
      extend_fuzzy_matches(
        &mut matches,
        &self.fuzzy_pattern_indexes,
        &fuzzy
          .find_iter_packed(haystack)
          .map_err(|err| Error::Search {
            engine: SearchEngine::Fuzzy,
            reason: err.to_string(),
          })?,
      )?;
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
    if let Some(literal) = &self.literal
      && literal.is_match(haystack).map_err(|err| Error::Search {
        engine: SearchEngine::Literal,
        reason: err.to_string(),
      })?
    {
      return Ok(true);
    }

    if let Some(regex) = &self.regex
      && regex.is_match(haystack)
    {
      return Ok(true);
    }

    if let Some(fuzzy) = &self.fuzzy
      && fuzzy.is_match(haystack).map_err(|err| Error::Search {
        engine: SearchEngine::Fuzzy,
        reason: err.to_string(),
      })?
    {
      return Ok(true);
    }

    Ok(false)
  }
}

fn build_literal(
  patterns: Vec<String>,
  options: SearchOptions,
) -> Result<Option<literal_core::AhoCorasick>> {
  if patterns.is_empty() {
    return Ok(None);
  }

  literal_core::AhoCorasick::new(
    patterns,
    literal_core::Options {
      match_kind: literal_core::MatchKind::LeftmostFirst,
      case_insensitive: options.literal.case_insensitive,
      dfa: false,
      whole_words: options.literal.whole_words,
    },
  )
  .map(Some)
  .map_err(|err| Error::Search {
    engine: SearchEngine::Literal,
    reason: err.to_string(),
  })
}

fn build_regex(
  patterns: Vec<String>,
  options: SearchOptions,
) -> Result<Option<regex_core::RegexSet>> {
  if patterns.is_empty() {
    return Ok(None);
  }

  regex_core::RegexSet::new(
    patterns,
    regex_core::Options {
      whole_words: options.regex.whole_words,
      unicode_boundaries: true,
    },
  )
  .map(Some)
  .map_err(|err| Error::Search {
    engine: SearchEngine::Regex,
    reason: err.to_string(),
  })
}

fn build_fuzzy(
  patterns: Vec<fuzzy_core::PatternEntry>,
  options: SearchOptions,
) -> Result<Option<fuzzy_core::FuzzySearch>> {
  if patterns.is_empty() {
    return Ok(None);
  }

  fuzzy_core::FuzzySearch::new(
    patterns,
    fuzzy_core::Options {
      metric: fuzzy_core::Metric::Levenshtein,
      normalize_diacritics: options.fuzzy.normalize_diacritics,
      unicode_boundaries: true,
      whole_words: options.fuzzy.whole_words,
      case_insensitive: options.fuzzy.case_insensitive,
    },
  )
  .map(Some)
  .map_err(|err| Error::Search {
    engine: SearchEngine::Fuzzy,
    reason: err.to_string(),
  })
}

fn extend_triple_matches(
  matches: &mut Vec<SearchMatch>,
  engine: SearchEngine,
  pattern_indexes: &[u32],
  packed: &[u32],
  make_match: impl Fn(u32, u32, u32) -> SearchMatch,
) -> Result<()> {
  let chunks = packed.chunks_exact(3);
  if !chunks.remainder().is_empty() {
    return Err(invalid_packed_search_result(engine, packed.len()));
  }

  for chunk in chunks {
    let [local_pattern, start, end] = chunk else {
      return Err(invalid_packed_search_result(engine, packed.len()));
    };
    let pattern = pattern_index_from_packed(
      engine,
      pattern_indexes,
      *local_pattern,
      packed.len(),
    )?;

    matches.push(make_match(pattern, *start, *end));
  }

  Ok(())
}

fn extend_fuzzy_matches(
  matches: &mut Vec<SearchMatch>,
  pattern_indexes: &[u32],
  packed: &[u32],
) -> Result<()> {
  let chunks = packed.chunks_exact(4);
  if !chunks.remainder().is_empty() {
    return Err(invalid_packed_search_result(
      SearchEngine::Fuzzy,
      packed.len(),
    ));
  }

  for chunk in chunks {
    let [local_pattern, start, end, distance] = chunk else {
      return Err(invalid_packed_search_result(
        SearchEngine::Fuzzy,
        packed.len(),
      ));
    };
    let pattern = pattern_index_from_packed(
      SearchEngine::Fuzzy,
      pattern_indexes,
      *local_pattern,
      packed.len(),
    )?;

    matches.push(SearchMatch::Fuzzy {
      pattern,
      start: *start,
      end: *end,
      distance: *distance,
    });
  }

  Ok(())
}

fn pattern_index_from_packed(
  engine: SearchEngine,
  pattern_indexes: &[u32],
  local_pattern: u32,
  len: usize,
) -> Result<u32> {
  usize::try_from(local_pattern)
    .ok()
    .and_then(|index| pattern_indexes.get(index))
    .copied()
    .ok_or_else(|| invalid_packed_search_result(engine, len))
}

const fn invalid_packed_search_result(
  engine: SearchEngine,
  len: usize,
) -> Error {
  Error::InvalidPackedSearchResult { engine, len }
}

fn pattern_index(index: usize) -> Result<u32> {
  u32::try_from(index).map_err(|_| Error::PatternIndexOutOfRange { index })
}
