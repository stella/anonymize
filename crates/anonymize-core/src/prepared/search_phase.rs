use std::time::Instant;

use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::normalize::{
  NormalizedSearchText, normalize_for_search_with_byte_map,
};
use crate::search::SearchIndex;
use crate::types::{Error, Result, SearchMatch};

use super::PreparedSearch;
use super::results::PreparedSearchMatches;
use super::timing::{TimedMatches, TimedSearchBranches, elapsed_us};

const PARALLEL_SEARCH_MIN_BYTES: usize = 32 * 1024;

impl PreparedSearch {
  pub fn find_matches(&self, full_text: &str) -> Result<PreparedSearchMatches> {
    self.find_matches_inner(full_text, None)
  }

  pub(super) fn find_matches_inner(
    &self,
    full_text: &str,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<PreparedSearchMatches> {
    let total_start = Instant::now();
    let normalized = normalize_search_text(full_text, &mut diagnostics)?;
    if full_text.len() >= PARALLEL_SEARCH_MIN_BYTES {
      return self.find_matches_parallel(
        full_text,
        &normalized,
        diagnostics,
        total_start,
      );
    }

    self.find_matches_sequential(
      full_text,
      &normalized,
      diagnostics,
      total_start,
    )
  }

  fn find_matches_sequential(
    &self,
    full_text: &str,
    normalized: &NormalizedSearchText,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
    total_start: Instant,
  ) -> Result<PreparedSearchMatches> {
    let regex_start = Instant::now();
    let regex = offset_index_matches(
      &self.regex,
      full_text,
      diagnostics.as_deref_mut(),
      DiagnosticStage::FindRegex,
      full_text.len(),
      self.slices.regex.start,
    )?;
    record_search_matches(
      &mut diagnostics,
      DiagnosticStage::SearchRegex,
      &regex,
      full_text,
      regex_start,
    );

    let legal_form_start = Instant::now();
    let legal_forms = normalized_index_matches(
      &self.legal_forms,
      normalized,
      diagnostics.as_deref_mut(),
      DiagnosticStage::FindLegalForm,
      full_text.len(),
      self.slices.legal_forms.start,
    )?;
    record_search_matches(
      &mut diagnostics,
      DiagnosticStage::SearchLegalForm,
      &legal_forms,
      full_text,
      legal_form_start,
    );

    let trigger_start = Instant::now();
    let triggers = offset_index_matches(
      &self.triggers,
      full_text,
      diagnostics.as_deref_mut(),
      DiagnosticStage::FindTrigger,
      full_text.len(),
      self.slices.triggers.start,
    )?;
    record_search_matches(
      &mut diagnostics,
      DiagnosticStage::SearchTrigger,
      &triggers,
      full_text,
      trigger_start,
    );

    let custom_regex_start = Instant::now();
    let custom_regex = offset_index_matches(
      &self.custom_regex,
      full_text,
      diagnostics.as_deref_mut(),
      DiagnosticStage::FindCustomRegex,
      full_text.len(),
      self.slices.custom_regex.start,
    )?;
    record_search_matches(
      &mut diagnostics,
      DiagnosticStage::SearchCustomRegex,
      &custom_regex,
      full_text,
      custom_regex_start,
    );

    let literal_start = Instant::now();
    let literal = normalized_index_matches(
      &self.literals,
      normalized,
      diagnostics.as_deref_mut(),
      DiagnosticStage::FindLiteral,
      full_text.len(),
      0,
    )?;
    let regex = combine_regex_matches(regex, legal_forms, triggers);
    record_search_matches(
      &mut diagnostics,
      DiagnosticStage::SearchLiteral,
      &literal,
      full_text,
      literal_start,
    );
    record_find_matches_summary(
      &mut diagnostics,
      &regex,
      &custom_regex,
      &literal,
      full_text,
      total_start,
    );

    Ok(PreparedSearchMatches {
      regex,
      custom_regex,
      literal,
    })
  }

  fn find_matches_parallel(
    &self,
    full_text: &str,
    normalized: &NormalizedSearchText,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
    total_start: Instant,
  ) -> Result<PreparedSearchMatches> {
    let input_bytes = full_text.len();
    let matches = std::thread::scope(|scope| {
      let regex = (!self.regex.is_empty()).then(|| {
        scope.spawn(|| {
          timed_offset_index_matches(
            &self.regex,
            full_text,
            DiagnosticStage::FindRegex,
            input_bytes,
            self.slices.regex.start,
          )
        })
      });
      let legal_forms = (!self.legal_forms.is_empty()).then(|| {
        scope.spawn(|| {
          timed_normalized_index_matches(
            &self.legal_forms,
            normalized,
            DiagnosticStage::FindLegalForm,
            input_bytes,
            self.slices.legal_forms.start,
          )
        })
      });
      let triggers = (!self.triggers.is_empty()).then(|| {
        scope.spawn(|| {
          timed_offset_index_matches(
            &self.triggers,
            full_text,
            DiagnosticStage::FindTrigger,
            input_bytes,
            self.slices.triggers.start,
          )
        })
      });
      let custom_regex = (!self.custom_regex.is_empty()).then(|| {
        scope.spawn(|| {
          timed_offset_index_matches(
            &self.custom_regex,
            full_text,
            DiagnosticStage::FindCustomRegex,
            input_bytes,
            self.slices.custom_regex.start,
          )
        })
      });
      let literal = (!self.literals.is_empty()).then(|| {
        scope.spawn(|| {
          timed_normalized_index_matches(
            &self.literals,
            normalized,
            DiagnosticStage::FindLiteral,
            input_bytes,
            0,
          )
        })
      });

      let regex = join_optional_timed_match_handle(regex, "regex")?;
      let legal_forms =
        join_optional_timed_match_handle(legal_forms, "legal_forms")?;
      let triggers = join_optional_timed_match_handle(triggers, "triggers")?;
      let custom_regex =
        join_optional_timed_match_handle(custom_regex, "custom_regex")?;
      let literal = join_optional_timed_match_handle(literal, "literals")?;

      Ok(finish_parallel_matches(
        &mut diagnostics,
        full_text,
        total_start,
        TimedSearchBranches {
          regex,
          legal_forms,
          triggers,
          custom_regex,
          literal,
        },
      ))
    })?;

    Ok(matches)
  }
}

fn normalize_search_text(
  full_text: &str,
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
) -> Result<NormalizedSearchText> {
  let start = Instant::now();
  let normalized = normalize_for_search_with_byte_map(full_text)?;
  if let Some(diagnostics) = diagnostics {
    diagnostics.record_stage(
      DiagnosticStage::Normalize,
      None,
      Some(elapsed_us(start)),
      Some(full_text.len()),
    );
  }
  Ok(normalized)
}

fn record_search_matches(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  stage: DiagnosticStage,
  matches: &[SearchMatch],
  full_text: &str,
  start: Instant,
) {
  if let Some(diagnostics) = diagnostics {
    diagnostics.record_search_matches(
      stage,
      matches,
      full_text,
      Some(elapsed_us(start)),
    );
  }
}

fn record_parallel_search_matches(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  stage: DiagnosticStage,
  matches: &TimedMatches,
  full_text: &str,
) {
  if let Some(diagnostics) = diagnostics {
    diagnostics.record_search_matches(
      stage,
      &matches.matches,
      full_text,
      Some(matches.elapsed_us),
    );
  }
}

fn finish_parallel_matches(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  full_text: &str,
  total_start: Instant,
  branches: TimedSearchBranches,
) -> PreparedSearchMatches {
  record_parallel_search_matches(
    diagnostics,
    DiagnosticStage::SearchRegex,
    &branches.regex,
    full_text,
  );
  record_parallel_search_matches(
    diagnostics,
    DiagnosticStage::SearchLegalForm,
    &branches.legal_forms,
    full_text,
  );
  record_parallel_search_matches(
    diagnostics,
    DiagnosticStage::SearchTrigger,
    &branches.triggers,
    full_text,
  );
  record_parallel_search_matches(
    diagnostics,
    DiagnosticStage::SearchCustomRegex,
    &branches.custom_regex,
    full_text,
  );
  record_parallel_search_matches(
    diagnostics,
    DiagnosticStage::SearchLiteral,
    &branches.literal,
    full_text,
  );

  let regex = combine_regex_matches(
    branches.regex.matches,
    branches.legal_forms.matches,
    branches.triggers.matches,
  );
  record_find_matches_summary(
    diagnostics,
    &regex,
    &branches.custom_regex.matches,
    &branches.literal.matches,
    full_text,
    total_start,
  );

  PreparedSearchMatches {
    regex,
    custom_regex: branches.custom_regex.matches,
    literal: branches.literal.matches,
  }
}

fn record_find_matches_summary(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  regex: &[SearchMatch],
  custom_regex: &[SearchMatch],
  literal: &[SearchMatch],
  full_text: &str,
  start: Instant,
) {
  let Some(diagnostics) = diagnostics else {
    return;
  };
  diagnostics.record_stage(
    DiagnosticStage::FindMatches,
    Some(
      regex
        .len()
        .saturating_add(custom_regex.len())
        .saturating_add(literal.len()),
    ),
    Some(elapsed_us(start)),
    Some(full_text.len()),
  );
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

fn offset_index_matches(
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

fn timed_offset_index_matches(
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

fn normalized_index_matches(
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

fn timed_normalized_index_matches(
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

fn combine_regex_matches(
  mut regex: Vec<SearchMatch>,
  legal_forms: Vec<SearchMatch>,
  triggers: Vec<SearchMatch>,
) -> Vec<SearchMatch> {
  regex.extend(legal_forms);
  regex.extend(triggers);
  sort_matches(&mut regex);
  regex
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

fn join_optional_timed_match_handle(
  handle: Option<std::thread::ScopedJoinHandle<'_, Result<TimedMatches>>>,
  field: &'static str,
) -> Result<TimedMatches> {
  handle.map_or_else(
    || Ok(TimedMatches::empty()),
    |handle| join_timed_match_handle(handle, field),
  )
}
