//! `legal_form_data`: ports the legal-form getters wired at
//! `build-unified-search.ts:818-849` from `detectors/legal-forms.ts` and
//! `config/legal-forms.ts`.
//!
//! Emitted whenever `nativeLegalFormSuffixes.length > 0`, i.e. when
//! `enableLegalForms` (default true), `enableTriggerPhrases`, or
//! `enableCoreference` is on. In the TypeScript source that same condition also
//! triggers `warmLegalRoleHeads()`, so every `getXSync()` accessor returns its
//! fully loaded cache (never the seed fallback) by the time the field is built;
//! this port reproduces the loaded values directly.
//!
//! NOTE: none of these getters are language-scoped. `loadLegalRoleHeads` and the
//! other loaders union every manifest language regardless of the pipeline
//! `languages`/`language` selection, so `legal_form_data` is identical for every
//! config that emits it. The language.rs helpers are therefore not used here.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;
use stella_anonymize_core::assemble::{
  AssembleError, OrderedMap, data_file, parse_data_file,
  parse_ordered_data_file,
};

use super::AssembleContext;
use crate::BindingLegalFormData;

/// `RAW_LEGAL_SUFFIXES` from `config/legal-forms.ts`. Sorted longest-first
/// (stable) at use to form `LEGAL_SUFFIXES`.
const RAW_LEGAL_SUFFIXES: &[&str] = &[
  // Czech
  "spol. s r.o.",
  "s.r.o.",
  "s. r. o.",
  "a.s.",
  "a. s.",
  "v.o.s.",
  "v. o. s.",
  "k.s.",
  "k. s.",
  "z.s.",
  "z. s.",
  "z.ú.",
  "z. ú.",
  "o.p.s.",
  "o. p. s.",
  "s.p.",
  "s. p.",
  // German / Austrian / Swiss
  "GmbH",
  "AG",
  "SE",
  "KG",
  "OHG",
  // English (UK/US/AU/IE)
  "Ltd.",
  "Ltd",
  "LTD.",
  "LTD",
  "LLC",
  "LLP",
  "Inc.",
  "INC.",
  "Inc",
  "INC",
  "Corp.",
  "CORP.",
  "Corp",
  "CORP",
  "Corporation",
  "CORPORATION",
  "Co.",
  "CO.",
  "LP",
  "L.P.",
  "PLC",
  "plc",
  "N.A.",
  "N.V.",
  "B.V.",
  "Pty Ltd.",
  "Pty Ltd",
  "PTY LTD.",
  "PTY LTD",
  // French / Iberian / Italian
  "S.A.",
  "SA",
  "SAS",
  "SARL",
  "S.p.A.",
  // Polish
  "Sp. z o.o.",
  "Sp. k.",
  "Sp. j.",
  // Brazilian / Portuguese
  "Ltda.",
  "LTDA.",
  "Ltda",
  "LTDA",
  "S/A",
  "EIRELI",
  "EPP",
  "ME",
  "MEI",
];

/// Sentence-verb seed set (`SENTENCE_VERB_INDICATORS_SEED`).
const SENTENCE_VERB_INDICATORS_SEED: &[&str] =
  &["je", "jsou", "is", "are", "ist", "sind"];

/// Clause-noun seed set (`CLAUSE_NOUN_HEADS_SEED`).
const CLAUSE_NOUN_HEADS_SEED: &[&str] = &["agreement", "contract"];

/// Language files that carry `legalRoleHeads`, in `manifest.json` declaration
/// order. Mirrors `loadLanguageConfigs("legalRoleHeads", ...)`, which is called
/// without a language filter, so all manifest languages are unioned.
fn legal_role_head_languages() -> Result<Vec<String>, AssembleError> {
  #[derive(Deserialize)]
  struct Manifest {
    languages: OrderedMap<ManifestLanguage>,
  }
  #[derive(Deserialize)]
  struct ManifestLanguage {
    #[serde(default, rename = "legalRoleHeads")]
    legal_role_heads: Option<bool>,
  }
  let manifest: Manifest = parse_data_file("manifest.json")?;
  Ok(
    manifest
      .languages
      .iter()
      .filter(|(_, lang)| lang.legal_role_heads == Some(true))
      .map(|(code, _)| code.clone())
      .collect(),
  )
}

