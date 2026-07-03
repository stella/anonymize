//! Shared [`BindingSearchPattern`] constructors mirroring the `toNative*Pattern`
//! helpers in `build-unified-search.ts`. Every field defaults to `None`; each
//! constructor sets only the members its TypeScript counterpart emits, so the
//! serialized JSON matches (absent fields serialize as `null`, exactly like the
//! omitted keys in the source).

use crate::BindingSearchPattern;

/// A pattern with every optional field unset.
fn base(kind: &str, pattern: String) -> BindingSearchPattern {
  BindingSearchPattern {
    kind: kind.to_string(),
    pattern,
    distance: None,
    case_insensitive: None,
    whole_words: None,
    lazy: None,
    prefilter_any: None,
    prefilter_case_insensitive: None,
    prefilter_regex: None,
    prefilter_window_bytes: None,
    prepared_artifact_policy: None,
  }
}

/// `{ kind: "literal", pattern }`.
pub(super) fn literal(pattern: String) -> BindingSearchPattern {
  base("literal", pattern)
}

/// `toNativeLiteralPattern` for a `literal: true` entry:
/// `{ kind: "literal-with-options", pattern, case_insensitive?, whole_words? }`.
pub(super) fn literal_with_options(
  pattern: String,
  case_insensitive: Option<bool>,
  whole_words: Option<bool>,
) -> BindingSearchPattern {
  BindingSearchPattern {
    case_insensitive,
    whole_words,
    ..base("literal-with-options", pattern)
  }
}

/// `toNativeLiteralPattern` for a `distance` entry:
/// `{ kind: "fuzzy", pattern, distance? }` (distance omitted when `"auto"`).
pub(super) fn fuzzy_pattern(
  pattern: String,
  distance: Option<u32>,
) -> BindingSearchPattern {
  BindingSearchPattern {
    distance,
    ..base("fuzzy", pattern)
  }
}
