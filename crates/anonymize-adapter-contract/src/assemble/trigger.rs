//! `trigger_data`: ports `buildTriggerPatterns` (`detectors/triggers.ts:426`)
//! and the trigger-support members wired at `build-unified-search.ts:1509`.
//!
//! Emitted whenever `triggerRules.length > 0`, which happens exactly when
//! `config.enableTriggerPhrases` is set (the source builds `triggerRules` only
//! in that branch, `build-unified-search.ts:751`, and the loaded rule set is
//! always non-empty).
//!
//! # Rule ordering (index-exact, positional prepare)
//!
//! `rules` is the concatenation, in order, of:
//! 1. `expandTriggerGroups(triggers.<lang>.json)` for every trigger language in
//!    `manifest.json` declaration order that matches the content-language
//!    selection (mirrors `loadLanguageConfigs("triggers", ...)`);
//! 2. `expandTriggerGroups(triggers.global.json)`;
//! 3. the synthesized year-word date triggers.
//!
//! # Support members
//!
//! - `address_stop_keywords`: `getAddressStopKeywordsSync()` after warm-up.
//! - `party_position_terms`: `getLegalRoleHeadsSync()`
//!   ([`super::legal_forms::role_heads`]).
//! - `post_nominals`: the static `POST_NOMINALS` table.
//! - `sentence_terminal_currency_terms`:
//!   [`super::monetary::sentence_terminal_currency_terms`].
//! - `phone_extension_labels` / `number_markers` / `number_labels`:
//!   `languageKeyedTerms(TRIGGER_SUPPORT.<field>, contentLanguages)`.
//!
//! The Rust binding-to-core conversion injects `legal_form_suffixes` into the
//! core trigger data from `legal_form_data` (`lib.rs`), so the binding-level
//! `trigger_data` this assembler produces intentionally carries no such field.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;
use stella_anonymize_core::assemble::{
  AssembleError, OrderedMap, data_file, parse_data_file,
  parse_ordered_data_file,
};

use super::js::{canonical_regexp_flags, escape_regexp_source, utf16_len};
use super::language::{language_config_matches, language_keyed_terms};
use super::{AssembleContext, legal_forms, monetary};
use crate::{
  BindingTriggerData, BindingTriggerRule, BindingTriggerStrategy,
  BindingTriggerValidation,
};

/// `POST_NOMINALS` from `config/titles.ts`, in declaration order.
const POST_NOMINALS: &[&str] = &[
  "Ph.D.", "Ph.D", "CSc.", "DrSc.", "ArtD.", "D.Phil.", "DPhil.", "MPhil.",
  "MBA", "MPA", "LL.M.", "LL.B.", "M.Sc.", "B.Sc.", "MSc.", "BSc.", "M.Eng.",
  "B.Eng.", "M.A.", "B.A.", "JCD", "JD", "DiS.", "ACCA", "FCCA", "CIPM",
  "CIPT", "CIPP/E", "CIPP", "KC", "QC",
];

/// `ADDRESS_STOP_KEYWORDS_SEED` from `detectors/triggers.ts`.
const ADDRESS_STOP_KEYWORDS_SEED: &[&str] = &[
  "číslo účtu",
  "registrační",
  "zastoupen",
  "bankovní",
  "e-mail",
  "telefon",
  "jednatel",
  "ředitel",
  "datová",
  "vložka",
  "sp.zn.",
  "oddíl",
  "swift",
  "email",
  "iban",
  "dič",
  "ičo",
  "tel",
  "č.ú.",
  "bic",
  "ič",
];

/// A trigger group config row from `triggers.<lang>.json` / global.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TriggerGroupConfig {
  #[serde(default)]
  triggers: Vec<String>,
  label: String,
  strategy: StrategyConfig,
  #[serde(default)]
  validations: Vec<ValidationConfig>,
  #[serde(default)]
  extensions: Vec<String>,
  #[serde(default)]
  include_trigger: Option<bool>,
}

/// Strategy config as spelled in the JSON (camelCase fields, kebab `type`).
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum StrategyConfig {
  ToNextComma {
    #[serde(rename = "stopWords")]
    stop_words: Option<Vec<String>>,
    #[serde(rename = "maxLength")]
    max_length: Option<u32>,
  },
  ToEndOfLine,
  NWords {
    count: u32,
  },
  CompanyIdValue,
  Address {
    #[serde(rename = "maxChars")]
    max_chars: Option<u32>,
  },
  MatchPattern {
    pattern: String,
    flags: Option<String>,
  },
}

/// Validation config as spelled in the JSON.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ValidationConfig {
  StartsUppercase,
  MinLength {
    min: u32,
  },
  MaxLength {
    max: u32,
  },
  NoDigits,
  HasDigits,
  MatchesPattern {
    pattern: String,
    flags: Option<String>,
  },
  ValidId {
    validator: String,
  },
}