/// JS `\s` (with the `u` flag) whitespace set, used by `normalizeLegalSuffixToken`
/// (`/[.,\s]/g`) and the in-name filter (`/\s/u`). Rust's `char::is_whitespace`
/// differs (it includes U+0085 and excludes U+FEFF), so the set is explicit.
const fn is_js_whitespace(ch: char) -> bool {
  matches!(
    ch,
    '\t'
      | '\n'
      | '\u{000B}'
      | '\u{000C}'
      | '\r'
      | ' '
      | '\u{00A0}'
      | '\u{1680}'
      | '\u{2000}'
      ..='\u{200A}'
        | '\u{2028}'
        | '\u{2029}'
        | '\u{202F}'
        | '\u{205F}'
        | '\u{3000}'
        | '\u{FEFF}'
  )
}

/// Mirrors `normalizeLegalSuffixToken`: strip `.`, `,`, and JS whitespace.
fn normalize_legal_suffix_token(suffix: &str) -> String {
  suffix
    .chars()
    .filter(|&ch| ch != '.' && ch != ',' && !is_js_whitespace(ch))
    .collect()
}

/// JS `.length`: UTF-16 code-unit count, so the longest-first sort ties break
/// identically to `Array.prototype.sort`.
fn utf16_len(value: &str) -> usize {
  value.encode_utf16().count()
}

/// `[...list].sort((a, b) => b.length - a.length)`, stable, longest-first.
fn sort_longest_first(values: &mut [String]) {
  values.sort_by_key(|value| std::cmp::Reverse(utf16_len(value)));
}

/// Pushes `value` only if unseen (mirrors JS `Set` insertion-order semantics).
fn push_unique(
  value: String,
  seen: &mut HashSet<String>,
  out: &mut Vec<String>,
) {
  if seen.insert(value.clone()) {
    out.push(value);
  }
}

/// Mirrors `LEGAL_SUFFIXES`: `RAW_LEGAL_SUFFIXES` sorted longest-first (stable).
///
/// Reused by `coreference_data` as `nativeOrganizationSuffixes`
/// (`build-unified-search.ts:816`).
pub(super) fn legal_suffixes() -> Vec<String> {
  let mut out: Vec<String> = RAW_LEGAL_SUFFIXES
    .iter()
    .map(|s| (*s).to_string())
    .collect();
  sort_longest_first(&mut out);
  out
}

/// Mirrors `getAllLegalSuffixesSync` (post-warm): flatten `legal-forms.json`
/// values (first-occurrence dedup), append `LEGAL_SUFFIXES` not already seen,
/// sort longest-first (stable).
///
/// Reused by `coreference_data` as `nativeLegalFormSuffixes` /
/// `getKnownLegalSuffixes` (`build-unified-search.ts:813`).
pub(super) fn all_legal_suffixes() -> Result<Vec<String>, AssembleError> {
  let data: OrderedMap<Value> = parse_ordered_data_file("legal-forms.json")?;
  let mut seen = HashSet::new();
  let mut out = Vec::new();
  for (_country, forms) in &data {
    let Some(forms) = forms.as_array() else {
      continue;
    };
    for form in forms {
      let Some(form) = form.as_str() else {
        continue;
      };
      if form.is_empty() {
        continue;
      }
      push_unique(form.to_string(), &mut seen, &mut out);
    }
  }
  for form in legal_suffixes() {
    push_unique(form, &mut seen, &mut out);
  }
  sort_longest_first(&mut out);
  Ok(out)
}

/// Mirrors `isBoundaryLegalSuffixForm`.
fn is_boundary_legal_suffix_form(
  form: &str,
  raw_suffix_set: &HashSet<&'static str>,
) -> bool {
  let normalized = normalize_legal_suffix_token(form);
  if normalized.is_empty() {
    return false;
  }
  if raw_suffix_set.contains(form) {
    return true;
  }
  form.contains('.') || normalized == normalized.to_uppercase()
}

