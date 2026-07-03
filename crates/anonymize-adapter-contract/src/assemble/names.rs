//! Name-corpus assembly: ports `initNameCorpus` (`detectors/names.ts`) and
//! `buildNativeNameCorpusData` (`build-unified-search.ts:558`).
//!
//! The corpus is built once per assemble run and shared by three consumers: the
//! `name_corpus_data` field, the `first_names` / stopword-exclusion inputs of
//! `false_positive_filters`, and the name entries appended to `deny_list_data`.
//! `initNameCorpus` runs regardless of `enableNameCorpus` (the false-positive
//! filters always need the first-name list), so this builder is unconditional;
//! only the emitted `name_corpus_data` field is gated on `enableNameCorpus`.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;
use stella_anonymize_core::assemble::{
  AssembleError, Dictionaries, OrderedMap, parse_data_file,
  parse_ordered_data_file,
};

use super::js::{js_lowercase, unique_strings};
use crate::BindingNameCorpusData;

/// `TITLE_PREFIXES` from `config/titles.ts`, in source order.
const TITLE_PREFIXES: &[&str] = &[
  "Ing.",
  "Mgr.",
  "MgA.",
  "Bc.",
  "BcA.",
  "JUDr.",
  "MUDr.",
  "MVDr.",
  "MDDr.",
  "PhDr.",
  "RNDr.",
  "PaedDr.",
  "ThDr.",
  "ThLic.",
  "ICDr.",
  "RSDr.",
  "PharmDr.",
  "artD.",
  "akad.",
  "doc.",
  "prof.",
  "ao. Univ.-Prof.",
  "o. Univ.-Prof.",
  "Univ.-Prof.",
  "Hon.-Prof.",
  "em. Prof.",
  "Dr. med. dent.",
  "Dr. med. vet.",
  "Dr. med.",
  "Dr. rer. nat.",
  "Dr. rer. soc.",
  "Dr. rer. pol.",
  "Dr. sc. tech.",
  "Dr. sc. nat.",
  "Dr. sc. hum.",
  "Dr. iur.",
  "Dr. jur.",
  "Dr. theol.",
  "Dr. oec.",
  "Dr. techn.",
  "Dr. h. c.",
  "Dr. phil.",
  "Dr.-Ing.",
  "Dr. Ing.",
  "Dr.",
  "Dipl.-Wirt.-Ing.",
  "Dipl.-Betriebsw.",
  "Dipl.-Inform.",
  "Dipl.-Volksw.",
  "Dipl.-Psych.",
  "Dipl.-Phys.",
  "Dipl.-Chem.",
  "Dipl.-Biol.",
  "Dipl.-Math.",
  "Dipl.-Päd.",
  "Dipl.-Soz.",
  "Dipl.-Kfm.",
  "Dipl.-Jur.",
  "Dipl. Ing.",
  "Dipl.-Ing.",
  "Mag. rer. soc. oec.",
  "Mag. rer. nat.",
  "Mag. phil.",
  "Mag. iur.",
  "Mag. arch.",
  "Mag. pharm.",
  "Mag. (FH)",
  "Mag.",
  "Bakk. rer. nat.",
  "Bakk. techn.",
  "Bakk. phil.",
  "Bakk.",
  "Lic. phil.",
  "Lic. iur.",
  "Lic. oec.",
  "Lic. theol.",
  "Lic.",
  "Priv.-Doz.",
  "PD",
  "RA",
];

/// `HONORIFIC_ABBREVIATION` from `config/titles.ts`, in Set insertion order.
const HONORIFIC_ABBREVIATION: &[&str] = &[
  "Avv.", "Dott.", "M.", "Me", "Messrs", "Mlle", "Mme", "Mr", "Mrs", "Ms",
  "Pr", "Pr.", "Sig.", "Sig.ra", "Sr.", "Sra.",
];