/// Mirrors `toNativeTriggerStrategy`.
fn to_native_strategy(strategy: StrategyConfig) -> BindingTriggerStrategy {
  match strategy {
    StrategyConfig::ToNextComma {
      stop_words,
      max_length,
    } => BindingTriggerStrategy::ToNextComma {
      stop_words: stop_words.unwrap_or_default(),
      max_length,
    },
    StrategyConfig::ToEndOfLine => BindingTriggerStrategy::ToEndOfLine,
    StrategyConfig::NWords { count } => {
      BindingTriggerStrategy::NWords { count }
    }
    StrategyConfig::CompanyIdValue => BindingTriggerStrategy::CompanyIdValue,
    StrategyConfig::Address { max_chars } => {
      BindingTriggerStrategy::Address { max_chars }
    }
    StrategyConfig::MatchPattern { pattern, flags } => {
      BindingTriggerStrategy::MatchPattern { pattern, flags }
    }
  }
}

/// Mirrors `compileValidations` + `toNativeTriggerValidation`: `matches-pattern`
/// carries the compiled `RegExp.source` (with `/` escaping) and canonical flags
/// (g/y stripped); every other validation maps straight through.
fn to_native_validation(
  validation: ValidationConfig,
) -> BindingTriggerValidation {
  match validation {
    ValidationConfig::StartsUppercase => {
      BindingTriggerValidation::StartsUppercase
    }
    ValidationConfig::MinLength { min } => {
      BindingTriggerValidation::MinLength { min }
    }
    ValidationConfig::MaxLength { max } => {
      BindingTriggerValidation::MaxLength { max }
    }
    ValidationConfig::NoDigits => BindingTriggerValidation::NoDigits,
    ValidationConfig::HasDigits => BindingTriggerValidation::HasDigits,
    ValidationConfig::MatchesPattern { pattern, flags } => {
      let canonical = canonical_regexp_flags(flags.as_deref().unwrap_or(""));
      BindingTriggerValidation::MatchesPattern {
        pattern: escape_regexp_source(&pattern),
        flags: (!canonical.is_empty()).then_some(canonical),
      }
    }
    ValidationConfig::ValidId { validator } => {
      BindingTriggerValidation::ValidId { validator }
    }
  }
}

/// Mirrors `expandTriggerGroups`: base triggers first (deduped), then the
/// extension variants added per base trigger in loop order.
fn expand_trigger_groups(
  groups: Vec<TriggerGroupConfig>,
  rules: &mut Vec<BindingTriggerRule>,
) {
  for group in groups {
    let include_trigger = group.include_trigger.unwrap_or(false);
    let strategy = to_native_strategy(group.strategy);
    let validations: Vec<BindingTriggerValidation> = group
      .validations
      .into_iter()
      .map(to_native_validation)
      .collect();

    let mut order: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut add = |value: String| {
      if seen.insert(value.clone()) {
        order.push(value);
      }
    };
    for trigger in &group.triggers {
      add(trigger.clone());
    }
    let has = |ext: &str| group.extensions.iter().any(|entry| entry == ext);
    for trigger in &group.triggers {
      if has("add-colon") && !trigger.ends_with(':') {
        add(format!("{trigger}:"));
      }
      if has("add-trailing-space") && !trigger.ends_with(' ') {
        add(format!("{trigger} "));
      }
      if has("add-colon-space")
        && !trigger.ends_with(": ")
        && !trigger.ends_with(':')
      {
        add(format!("{trigger}: "));
      }
      if has("normalize-spaces") && trigger.contains(' ') {
        add(trigger.replace(' ', "\u{00A0}"));
      }
    }

    for trigger in order {
      rules.push(BindingTriggerRule {
        trigger,
        label: group.label.clone(),
        strategy: strategy.clone(),
        validations: validations.clone(),
        include_trigger,
      });
    }
  }
}

/// Trigger languages in `manifest.json` declaration order.
fn trigger_languages() -> Result<Vec<String>, AssembleError> {
  #[derive(Deserialize)]
  struct Manifest {
    languages: OrderedMap<ManifestLanguage>,
  }
  #[derive(Deserialize)]
  struct ManifestLanguage {
    #[serde(default)]
    triggers: Option<bool>,
  }
  let manifest: Manifest = parse_data_file("manifest.json")?;
  Ok(
    manifest
      .languages
      .iter()
      .filter(|(_, lang)| lang.triggers == Some(true))
      .map(|(code, _)| code.clone())
      .collect(),
  )
}

/// Mirrors the year-word synthesis: for every language entry that matches the
/// selection, add an `n-words` date trigger per word, deduped by lowercase
/// across the whole `year-words.json` file.
fn push_year_word_rules(
  selected: Option<&[String]>,
  rules: &mut Vec<BindingTriggerRule>,
) -> Result<(), AssembleError> {
  let data: OrderedMap<Value> = parse_ordered_data_file("year-words.json")?;
  let validation = ValidationConfig::MatchesPattern {
    pattern: r"^(?:19|20)\d{2}\.?$".to_string(),
    flags: None,
  };
  let native_validation = to_native_validation(validation);
  let mut seen = HashSet::new();
  for (key, words) in &data {
    if key.starts_with('_') {
      continue;
    }
    let Some(words) = words.as_array() else {
      continue;
    };
    if !language_config_matches(key, selected) {
      continue;
    }
    for word in words {
      let Some(word) = word.as_str() else {
        continue;
      };
      if !seen.insert(word.to_lowercase()) {
        continue;
      }
      rules.push(BindingTriggerRule {
        trigger: word.to_string(),
        label: "date".to_string(),
        strategy: BindingTriggerStrategy::NWords { count: 1 },
        validations: vec![native_validation.clone()],
        include_trigger: false,
      });
    }
  }
  Ok(())
}