/// Loads a per-language `{ "lang": [...] }`-shaped file that maps arbitrary
/// keys (skipping `_`-prefixed metadata) to string arrays, unioning every
/// value into an insertion-ordered dedup set seeded with `seed`. Mirrors the
/// `loadSentenceVerbIndicators` / `loadClauseNounHeads` /
/// `loadStructuralSingleCapPrefixes` shape.
fn load_lowercase_union(
  file: &str,
  seed: &[&str],
) -> Result<Vec<String>, AssembleError> {
  let mut dedup = HashSet::new();
  let mut out = Vec::new();
  for word in seed {
    push_unique((*word).to_string(), &mut dedup, &mut out);
  }
  let data: OrderedMap<Value> = parse_ordered_data_file(file)?;
  for (key, value) in &data {
    if key.starts_with('_') {
      continue;
    }
    let Some(words) = value.as_array() else {
      continue;
    };
    for word in words {
      let Some(word) = word.as_str() else {
        continue;
      };
      if word.is_empty() {
        continue;
      }
      push_unique(word.to_lowercase(), &mut dedup, &mut out);
    }
  }
  Ok(out)
}

/// Mirrors `getLegalRoleHeadsSync` (post-warm).
///
/// Reused by `trigger_data` as `partyPositionTerms`
/// (`build-unified-search.ts:851`).
pub(super) fn role_heads() -> Result<Vec<String>, AssembleError> {
  #[derive(Deserialize)]
  struct RoleHeads {
    #[serde(default)]
    words: Vec<String>,
  }
  let mut seen = HashSet::new();
  let mut out = Vec::new();
  for code in legal_role_head_languages()? {
    let file = format!("legal-role-heads.{code}.json");
    // Manifest may list a language the static registry cannot load; skip it
    // like `loadLanguageConfigs` skips a missing loader.
    if data_file(&file).is_none() {
      continue;
    }
    let parsed: RoleHeads = parse_data_file(&file)?;
    for word in parsed.words {
      if word.is_empty() {
        continue;
      }
      push_unique(word.to_lowercase(), &mut seen, &mut out);
    }
  }
  Ok(out)
}

/// Mirrors `getClauseNounHeadsSync` (post-warm): the `clause-noun-heads.json`
/// union seeded with `CLAUSE_NOUN_HEADS_SEED`, lowercased with insertion-order
/// dedup. Reused by `false_positive_filters` for `trailingAddressWordExclusions`.
pub(super) fn clause_noun_heads() -> Result<Vec<String>, AssembleError> {
  load_lowercase_union("clause-noun-heads.json", CLAUSE_NOUN_HEADS_SEED)
}

/// Mirrors `getConnectorProseHeadsSync` (post-warm): `generic-roles.json`
/// `roles`, lowercased, insertion-order dedup.
fn connector_prose_heads() -> Result<Vec<String>, AssembleError> {
  #[derive(Deserialize)]
  struct GenericRoles {
    #[serde(default)]
    roles: Vec<String>,
  }
  let parsed: GenericRoles = parse_data_file("generic-roles.json")?;
  let mut seen = HashSet::new();
  let mut out = Vec::new();
  for role in parsed.roles {
    if role.is_empty() {
      continue;
    }
    push_unique(role.to_lowercase(), &mut seen, &mut out);
  }
  Ok(out)
}

/// Mirrors `getLeadingClauseTrimsSync` (post-warm).
struct LeadingClauseTrims {
  phrases: Vec<String>,
  direct_prefixes: Vec<String>,
}

fn leading_clause_trims() -> Result<LeadingClauseTrims, AssembleError> {
  let data: OrderedMap<Value> =
    parse_ordered_data_file("legal-form-leading-clauses.json")?;
  let mut phrase_seen = HashSet::new();
  let mut phrases = Vec::new();
  let mut prefix_seen = HashSet::new();
  let mut direct_prefixes = Vec::new();
  for (key, value) in &data {
    if key.starts_with('_') || !value.is_object() {
      continue;
    }
    if let Some(entries) = value.get("phrases").and_then(Value::as_array) {
      for phrase in entries {
        if let Some(phrase) = phrase.as_str()
          && !phrase.is_empty()
        {
          push_unique(phrase.to_string(), &mut phrase_seen, &mut phrases);
        }
      }
    }
    if let Some(entries) = value.get("directPrefixes").and_then(Value::as_array)
    {
      for prefix in entries {
        if let Some(prefix) = prefix.as_str()
          && !prefix.is_empty()
        {
          push_unique(
            prefix.to_string(),
            &mut prefix_seen,
            &mut direct_prefixes,
          );
        }
      }
    }
  }
  Ok(LeadingClauseTrims {
    phrases,
    direct_prefixes,
  })
}

