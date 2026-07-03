//! `coreference_data`: ports `buildNativeCoreferenceData`
//! (`build-unified-search.ts:1868`) plus the `legal_form_aliases` /
//! `organization_suffixes` injection applied at the call site
//! (`build-unified-search.ts:1070-1077`).
//!
//! Emitted whenever `config.enableCoreference` is set (the source only builds
//! `coreferenceData` in that branch, `build-unified-search.ts:797`).
//!
//! # Fields
//!
//! - `definition_patterns`: `coreference.<lang>.json` rows in
//!   `loadLanguageConfigs` order (manifest declaration order, filtered by the
//!   content-language selection).
//! - `role_stop_terms`: `generic-roles.json` `roles`, verbatim (unlike
//!   `connector_prose_heads`, these are NOT lowercased).
//! - `legal_form_aliases`: `getKnownLegalSuffixes()` = `getAllLegalSuffixesSync`
//!   (reuses [`super::legal_forms::all_legal_suffixes`]).
//! - `organization_suffixes`: `LEGAL_SUFFIXES` (reuses
//!   [`super::legal_forms::legal_suffixes`]).
//! - `organization_determiners`: the matching determiner fragments sorted by
//!   `String.prototype.localeCompare`. See the module-local note on that sort.

use serde::Deserialize;
use stella_anonymize_core::assemble::{
  AssembleError, OrderedMap, data_file, parse_data_file,
  parse_ordered_data_file,
};

use super::language::language_config_matches;
use super::{AssembleContext, legal_forms};
use crate::{BindingCoreferenceData, BindingCoreferencePatternData};

/// Languages carrying `coreference` rules, in `manifest.json` declaration
/// order (mirrors `loadLanguageConfigs("coreference", ...)`).
fn coreference_languages() -> Result<Vec<String>, AssembleError> {
  #[derive(Deserialize)]
  struct Manifest {
    languages: OrderedMap<ManifestLanguage>,
  }
  #[derive(Deserialize)]
  struct ManifestLanguage {
    #[serde(default)]
    coreference: Option<bool>,
  }
  let manifest: Manifest = parse_data_file("manifest.json")?;
  Ok(
    manifest
      .languages
      .iter()
      .filter(|(_, lang)| lang.coreference == Some(true))
      .map(|(code, _)| code.clone())
      .collect(),
  )
}

/// One row of a `coreference.<lang>.json` config.
#[derive(Deserialize)]
struct CoreferenceRow {
  pattern: String,
  #[serde(default)]
  flags: String,
}

/// Mirrors the `definitionPatterns` accumulation: for every coreference
/// language that matches the selection (manifest order), append each row.
fn definition_patterns(
  selected: Option<&[String]>,
) -> Result<Vec<BindingCoreferencePatternData>, AssembleError> {
  let mut patterns = Vec::new();
  for code in coreference_languages()? {
    if !language_config_matches(&code, selected) {
      continue;
    }
    let file = format!("coreference.{code}.json");
    // Skip a manifest language the static registry cannot load, mirroring the
    // missing-loader skip in `loadLanguageConfigs`.
    if data_file(&file).is_none() {
      continue;
    }
    let rows: Vec<CoreferenceRow> = parse_data_file(&file)?;
    for row in rows {
      patterns.push(BindingCoreferencePatternData {
        pattern: row.pattern,
        flags: row.flags,
      });
    }
  }
  Ok(patterns)
}

/// `generic-roles.json` `roles`, verbatim (the coreference field keeps original
/// casing; only `connector_prose_heads` lowercases them).
fn role_stop_terms() -> Result<Vec<String>, AssembleError> {
  #[derive(Deserialize)]
  struct GenericRoles {
    #[serde(default)]
    roles: Vec<String>,
  }
  let parsed: GenericRoles = parse_data_file("generic-roles.json")?;
  Ok(parsed.roles)
}

