//! `monetary_data`: ports `getMonetaryData` / `loadMonetaryData`
//! (`detectors/regex.ts`).
//!
//! Pure copy-through of `currencies.json` and `amount-words.json` with the
//! camelCase-to-snake_case key rename the TypeScript loader performs. Emitted
//! when `enableTriggerPhrases` is on or the "monetary amount" regex is active.

use serde::Deserialize;
use stella_anonymize_core::assemble::{AssembleError, parse_data_file};

use super::AssembleContext;
use crate::{
  BindingAmountWordsData, BindingCurrencyData, BindingMagnitudeSuffixData,
  BindingMonetaryData, BindingShareQuantityTermData,
  BindingWrittenAmountPatternData,
};

#[derive(Deserialize)]
struct CurrenciesData {
  #[serde(default)]
  codes: Vec<String>,
  #[serde(default)]
  symbols: Vec<String>,
  #[serde(rename = "localNames", default)]
  local_names: Vec<String>,
}

#[derive(Deserialize)]
struct AmountWordsData {
  #[serde(default)]
  patterns: Vec<WrittenAmountPattern>,
  #[serde(rename = "magnitudeSuffixes", default)]
  magnitude_suffixes: Vec<MagnitudeSuffix>,
  #[serde(rename = "shareQuantityTerms", default)]
  share_quantity_terms: Vec<ShareQuantityTerm>,
}

#[derive(Deserialize)]
struct WrittenAmountPattern {
  #[serde(default)]
  keywords: Vec<String>,
}

#[derive(Deserialize)]
struct MagnitudeSuffix {
  #[serde(default)]
  words: Vec<String>,
  #[serde(rename = "abbreviationsCaseInsensitive", default)]
  abbreviations_case_insensitive: Vec<String>,
  #[serde(rename = "abbreviationsCaseSensitive", default)]
  abbreviations_case_sensitive: Vec<String>,
}

#[derive(Deserialize)]
struct ShareQuantityTerm {
  #[serde(default)]
  modifiers: Vec<String>,
  #[serde(default)]
  nouns: Vec<String>,
}

/// # Errors
///
/// Returns [`AssembleError`] when `currencies.json` or `amount-words.json`
/// fails to parse.
pub(super) fn build_monetary_data(
  ctx: &AssembleContext<'_>,
) -> Result<Option<BindingMonetaryData>, AssembleError> {
  if !(ctx.enable_trigger_phrases() || ctx.regex_monetary_enabled()) {
    return Ok(None);
  }
  let currencies: CurrenciesData = parse_data_file("currencies.json")?;
  let amount_words: AmountWordsData = parse_data_file("amount-words.json")?;

  Ok(Some(BindingMonetaryData {
    currencies: BindingCurrencyData {
      codes: currencies.codes,
      symbols: currencies.symbols,
      local_names: currencies.local_names,
    },
    amount_words: BindingAmountWordsData {
      written_amount_patterns: amount_words
        .patterns
        .into_iter()
        .map(|entry| BindingWrittenAmountPatternData {
          keywords: entry.keywords,
        })
        .collect(),
      magnitude_suffixes: amount_words
        .magnitude_suffixes
        .into_iter()
        .map(|entry| BindingMagnitudeSuffixData {
          words: entry.words,
          abbreviations_case_insensitive: entry.abbreviations_case_insensitive,
          abbreviations_case_sensitive: entry.abbreviations_case_sensitive,
        })
        .collect(),
      share_quantity_terms: amount_words
        .share_quantity_terms
        .into_iter()
        .map(|entry| BindingShareQuantityTermData {
          modifiers: entry.modifiers,
          nouns: entry.nouns,
        })
        .collect(),
    },
  }))
}