/// `NONWESTERN_HONORIFICS` from `config/titles.ts`, key order preserved. The
/// locale keys are lowercased at use (`normalizeCorpusLanguage`).
const NONWESTERN_HONORIFICS: &[(&str, &[&str])] = &[
  (
    "in",
    &[
      "Sri", "Shri", "Smt", "Smt.", "Kumari", "Pandit", "Pt.", "Adv.", "Adv",
      "Justice", "Hon'ble",
    ],
  ),
  (
    "ar",
    &[
      "Al-", "El-", "Sheikh", "Shaikh", "Sheikha", "Ustaz", "Ustaza", "Abu",
      "Umm",
    ],
  ),
  (
    "zh-Latn",
    &["Encik", "Puan", "Datuk", "Dato'", "Dato", "Tan Sri", "Tun"],
  ),
  ("ja-Latn", &["-san", "-sama", "-sensei", "Mr.", "Ms."]),
  ("ko", &["Sunsaeng", "Gyosu"]),
  (
    "th",
    &[
      "Khun",
      "Nai",
      "Nang",
      "Khunying",
      "Luang",
      "Phra",
      "Mom",
      "Momluang",
      "Mommuen",
      "Momratchawong",
    ],
  ),
  ("vi", &["Ông", "Ong", "Ba", "Co"]),
  (
    "fil",
    &[
      "Atty.", "Atty", "Ginoo", "Ginang", "Binibini", "G.", "Gng.", "Bb.",
    ],
  ),
  (
    "id",
    &[
      "Bapak", "Ibu", "Pak", "Bu", "Raden", "Tuan", "Nyonya", "Nona", "Haji",
      "Hajjah", "H.", "Hj.", "S.H.", "S.H", "Ir.", "Drs.",
    ],
  ),
];

/// `NONWESTERN_LOCALE_KEYS` from `detectors/names.ts` (already lowercase).
const NONWESTERN_LOCALE_KEYS: &[&str] = &[
  "in", "ar", "ja-latn", "ko", "zh-latn", "th", "vi", "fil", "id",
];

/// `CJK_LANGUAGE_ALIASES` from `build-unified-search.ts`.
const CJK_LANGUAGE_ALIASES: &[(&str, &[&str])] = &[
  ("zh", &["zh", "zh-latn", "zh-hans", "zh-hant"]),
  ("ja", &["ja", "ja-latn"]),
  ("ko", &["ko", "ko-latn"]),
];

/// The fully-built name corpus, mirroring the fields of `ctx.nameCorpus` that
/// downstream assembly consumes.
pub(super) struct NameCorpus {
  pub first_names_list: Vec<String>,
  pub surnames_list: Vec<String>,
  pub titles_list: Vec<String>,
  pub title_abbreviations: Vec<String>,
  pub excluded_list: Vec<String>,
  pub common_words: Vec<String>,
  pub non_western_names_list: Vec<String>,
  pub excluded_all_caps_list: Vec<String>,
  /// `commonWords` as a lookup set (lowercased); used by declension filtering.
  pub common_words_set: HashSet<String>,
}

#[derive(Deserialize)]
struct NamesFile {
  #[serde(default)]
  names: Vec<String>,
}

#[derive(Deserialize)]
struct TokensFile {
  #[serde(default)]
  tokens: Vec<String>,
}

#[derive(Deserialize)]
struct WordsFile {
  #[serde(default)]
  words: Vec<String>,
}

/// Mirrors `dedup`: first-occurrence dedup preserving order.
fn dedup(values: Vec<String>) -> Vec<String> {
  unique_strings(values)
}

/// Mirrors `form.replace(/[.-]+$/u, "").toLowerCase()`.
fn strip_trailing_dots_dashes_lower(form: &str) -> String {
  let trimmed = form.trim_end_matches(['.', '-']);
  js_lowercase(trimmed)
}

/// Mirrors `normalizeCorpusLanguage`: `toLowerCase`.
fn normalize_corpus_language(language: &str) -> String {
  js_lowercase(language)
}

/// Mirrors `getScopedNonWesternLocaleKeys`.
fn scoped_non_western_locale_keys(
  languages: Option<&[String]>,
) -> Vec<&'static str> {
  let Some(languages) = languages else {
    return NONWESTERN_LOCALE_KEYS.to_vec();
  };
  let allowed: HashSet<String> = languages
    .iter()
    .map(|l| normalize_corpus_language(l))
    .collect();
  NONWESTERN_LOCALE_KEYS
    .iter()
    .copied()
    .filter(|locale| allowed.contains(*locale))
    .collect()
}

/// Mirrors `getScopedNonWesternHonorifics`.
fn scoped_non_western_honorifics(
  languages: Option<&[String]>,
) -> Vec<&'static str> {
  languages.map_or_else(
    || {
      NONWESTERN_HONORIFICS
        .iter()
        .flat_map(|(_, forms)| forms.iter().copied())
        .collect()
    },
    |languages| {
      let allowed: HashSet<String> = languages
        .iter()
        .map(|l| normalize_corpus_language(l))
        .collect();
      NONWESTERN_HONORIFICS
        .iter()
        .filter(|(locale, _)| {
          allowed.contains(&normalize_corpus_language(locale))
        })
        .flat_map(|(_, forms)| forms.iter().copied())
        .collect()
    },
  )
}

