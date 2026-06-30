use std::time::Instant;

use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::normalize::NormalizedSearchText;
use crate::search::SearchIndex;
use crate::types::{Error, Result, SearchMatch};

use super::timing::{TimedMatches, elapsed_us};

pub(super) fn offset_index_matches(
  search: &SearchIndex,
  haystack: &str,
  diagnostics: Option<&mut StaticRedactionDiagnostics>,
  slot_stage: DiagnosticStage,
  input_bytes: usize,
  offset: u32,
) -> Result<Vec<SearchMatch>> {
  offset_matches(
    find_index_matches(search, haystack, diagnostics, slot_stage, input_bytes)?,
    offset,
  )
}

pub(super) fn timed_offset_index_matches(
  search: &SearchIndex,
  haystack: &str,
  slot_stage: DiagnosticStage,
  input_bytes: usize,
  offset: u32,
) -> Result<TimedMatches> {
  let start = Instant::now();
  offset_index_matches(search, haystack, None, slot_stage, input_bytes, offset)
    .map(|matches| TimedMatches {
      matches,
      elapsed_us: elapsed_us(start),
    })
}

pub(super) fn normalized_index_matches(
  search: &SearchIndex,
  normalized: &NormalizedSearchText,
  diagnostics: Option<&mut StaticRedactionDiagnostics>,
  slot_stage: DiagnosticStage,
  input_bytes: usize,
  offset: u32,
) -> Result<Vec<SearchMatch>> {
  find_index_matches(
    search,
    normalized.as_str(),
    diagnostics,
    slot_stage,
    input_bytes,
  )?
  .into_iter()
  .map(|found| remap_normalized_match(normalized, found))
  .map(|found| found.and_then(|value| offset_match(value, offset)))
  .collect()
}

pub(super) fn timed_normalized_index_matches(
  search: &SearchIndex,
  normalized: &NormalizedSearchText,
  slot_stage: DiagnosticStage,
  input_bytes: usize,
  offset: u32,
) -> Result<TimedMatches> {
  let start = Instant::now();
  normalized_index_matches(
    search,
    normalized,
    None,
    slot_stage,
    input_bytes,
    offset,
  )
  .map(|matches| TimedMatches {
    matches,
    elapsed_us: elapsed_us(start),
  })
}

pub(super) fn combine_regex_matches(
  mut regex: Vec<SearchMatch>,
  legal_forms: Vec<SearchMatch>,
  triggers: Vec<SearchMatch>,
) -> Vec<SearchMatch> {
  regex.extend(legal_forms);
  regex.extend(triggers);
  sort_matches(&mut regex);
  regex
}

pub(super) fn join_optional_timed_match_handle(
  handle: Option<std::thread::ScopedJoinHandle<'_, Result<TimedMatches>>>,
  field: &'static str,
) -> Result<TimedMatches> {
  handle.map_or_else(
    || Ok(TimedMatches::empty()),
    |handle| join_timed_match_handle(handle, field),
  )
}

fn find_index_matches(
  search: &SearchIndex,
  haystack: &str,
  diagnostics: Option<&mut StaticRedactionDiagnostics>,
  slot_stage: DiagnosticStage,
  input_bytes: usize,
) -> Result<Vec<SearchMatch>> {
  let Some(diagnostics) = diagnostics else {
    return search.find_iter(haystack);
  };

  let result = search.find_iter_with_stats(haystack)?;
  diagnostics.record_search_slot_summaries(
    slot_stage,
    &result.stats,
    input_bytes,
  );
  Ok(result.matches)
}

fn offset_matches(
  matches: Vec<SearchMatch>,
  offset: u32,
) -> Result<Vec<SearchMatch>> {
  if offset == 0 {
    return Ok(matches);
  }

  matches
    .into_iter()
    .map(|found| offset_match(found, offset))
    .collect()
}

fn offset_match(found: SearchMatch, offset: u32) -> Result<SearchMatch> {
  let pattern = found.pattern().checked_add(offset).ok_or_else(|| {
    Error::PatternIndexNotAddressable {
      pattern: found.pattern(),
    }
  })?;

  Ok(match found {
    SearchMatch::Literal { start, end, .. } => SearchMatch::Literal {
      pattern,
      start,
      end,
    },
    SearchMatch::Regex { start, end, .. } => SearchMatch::Regex {
      pattern,
      start,
      end,
    },
    SearchMatch::Fuzzy {
      start,
      end,
      distance,
      ..
    } => SearchMatch::Fuzzy {
      pattern,
      start,
      end,
      distance,
    },
  })
}

fn sort_matches(matches: &mut [SearchMatch]) {
  matches.sort_by(|left, right| {
    left
      .start()
      .cmp(&right.start())
      .then_with(|| left.end().cmp(&right.end()))
      .then_with(|| left.pattern().cmp(&right.pattern()))
  });
}

fn remap_normalized_match(
  normalized: &NormalizedSearchText,
  found: SearchMatch,
) -> Result<SearchMatch> {
  let (start, end) = normalized.map_span(found.start(), found.end())?;
  Ok(found.with_span(start, end))
}

fn join_timed_match_handle(
  handle: std::thread::ScopedJoinHandle<'_, Result<TimedMatches>>,
  field: &'static str,
) -> Result<TimedMatches> {
  handle.join().map_err(|_| Error::InvalidStaticData {
    field,
    reason: "search worker panicked".to_owned(),
  })?
}