/// Canonical `localeCompare` order of the organization-determiner fragments.
///
/// `organization_determiners` is
/// `Object.entries(coreference-org-determiners.json).flatMap(...).toSorted(localeCompare)`.
/// The fragments are NOT ASCII-only (they contain `société`, `společnost`), so
/// the JS default-locale collation cannot be reduced to a UTF-16 code-unit sort.
/// Instead the exact ICU order is captured here from Node's `localeCompare`
/// (verified against the `baseline-all-on` fixture). Because `localeCompare` is
/// a total order, filtering by language selection and re-sorting is equivalent
/// to ranking the matching fragments by their position in this list.
///
/// [`assert_determiner_canary`] fails if the data file ever diverges from this
/// captured set, so a data change cannot silently reorder the port.
const DETERMINER_LOCALE_ORDER: &[&str] = &[
  r"die\s+(?:gesellschaft|firma)",
  r"el\s+(?:empresa|sociedad)",
  r"la\s+(?:empresa|sociedad)",
  r"la\s+société",
  r"spolecnost(?:i|em|u)?",
  r"společnost(?:i|í|em|u)?",
  r"the\s+(?:company|corporation|firm)",
];

/// Rank of a determiner fragment in [`DETERMINER_LOCALE_ORDER`]. Fragments not
/// present sort last (the canary guarantees this never happens for real data).
fn determiner_rank(value: &str) -> usize {
  DETERMINER_LOCALE_ORDER
    .iter()
    .position(|entry| *entry == value)
    .unwrap_or(DETERMINER_LOCALE_ORDER.len())
}

/// Guards against silent drift: every value in the determiner data file must be
/// covered by [`DETERMINER_LOCALE_ORDER`]. If the data changes, this fails so
/// the captured `localeCompare` order is re-derived rather than diverging.
fn assert_determiner_canary(
  data: &OrderedMap<serde_json::Value>,
) -> Result<(), AssembleError> {
  for (language, values) in data {
    if language.starts_with('_') {
      continue;
    }
    let Some(values) = values.as_array() else {
      continue;
    };
    for value in values {
      let Some(value) = value.as_str() else {
        continue;
      };
      if !DETERMINER_LOCALE_ORDER.contains(&value) {
        return Err(AssembleError::DataParse {
          name: "coreference-org-determiners.json".to_string(),
          message: format!(
            "determiner fragment {value:?} is not covered by the captured \
             localeCompare order; re-derive DETERMINER_LOCALE_ORDER"
          ),
        });
      }
    }
  }
  Ok(())
}

/// Mirrors the `organization_determiners` builder: flatten every language entry
/// that matches the selection (skipping `_comment`), then sort by
/// `localeCompare`.
fn organization_determiners(
  selected: Option<&[String]>,
) -> Result<Vec<String>, AssembleError> {
  let data: OrderedMap<serde_json::Value> =
    parse_ordered_data_file("coreference-org-determiners.json")?;
  assert_determiner_canary(&data)?;
  let mut values = Vec::new();
  for (language, entries) in &data {
    if language == "_comment" {
      continue;
    }
    let Some(entries) = entries.as_array() else {
      continue;
    };
    if !language_config_matches(language, selected) {
      continue;
    }
    for entry in entries {
      if let Some(entry) = entry.as_str() {
        values.push(entry.to_string());
      }
    }
  }
  values.sort_by_key(|value| determiner_rank(value));
  Ok(values)
}

/// # Errors
///
/// Returns [`AssembleError`] when any embedded coreference data file fails to
/// parse, or when the determiner canary trips.
pub(super) fn build_coreference_data(
  ctx: &AssembleContext<'_>,
) -> Result<Option<BindingCoreferenceData>, AssembleError> {
  if !ctx.config.enable_coreference {
    return Ok(None);
  }
  let selected = ctx.content_languages.as_deref();
  Ok(Some(BindingCoreferenceData {
    definition_patterns: definition_patterns(selected)?,
    role_stop_terms: role_stop_terms()?,
    legal_form_aliases: legal_forms::all_legal_suffixes()?,
    organization_suffixes: legal_forms::legal_suffixes(),
    organization_determiners: organization_determiners(selected)?,
  }))
}