/// Appends the language-scoped values of an injected dictionary map.
fn append_scoped_dictionary(
  target: &mut Vec<String>,
  map: Option<&stella_anonymize_core::assemble::OrderedMap<Vec<String>>>,
  languages: Option<&[String]>,
  normalize_keys: bool,
) {
  let Some(map) = map else {
    return;
  };
  let allowed: Option<HashSet<String>> = languages.map(|languages| {
    languages
      .iter()
      .map(|l| {
        if normalize_keys {
          normalize_corpus_language(l)
        } else {
          l.clone()
        }
      })
      .collect()
  });
  for (language, names) in map {
    if let Some(allowed) = allowed.as_ref() {
      let key = if normalize_keys {
        normalize_corpus_language(language)
      } else {
        language.clone()
      };
      if !allowed.contains(&key) {
        continue;
      }
    }
    for name in names {
      target.push(name.clone());
    }
  }
}

/// Builds the name corpus from embedded legacy files plus optional injected
/// dictionaries, scoped by `languages` (the effective `nameCorpusLanguages`).
///
/// # Errors
///
/// Returns [`AssembleError`] when an embedded name data file fails to parse.
pub(super) fn build_name_corpus(
  dictionaries: Option<&Dictionaries>,
  languages: Option<&[String]>,
) -> Result<NameCorpus, AssembleError> {
  let legacy_first: NamesFile = parse_data_file("names-first.json")?;
  let legacy_surname: NamesFile = parse_data_file("names-surnames.json")?;
  let title_tokens: TokensFile = parse_data_file("names-title-tokens.json")?;
  let exclusions: WordsFile = parse_data_file("names-exclusions.json")?;
  let common_words_file: WordsFile = parse_data_file("common-words-en.json")?;

  let mut first_names = legacy_first.names;
  append_scoped_dictionary(
    &mut first_names,
    dictionaries.and_then(|d| d.first_names.as_ref()),
    languages,
    false,
  );

  let mut surnames = legacy_surname.names;
  append_scoped_dictionary(
    &mut surnames,
    dictionaries.and_then(|d| d.surnames.as_ref()),
    languages,
    false,
  );

  // commonWords: lowercased, Set insertion order (deduped).
  let common_words = dedup(
    common_words_file
      .words
      .iter()
      .map(|word| js_lowercase(word))
      .collect(),
  );
  let common_words_set: HashSet<String> =
    common_words.iter().cloned().collect();

  let first_names_list = dedup(first_names);
  let surnames_list = dedup(surnames)
    .into_iter()
    .filter(|name| !common_words_set.contains(&js_lowercase(name)))
    .collect();

  // Titles: legacy tokens + scoped NW honorifics (trailing dots/dashes stripped).
  let scoped_honorifics = scoped_non_western_honorifics(languages);
  let mut titles = title_tokens.tokens;
  for form in &scoped_honorifics {
    titles.push(strip_trailing_dots_dashes_lower(form));
  }
  let titles_list = dedup(titles);

  // Title abbreviations (Set insertion order).
  let mut title_abbreviations = Vec::new();
  let mut abbr_seen = HashSet::new();
  let mut add_abbr = |value: String| {
    if abbr_seen.insert(value.clone()) {
      title_abbreviations.push(value);
    }
  };
  for prefix in TITLE_PREFIXES {
    if prefix.ends_with('.') {
      add_abbr(strip_trailing_dots_dashes_lower(prefix));
    }
  }
  for form in HONORIFIC_ABBREVIATION {
    add_abbr(strip_trailing_dots_dashes_lower(form));
  }
  for form in &scoped_honorifics {
    if form.ends_with('.') {
      add_abbr(strip_trailing_dots_dashes_lower(form));
    }
  }

  // Non-Western names (per-locale files + injected data, scoped).
  let mut non_western_names = Vec::new();
  for locale in scoped_non_western_locale_keys(languages) {
    let file = format!("names-nw-{locale}.json");
    let parsed: NamesFile = parse_data_file(&file)?;
    for name in parsed.names {
      non_western_names.push(name);
    }
  }
  append_scoped_dictionary(
    &mut non_western_names,
    dictionaries.and_then(|d| d.non_western_names.as_ref()),
    languages,
    true,
  );
  let non_western_names_list = dedup(non_western_names);

  let excluded_all_caps: WordsFile =
    parse_data_file("names-nw-excluded-allcaps.json")?;
  let excluded_all_caps_list = dedup(excluded_all_caps.words);

  Ok(NameCorpus {
    first_names_list,
    surnames_list,
    titles_list,
    title_abbreviations,
    // `excludedList` is `exclusionMod.default.words` verbatim (no dedup).
    excluded_list: exclusions.words,
    common_words,
    non_western_names_list,
    excluded_all_caps_list,
    common_words_set,
  })
}