/// Copy-through arrays from `legal-form-rule-words.json`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegalFormRuleWords {
  #[serde(default)]
  connector_words: Vec<String>,
  #[serde(default)]
  and_connector_words: Vec<String>,
  #[serde(default)]
  in_name_prepositions: Vec<String>,
  #[serde(default)]
  company_suffix_words: Vec<String>,
  #[serde(default)]
  comma_gated_direct_prefixes: Vec<String>,
}

fn is_emitted(ctx: &AssembleContext<'_>) -> bool {
  let config = ctx.config;
  // `isLegalFormsEnabled`: `enableLegalForms !== false` (omitted = enabled).
  config.enable_legal_forms != Some(false)
    || config.enable_trigger_phrases
    || config.enable_coreference
}

/// # Errors
///
/// Returns [`AssembleError`] when any embedded legal-form data file fails to
/// parse.
pub(super) fn build_legal_form_data(
  ctx: &AssembleContext<'_>,
) -> Result<Option<BindingLegalFormData>, AssembleError> {
  if !is_emitted(ctx) {
    return Ok(None);
  }

  let suffixes = all_legal_suffixes()?;
  let raw_suffix_set: HashSet<&'static str> =
    RAW_LEGAL_SUFFIXES.iter().copied().collect();

  // normalized_boundary_suffixes: boundary forms, normalized, nonempty, deduped.
  let mut boundary_seen = HashSet::new();
  let mut normalized_boundary_suffixes = Vec::new();
  // normalized_in_name_words: non-boundary, whitespace-free forms.
  let mut in_name_seen = HashSet::new();
  let mut normalized_in_name_words = Vec::new();
  for form in &suffixes {
    let boundary = is_boundary_legal_suffix_form(form, &raw_suffix_set);
    let normalized = normalize_legal_suffix_token(form);
    if normalized.is_empty() {
      continue;
    }
    if boundary {
      push_unique(
        normalized,
        &mut boundary_seen,
        &mut normalized_boundary_suffixes,
      );
    } else if !form.chars().any(is_js_whitespace) {
      push_unique(normalized, &mut in_name_seen, &mut normalized_in_name_words);
    }
  }

  // normalized_suffix_words: map+filter over the suffixes, WITHOUT dedup.
  let normalized_suffix_words: Vec<String> = suffixes
    .iter()
    .map(|suffix| normalize_legal_suffix_token(suffix).to_lowercase())
    .filter(|suffix| !suffix.is_empty())
    .collect();

  let trims = leading_clause_trims()?;
  let rule_words: LegalFormRuleWords =
    parse_data_file("legal-form-rule-words.json")?;

  Ok(Some(BindingLegalFormData {
    suffixes,
    normalized_boundary_suffixes,
    normalized_in_name_words,
    normalized_suffix_words,
    role_heads: role_heads()?,
    sentence_verb_indicators: load_lowercase_union(
      "sentence-verb-indicators.json",
      SENTENCE_VERB_INDICATORS_SEED,
    )?,
    clause_noun_heads: load_lowercase_union(
      "clause-noun-heads.json",
      CLAUSE_NOUN_HEADS_SEED,
    )?,
    connector_prose_heads: connector_prose_heads()?,
    structural_single_cap_prefixes: load_lowercase_union(
      "structural-single-cap-prefixes.json",
      &[],
    )?,
    leading_clause_phrases: trims.phrases,
    leading_clause_direct_prefixes: trims.direct_prefixes,
    connector_words: rule_words.connector_words,
    and_connector_words: rule_words.and_connector_words,
    in_name_prepositions: rule_words.in_name_prepositions,
    company_suffix_words: rule_words.company_suffix_words,
    comma_gated_direct_prefixes: rule_words.comma_gated_direct_prefixes,
  }))
}