/// Mirrors `buildTriggerPatterns(...).rules`.
///
/// Exposed so the `regex_patterns` tail (trigger literals) and `trigger_data`
/// share one rule build, mirroring the single `sources.triggers` the
/// TypeScript source threads into both.
pub(super) fn build_trigger_rules(
  selected: Option<&[String]>,
) -> Result<Vec<BindingTriggerRule>, AssembleError> {
  let mut rules = Vec::new();
  for code in trigger_languages()? {
    if !language_config_matches(&code, selected) {
      continue;
    }
    let file = format!("triggers.{code}.json");
    if data_file(&file).is_none() {
      continue;
    }
    let groups: Vec<TriggerGroupConfig> = parse_data_file(&file)?;
    expand_trigger_groups(groups, &mut rules);
  }
  let global: Vec<TriggerGroupConfig> =
    parse_data_file("triggers.global.json")?;
  expand_trigger_groups(global, &mut rules);
  push_year_word_rules(selected, &mut rules)?;
  Ok(rules)
}

/// Mirrors `getAddressStopKeywordsSync()` after `loadAddressStopKeywords`:
/// union every non-`_` array from `address-stop-keywords.json` (lowercased,
/// first-occurrence dedup), append the seed, then stable longest-first sort.
fn address_stop_keywords() -> Result<Vec<String>, AssembleError> {
  let data: OrderedMap<Value> =
    parse_ordered_data_file("address-stop-keywords.json")?;
  let mut seen = HashSet::new();
  let mut out = Vec::new();
  let add =
    |value: &str, dedup: &mut HashSet<String>, acc: &mut Vec<String>| {
      if value.is_empty() {
        return;
      }
      let lower = value.to_lowercase();
      if dedup.insert(lower.clone()) {
        acc.push(lower);
      }
    };
  for (key, values) in &data {
    if key.starts_with('_') {
      continue;
    }
    let Some(values) = values.as_array() else {
      continue;
    };
    for value in values {
      if let Some(value) = value.as_str() {
        add(value, &mut seen, &mut out);
      }
    }
  }
  for value in ADDRESS_STOP_KEYWORDS_SEED {
    add(value, &mut seen, &mut out);
  }
  // `out.sort((a, b) => b.length - a.length)`: stable longest-first by UTF-16
  // length.
  out.sort_by_key(|value| std::cmp::Reverse(utf16_len(value)));
  Ok(out)
}

/// Loads a `TRIGGER_SUPPORT.<field>` map (`trigger-support.json`).
fn trigger_support_field(
  field: &str,
  selected: Option<&[String]>,
) -> Result<Vec<String>, AssembleError> {
  #[derive(Deserialize)]
  struct TriggerSupport {
    #[serde(rename = "phoneExtensionLabels", default)]
    phone_extension_labels: OrderedMap<Value>,
    #[serde(rename = "numberMarkers", default)]
    number_markers: OrderedMap<Value>,
    #[serde(rename = "numberLabels", default)]
    number_labels: OrderedMap<Value>,
  }
  let support: TriggerSupport = parse_data_file("trigger-support.json")?;
  let map = match field {
    "phoneExtensionLabels" => &support.phone_extension_labels,
    "numberMarkers" => &support.number_markers,
    _ => &support.number_labels,
  };
  Ok(language_keyed_terms(map, selected))
}

/// Builds `trigger_data` from the shared trigger rules.
///
/// Mirrors the `if (triggerRules.length > 0)` guard: an empty rule set (only
/// possible when trigger phrases are disabled) omits the field.
///
/// # Errors
///
/// Returns [`AssembleError`] when any embedded trigger-support data file fails
/// to parse.
pub(super) fn build_trigger_data(
  ctx: &AssembleContext<'_>,
  rules: Vec<BindingTriggerRule>,
) -> Result<Option<BindingTriggerData>, AssembleError> {
  if rules.is_empty() {
    return Ok(None);
  }
  let selected = ctx.content_languages.as_deref();
  Ok(Some(BindingTriggerData {
    rules,
    address_stop_keywords: address_stop_keywords()?,
    party_position_terms: legal_forms::role_heads()?,
    post_nominals: POST_NOMINALS.iter().map(|s| (*s).to_string()).collect(),
    sentence_terminal_currency_terms:
      monetary::sentence_terminal_currency_terms(ctx)?,
    phone_extension_labels: trigger_support_field(
      "phoneExtensionLabels",
      selected,
    )?,
    number_markers: trigger_support_field("numberMarkers", selected)?,
    number_labels: trigger_support_field("numberLabels", selected)?,
  }))
}
