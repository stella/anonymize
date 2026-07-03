use crate::search::{LiteralSearchOptions, SearchOptions, SearchPattern};
use crate::types::{Error, Result};

use super::PreparedEngineSlices;

pub(super) struct RegexPatternGroups {
  pub(super) regex: Vec<SearchPattern>,
  pub(super) legal_forms: Vec<SearchPattern>,
  pub(super) triggers: Vec<SearchPattern>,
}

pub(super) fn split_regex_patterns(
  patterns: Vec<SearchPattern>,
  slices: &PreparedEngineSlices,
) -> Result<RegexPatternGroups> {
  let mut regex = Vec::new();
  let mut legal_forms = Vec::new();
  let mut triggers = Vec::new();

  for (index, pattern) in patterns.into_iter().enumerate() {
    let pattern_index = u32::try_from(index)
      .map_err(|_| Error::PatternIndexOutOfRange { index })?;
    if slices.legal_forms.contains(pattern_index) {
      legal_forms.push(pattern);
      continue;
    }
    if slices.triggers.contains(pattern_index) {
      triggers.push(pattern);
      continue;
    }
    regex.push(pattern);
  }

  Ok(RegexPatternGroups {
    regex,
    legal_forms,
    triggers,
  })
}

pub(super) fn legal_form_search_options() -> SearchOptions {
  SearchOptions::default()
}

pub(super) fn trigger_search_options() -> SearchOptions {
  SearchOptions {
    literal: LiteralSearchOptions {
      case_insensitive: true,
      whole_words: false,
    },
    ..SearchOptions::default()
  }
}

pub(super) fn promote_case_insensitive_literals(
  patterns: Vec<SearchPattern>,
) -> Vec<SearchPattern> {
  patterns
    .into_iter()
    .map(|entry| match entry {
      SearchPattern::LiteralWithOptions {
        pattern: value,
        case_insensitive: Some(true),
        whole_words,
      } if whole_words != Some(true) => SearchPattern::Literal(value),
      other => other,
    })
    .collect()
}