// ── Czech/Slovak declension expansion (detectors/names.ts) ──────────────────

/// One declension rule: the nominative ending to strip and the case endings to
/// append when the shape gate matches the lowercased name.
struct DeclensionRule {
  /// Chars of the nominative ending replaced by each form.
  ending_len: usize,
  /// Shape gate over the lowercased char slice.
  gate: fn(&[char]) -> bool,
  forms: &'static [&'static str],
}

fn last_in(lc: &[char], set: &[char]) -> bool {
  lc.last().is_some_and(|c| set.contains(c))
}

/// Ends with `suffix` and the char immediately before it is present and NOT in
/// `excluded` (a `[^...]suffix$` gate).
fn tail_after_not_in(lc: &[char], suffix: &[char], excluded: &[char]) -> bool {
  lc.strip_suffix(suffix)
    .and_then(<[char]>::last)
    .is_some_and(|before| !excluded.contains(before))
}

/// Ends with `suffix` and the char immediately before it is present and IN
/// `included` (a `[included]suffix$` gate).
fn tail_after_in(lc: &[char], suffix: &[char], included: &[char]) -> bool {
  lc.strip_suffix(suffix)
    .and_then(<[char]>::last)
    .is_some_and(|before| included.contains(before))
}

fn ends_with_chars(lc: &[char], suffix: &[char]) -> bool {
  lc.ends_with(suffix)
}

const V_WITH_I: &[char] = &[
  'a', 'e', 'i', 'o', 'u', 'y', 'á', 'é', 'ě', 'í', 'ó', 'ô', 'ú', 'ů', 'ý',
];
const V_NO_I: &[char] = &[
  'a', 'e', 'o', 'u', 'y', 'á', 'é', 'ě', 'í', 'ó', 'ô', 'ú', 'ů', 'ý',
];
const SOFT_WITH_I: &[char] =
  &['c', 'č', 'ď', 'ť', 'ň', 'ř', 'š', 'ž', 'j', 'i'];
const SOFT_NO_I: &[char] = &['c', 'č', 'ď', 'ť', 'ň', 'ř', 'š', 'ž', 'j'];

