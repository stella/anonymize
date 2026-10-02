//! Czech/Slovak name declension expansion shared by deny-list assembly and
//! gazetteer matching.

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
    // vocab-allow: Czech declension endings coupled to this morphology rule
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
    // vocab-allow: Czech declension endings coupled to this morphology rule
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

/// Returns declined variants of a nominative
/// name licensed by the ending-shape rules; empty for names shorter than 3.
#[must_use]
pub fn expand_name_declensions(name: &str) -> Vec<String> {
  let Some((name_chars, lc)) = declinable(name) else {
    return Vec::new();
  };
  let mut variants = Vec::new();
  for rule in DECLENSION_RULES {
    if !(rule.gate)(&lc) {
      continue;
    }
    let Some(stem) = stem(&name_chars, rule.ending_len, "") else {
      continue;
    };
    for form in rule.forms {
      variants.push(format!("{stem}{form}"));
    }
  }
  variants
}

/// One surname stem: the nominative ending to replace and its replacement
/// (`Kubíček` -> `Kubíčk`).
struct DerivationStem {
  ending_len: usize,
  gate: fn(&[char]) -> bool,
  replacement: &'static str,
}

struct DerivationForms {
  forms: &'static [&'static str],
}

const DERIVATION_STEMS: &[DerivationStem] = &[
  DerivationStem {
    ending_len: 0,
    gate: |lc| {
      last_in(
        lc,
        &[
          'b', 'c', 'č', 'd', 'ď', 'f', 'g', 'h', 'j', 'k', 'l', 'ľ', 'ł', 'm',
          'n', 'ň', 'p', 'q', 'r', 'ř', 's', 'š', 't', 'ť', 'v', 'w', 'x', 'z',
          'ž',
        ],
      )
    },
    replacement: "",
  },
  DerivationStem {
    ending_len: 2,
    gate: |lc| tail_after_not_in(lc, &['e', 'k'], V_WITH_I),
    replacement: "k",
  },
  DerivationStem {
    ending_len: 2,
    gate: |lc| tail_after_not_in(lc, &['e', 'l'], V_WITH_I),
    replacement: "l",
  },
  DerivationStem {
    ending_len: 2,
    gate: |lc| tail_after_not_in(lc, &['e', 'c'], V_WITH_I),
    replacement: "c",
  },
  DerivationStem {
    ending_len: 1,
    gate: |lc| ends_with_chars(lc, &['a']),
    replacement: "",
  },
];

/// Feminine (`Nováková`), possessive (`Novákův`, `Novákových`) and plural
/// (`Nováků`) endings appended to a surname stem, Czech and Slovak.
const SURNAME_DERIVATIONS: DerivationForms = DerivationForms {
  forms: &[
    "ová", "ové", "ovou", "ovej", "ovú", "ův", "ov", "ova", "ovo", "ovy",
    "ových", "ovým", "ovými", "ovu", "ově", "ovom", "ů", "ům", "y",
  ],
};

/// Feminine, possessive and plural forms derived from a surname, beyond its
/// own case forms ([`expand_name_declensions`]); empty for names shorter
/// than 3.
#[must_use]
pub(crate) fn expand_surname_derivations(name: &str) -> Vec<String> {
  let Some((name_chars, lc)) = declinable(name) else {
    return Vec::new();
  };
  let mut variants = Vec::new();
  for rule in DERIVATION_STEMS {
    if !(rule.gate)(&lc) {
      continue;
    }
    let Some(stem) = stem(&name_chars, rule.ending_len, rule.replacement)
    else {
      continue;
    };
    for form in SURNAME_DERIVATIONS.forms {
      variants.push(format!("{stem}{form}"));
    }
  }
  variants
}

/// The name's chars and lowercased chars, when it is long enough to decline.
fn declinable(name: &str) -> Option<(Vec<char>, Vec<char>)> {
  (name.encode_utf16().count() >= 3).then(|| {
    (
      name.chars().collect(),
      name.to_lowercase().chars().collect(),
    )
  })
}

/// The name without its last `ending_len` chars plus `replacement`, when at
/// least two UTF-16 units of the name remain.
fn stem(
  name_chars: &[char],
  ending_len: usize,
  replacement: &str,
) -> Option<String> {
  let kept = name_chars
    .len()
    .checked_sub(ending_len)
    .and_then(|take| name_chars.get(..take))?;
  let mut stem = kept.iter().collect::<String>();
  if stem.encode_utf16().count() < 2 {
    return None;
  }
  stem.push_str(replacement);
  Some(stem)
}
