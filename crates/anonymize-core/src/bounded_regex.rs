//! Single construction point for backtracking-capable regex patterns.
//!
//! Every pattern that can reach a backtracking engine (today: the trigger
//! `match-pattern` strategy, whose patterns come from configuration) must be
//! built through [`BoundedRegex`] and nowhere else. Construction first tries
//! the linear-time `regex` engine, which cannot backtrack by construction;
//! only patterns the linear engine rejects — lookaround, backreferences —
//! fall back to `fancy_regex`, built with an explicit backtrack limit so a
//! pathological pattern/input pair fails with a typed error instead of
//! burning unbounded CPU.

use std::ops::Range;

use crate::types::{Error, Result, SearchEngine};

/// Maximum backtracking steps for the `fancy_regex` fallback.
///
/// Match-pattern haystacks are bounded to a single line of at most
/// `MATCH_PATTERN_LOOKAHEAD` (512) UTF-16 units before they reach the
/// engine, so even a full quadratic backtracking pass over the window costs
/// about 512 * 512 = 262,144 steps. Half a million covers that whole-window
/// quadratic worst case with headroom — the corpus lookaround patterns
/// (bounded-quantifier IBAN shapes) stay orders of magnitude below it —
/// while sitting at half of `fancy_regex`'s default (1,000,000) so
/// exponential pattern/input pairs are cut off sooner.
const BACKTRACK_LIMIT: usize = 500_000;

/// A compiled pattern that is either linear-time by construction or
/// backtracking with an explicit step budget.
#[derive(Clone, Debug)]
pub(crate) enum BoundedRegex {
  Linear(regex::Regex),
  Backtracking(fancy_regex::Regex),
}

impl BoundedRegex {
  /// Compiles `source`, preferring the linear engine.
  ///
  /// # Errors
  ///
  /// Returns [`Error::Search`] when the pattern is invalid in both engines.
  pub(crate) fn new(source: &str) -> Result<Self> {
    if let Ok(regex) = regex::Regex::new(source) {
      return Ok(Self::Linear(regex));
    }
    let regex = fancy_regex::RegexBuilder::new(source)
      .backtrack_limit(BACKTRACK_LIMIT)
      .build()
      .map_err(|error| Error::Search {
        engine: SearchEngine::Regex,
        reason: error.to_string(),
      })?;
    Ok(Self::Backtracking(regex))
  }

  /// Finds the first match in `haystack`.
  ///
  /// # Errors
  ///
  /// Returns [`Error::Search`] when the backtracking engine exceeds its
  /// step budget (the linear arm cannot fail).
  pub(crate) fn find(&self, haystack: &str) -> Result<Option<Range<usize>>> {
    match self {
      Self::Linear(regex) => {
        Ok(regex.find(haystack).map(|found| found.range()))
      }
      Self::Backtracking(regex) => regex
        .find(haystack)
        .map(|found| found.map(|matched| matched.range()))
        .map_err(|error| Error::Search {
          engine: SearchEngine::Regex,
          reason: error.to_string(),
        }),
    }
  }
}

#[cfg(test)]
mod tests {
  #![allow(clippy::expect_used)]

  use super::*;

  #[test]
  fn plain_patterns_route_to_the_linear_engine() {
    let regex =
      BoundedRegex::new(r"[a-z]+\d{2}").expect("plain pattern compiles");
    assert!(matches!(regex, BoundedRegex::Linear(_)));
    assert_eq!(
      regex.find("abc12").expect("linear find cannot fail"),
      Some(0..5)
    );
  }

  #[test]
  fn lookaround_patterns_route_to_the_bounded_backtracker() {
    let regex =
      BoundedRegex::new(r"foo(?=bar)").expect("lookaround pattern compiles");
    assert!(matches!(regex, BoundedRegex::Backtracking(_)));
    assert_eq!(regex.find("xfoobar").expect("within budget"), Some(1..4));
    assert_eq!(regex.find("xfoobaz").expect("within budget"), None);
  }

  #[test]
  fn corpus_iban_lookahead_pattern_matches_through_the_wrapper() {
    // The German IBAN trigger pattern is the corpus's lookaround user of
    // the backtracking arm; it must match identically through the wrapper.
    let regex = BoundedRegex::new(
      r"\b[A-Z]{2}\d{2}(?=(?:\s?[\dA-Z]){11,30}\b)(?:\s?[\dA-Z]{1,4}){3,8}\b",
    )
    .expect("corpus pattern compiles");
    assert!(matches!(regex, BoundedRegex::Backtracking(_)));
    let haystack = "IBAN: DE89 3704 0044 0532 0130 00";
    assert_eq!(
      regex.find(haystack).expect("well within the budget"),
      Some(6..haystack.len())
    );
  }

  #[test]
  fn corpus_phone_pattern_routes_linear_and_matches() {
    // The global phone trigger pattern has no fancy syntax; it must ride
    // the linear engine and still match the same span.
    let regex = BoundedRegex::new(
      r"(?:\+\d{1,3}[\s.\-]?)?\(?\d{1,4}\)?(?:[\s.\-]\d{1,4}){2,4}",
    )
    .expect("corpus pattern compiles");
    assert!(matches!(regex, BoundedRegex::Linear(_)));
    assert_eq!(
      regex.find("call +420 604 123 456 now").expect("linear"),
      Some(5..21)
    );
  }

  #[test]
  fn catastrophic_backtracking_errors_out_instead_of_hanging() {
    // A backreference forces the whole match onto the backtracking VM (a
    // pure `(a+)+` is otherwise lowered to the linear engine), and the
    // nested quantifier makes the partitioning search exponential against
    // a long non-matching tail. The step budget must turn it into a typed
    // error quickly instead of hanging.
    let regex =
      BoundedRegex::new(r"(a+)+\1$").expect("pathological pattern compiles");
    assert!(matches!(regex, BoundedRegex::Backtracking(_)));
    let haystack = format!("{}c", "a".repeat(40));
    let error = regex
      .find(&haystack)
      .expect_err("the backtrack budget must trip");
    assert!(
      matches!(error, Error::Search { .. }),
      "budget exhaustion must surface as the typed search error"
    );
  }
}