const DECLENSION_RULES: &[DeclensionRule] = &[
  DeclensionRule {
    ending_len: 0,
    gate: |lc| {
      last_in(
        lc,
        &[
          'b', 'd', 'f', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'q', 'r', 's', 't',
          'v', 'w', 'x', 'z', 'ł',
        ],
      )
    },
    forms: &["a", "u", "ovi", "em", "om"],
  },
  DeclensionRule {
    ending_len: 0,
    gate: |lc| {
      last_in(
        lc,
        &['b', 'd', 'f', 'l', 'm', 'n', 'p', 's', 't', 'v', 'w', 'z'],
      )
    },
    forms: &["e"],
  },
  DeclensionRule {
    ending_len: 0,
    gate: |lc| last_in(lc, &['c', 'č', 'ď', 'ť', 'ň', 'ř', 'š', 'ž', 'j', 'ľ']),
    forms: &["e", "i", "a", "ovi", "em", "om"],
  },
  DeclensionRule {
    ending_len: 2,
    gate: |lc| tail_after_not_in(lc, &['e', 'k'], V_WITH_I),
    forms: &["ka", "ku", "kovi", "kem", "kom"],
  },
  DeclensionRule {
    ending_len: 2,
    gate: |lc| tail_after_not_in(lc, &['e', 'l'], V_WITH_I),
    forms: &["la", "lu", "le", "lovi", "lem", "lom"],
  },
  DeclensionRule {
    ending_len: 2,
    gate: |lc| tail_after_not_in(lc, &['e', 'c'], V_WITH_I),
    forms: &["ce", "ci", "covi", "cem", "com"],
  },
  DeclensionRule {
    ending_len: 1,
    gate: |lc| tail_after_not_in(lc, &['a'], SOFT_WITH_I),
    forms: &["y", "u", "o", "ou", "ovi"],
  },
  DeclensionRule {
    ending_len: 1,
    gate: |lc| tail_after_in(lc, &['a'], SOFT_NO_I),
    forms: &["i", "u", "o", "ou", "ovi"],
  },
  DeclensionRule {
    ending_len: 1,
    gate: |lc| ends_with_chars(lc, &['i', 'a']),
    forms: &["e", "i", "u", "ou"],
  },
  DeclensionRule {
    ending_len: 2,
    gate: |lc| ends_with_chars(lc, &['k', 'a']),
    forms: &["ce"],
  },
  DeclensionRule {
    ending_len: 2,
    gate: |lc| ends_with_chars(lc, &['r', 'a']),
    forms: &["ře", "re"],
  },
  DeclensionRule {
    ending_len: 2,
    gate: |lc| ends_with_chars(lc, &['h', 'a']),
    forms: &["ze"],
  },
  DeclensionRule {
    ending_len: 2,
    gate: |lc| ends_with_chars(lc, &['g', 'a']),
    forms: &["ze"],
  },
  DeclensionRule {
    ending_len: 3,
    gate: |lc| ends_with_chars(lc, &['c', 'h', 'a']),
    forms: &["še"],
  },
  DeclensionRule {
    ending_len: 1,
    gate: |lc| {
      tail_after_in(lc, &['a'], &['b', 'd', 'f', 'm', 'n', 'p', 't', 'v'])
    },
    forms: &["ě", "e"],
  },
  DeclensionRule {
    ending_len: 1,
    gate: |lc| tail_after_in(lc, &['a'], &['s', 'z', 'l']),
    forms: &["e"],
  },
  DeclensionRule {
    ending_len: 1,
    gate: |lc| ends_with_chars(lc, &['á']),
    forms: &["é", "ou", "ej", "ú"],
  },
  DeclensionRule {
    ending_len: 1,
    gate: |lc| ends_with_chars(lc, &['ý']),
    forms: &["ého", "ému", "ém", "ým"],
  },
  DeclensionRule {
    ending_len: 0,
    gate: |lc| last_in(lc, &['í', 'i', 'y']),
    forms: &["ho", "mu", "m"],
  },
  DeclensionRule {
    ending_len: 1,
    gate: |lc| tail_after_not_in(lc, &['e'], V_NO_I),
    forms: &["i", "í"],
  },
  DeclensionRule {
    ending_len: 1,
    gate: |lc| ends_with_chars(lc, &['o']),
    forms: &["a", "ovi", "em", "om"],
  },
];

/// Mirrors `expandNameDeclensions`. Returns declined variants of a nominative
/// name licensed by the ending-shape rules; empty for names shorter than 3.
pub(super) fn expand_name_declensions(name: &str) -> Vec<String> {
  let name_chars: Vec<char> = name.chars().collect();
  if name.encode_utf16().count() < 3 {
    return Vec::new();
  }
  let lc: Vec<char> = js_lowercase(name).chars().collect();
  let mut variants = Vec::new();
  for rule in DECLENSION_RULES {
    if !(rule.gate)(&lc) {
      continue;
    }
    let Some(stem_chars) = name_chars
      .len()
      .checked_sub(rule.ending_len)
      .and_then(|take| name_chars.get(..take))
    else {
      continue;
    };
    let stem: String = stem_chars.iter().collect();
    if stem.encode_utf16().count() < 2 {
      continue;
    }
    for form in rule.forms {
      variants.push(format!("{stem}{form}"));
    }
  }
  variants
}

// ── name_corpus_data (build-unified-search.ts:558) ──────────────────────────

#[derive(Deserialize)]
struct CjkLanguageData {
  #[serde(default, rename = "nonPersonTerms")]
  non_person_terms: Vec<String>,
  #[serde(default, rename = "surnameStarters")]
  surname_starters: Vec<String>,
}

#[derive(Deserialize)]
struct ParticleLanguageData {
  #[serde(default)]
  suffixes: Vec<String>,
  #[serde(default)]
  connectors: Vec<String>,
  #[serde(default, rename = "relationConnectors")]
  relation_connectors: Vec<String>,
  #[serde(default, rename = "hyphenatedPrefixes")]
  hyphenated_prefixes: Vec<String>,
}

