//! `zone_data`: ports `buildNativeZoneData` (`build-unified-search.ts`).
//!
//! Section-heading patterns copy through unfiltered; signing clauses are scoped
//! to the content languages via `signingClauseLanguageMatches`. Emitted only
//! when `enableZoneClassification` is truthy.

use serde::Deserialize;
use stella_anonymize_core::assemble::{AssembleError, parse_data_file};

use super::AssembleContext;
use super::language::signing_clause_language_matches;
use crate::{
  BindingZoneData, BindingZonePatternData, BindingZoneSigningClauseData,
};

#[derive(Deserialize)]
struct SectionHeadings {
  #[serde(default)]
  patterns: Vec<HeadingPattern>,
}

#[derive(Deserialize)]
struct HeadingPattern {
  re: String,
  #[serde(default)]
  flags: String,
}

#[derive(Deserialize)]
struct SigningClauses {
  #[serde(default)]
  patterns: Vec<SigningClausePattern>,
}

#[derive(Deserialize)]
struct SigningClausePattern {
  #[serde(default)]
  lang: String,
  #[serde(default)]
  prefix: String,
  #[serde(default)]
  suffix: String,
  #[serde(default)]
  prepositions: Vec<String>,
}

/// # Errors
///
/// Returns [`AssembleError`] when `section-headings.json` or
/// `signing-clauses.json` fails to parse.
pub(super) fn build_zone_data(
  ctx: &AssembleContext<'_>,
) -> Result<Option<BindingZoneData>, AssembleError> {
  if ctx.config.enable_zone_classification != Some(true) {
    return Ok(None);
  }
  let headings: SectionHeadings = parse_data_file("section-headings.json")?;
  let signing: SigningClauses = parse_data_file("signing-clauses.json")?;
  let languages = ctx.content_languages.as_deref();

  Ok(Some(BindingZoneData {
    section_heading_patterns: headings
      .patterns
      .into_iter()
      .map(|pattern| BindingZonePatternData {
        pattern: pattern.re,
        flags: pattern.flags,
      })
      .collect(),
    signing_clauses: signing
      .patterns
      .into_iter()
      .filter(|pattern| {
        signing_clause_language_matches(&pattern.lang, languages)
      })
      .map(|pattern| BindingZoneSigningClauseData {
        prefix: pattern.prefix,
        suffix: pattern.suffix,
        prepositions: pattern.prepositions,
      })
      .collect(),
  }))
}