/// Mirrors `languageIsSelected`.
fn language_is_selected(
  language: &str,
  selected: Option<&[String]>,
  aliases: &[(&str, &[&str])],
) -> bool {
  let Some(selected) = selected else {
    return true;
  };
  let normalized = js_lowercase(language);
  let accepted: Vec<&str> = aliases
    .iter()
    .find(|(key, _)| *key == normalized)
    .map_or_else(|| vec![normalized.as_str()], |(_, values)| values.to_vec());
  accepted
    .iter()
    .any(|entry| selected.iter().any(|s| s == entry))
}

/// Mirrors `buildNativeNameCorpusData`. `enable_name_corpus` gates emission;
/// `languages` is the effective `nameCorpusLanguages` lowercased.
///
/// # Errors
///
/// Returns [`AssembleError`] when an embedded corpus data file fails to parse.
pub(super) fn build_native_name_corpus_data(
  corpus: &NameCorpus,
  enable_name_corpus: bool,
  name_corpus_languages: Option<&[String]>,
) -> Result<Option<BindingNameCorpusData>, AssembleError> {
  if !enable_name_corpus {
    return Ok(None);
  }

  // `config.nameCorpusLanguages?.map(toLowerCase)`.
  let languages: Option<Vec<String>> = name_corpus_languages
    .map(|langs| langs.iter().map(|l| js_lowercase(l)).collect());
  let languages_ref = languages.as_deref();

  let cjk: OrderedMap<Value> = parse_ordered_data_file("name-corpus-cjk.json")?;
  let mut cjk_non_person_terms = Vec::new();
  let mut cjk_surname_starters = Vec::new();
  for (language, value) in &cjk {
    let Ok(data) = serde_json::from_value::<CjkLanguageData>(value.clone())
    else {
      continue;
    };
    // isNameCorpusCjkLanguageData requires both arrays to be present.
    if !value.get("nonPersonTerms").is_some_and(Value::is_array)
      || !value.get("surnameStarters").is_some_and(Value::is_array)
    {
      continue;
    }
    if !language_is_selected(language, languages_ref, CJK_LANGUAGE_ALIASES) {
      continue;
    }
    cjk_non_person_terms.extend(data.non_person_terms);
    cjk_surname_starters.extend(data.surname_starters);
  }

  let particles: OrderedMap<Value> =
    parse_ordered_data_file("name-corpus-particles.json")?;
  let mut ja_suffixes = Vec::new();
  let mut arabic_connectors = Vec::new();
  let mut relation_connectors = Vec::new();
  let mut hyphenated_prefixes = Vec::new();
  for (language, value) in &particles {
    // isNameCorpusParticleLanguageData: an object (non-null, non-array).
    if !value.is_object() {
      continue;
    }
    if !language_is_selected(language, languages_ref, &[]) {
      continue;
    }
    let Ok(data) =
      serde_json::from_value::<ParticleLanguageData>(value.clone())
    else {
      continue;
    };
    ja_suffixes.extend(data.suffixes);
    arabic_connectors.extend(data.connectors);
    relation_connectors.extend(data.relation_connectors);
    hyphenated_prefixes.extend(data.hyphenated_prefixes);
  }

  let organization_indicators: OrderedMap<Value> =
    parse_ordered_data_file("organization-indicators.json")?;
  let mut organization_terms = Vec::new();
  for (_key, value) in &organization_indicators {
    if let Some(array) = value.as_array() {
      for term in array {
        if let Some(term) = term.as_str() {
          organization_terms.push(term.to_string());
        }
      }
    }
  }

  Ok(Some(BindingNameCorpusData {
    first_names: corpus.first_names_list.clone(),
    surnames: corpus.surnames_list.clone(),
    title_tokens: corpus.titles_list.clone(),
    title_abbreviations: corpus.title_abbreviations.clone(),
    excluded_words: corpus.excluded_list.clone(),
    common_words: corpus.common_words.clone(),
    non_western_names: corpus.non_western_names_list.clone(),
    excluded_all_caps: corpus.excluded_all_caps_list.clone(),
    ja_suffixes: unique_strings(ja_suffixes),
    arabic_connectors: unique_strings(arabic_connectors),
    relation_connectors: unique_strings(relation_connectors),
    hyphenated_prefixes: unique_strings(hyphenated_prefixes),
    cjk_non_person_terms: unique_strings(cjk_non_person_terms),
    cjk_surname_starters: unique_strings(cjk_surname_starters),
    organization_terms: unique_strings(organization_terms),
  }))
}
