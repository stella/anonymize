//! Small JavaScript-semantics helpers shared by the C2 field builders.
//!
//! These reproduce quirks of the TypeScript source that a naive Rust port would
//! get wrong: UTF-16 code-unit ordering for `Array.prototype.toSorted`, the
//! `RegExp.prototype.source` escaping applied by `new RegExp(...)`, and the
//! canonical flag ordering of `RegExp.prototype.flags`.

use std::cmp::Ordering;
use std::collections::HashSet;

/// JS `String.prototype.length`: number of UTF-16 code units.
pub(super) fn utf16_len(value: &str) -> usize {
  value.encode_utf16().count()
}

/// Compares two strings by their UTF-16 code units, matching the default
/// comparator of `Array.prototype.sort` / `toSorted` (which coerces elements to
/// strings and compares them as sequences of UTF-16 code units). This differs
/// from Rust's native `str` ordering only for non-BMP characters, but the
/// difference is real (astral scalars sort before BMP ones above U+E000 under
/// UTF-16 because of surrogate values), so the comparison is explicit.
pub(super) fn utf16_cmp(left: &str, right: &str) -> Ordering {
  let mut left_units = left.encode_utf16();
  let mut right_units = right.encode_utf16();
  loop {
    match (left_units.next(), right_units.next()) {
      (Some(a), Some(b)) => match a.cmp(&b) {
        Ordering::Equal => {}
        non_equal => return non_equal,
      },
      (Some(_), None) => return Ordering::Greater,
      (None, Some(_)) => return Ordering::Less,
      (None, None) => return Ordering::Equal,
    }
  }
}

/// Reproduces `RegExp.prototype.source` for a pattern compiled via
/// `new RegExp(pattern, flags)`: an empty pattern becomes `(?:)`, and the
/// characters a regex literal could not otherwise contain are escaped, namely a
/// forward slash that is not already backslash-escaped and the four line
/// terminators. Trigger configs only exercise the `/` escaping, but the line
/// terminators are handled for completeness.
pub(super) fn escape_regexp_source(pattern: &str) -> String {
  if pattern.is_empty() {
    return "(?:)".to_string();
  }
  let mut out = String::with_capacity(pattern.len());
  // `pending_escape` is true when the previous character was a backslash that
  // is itself not escaped, i.e. it escapes the current character.
  let mut pending_escape = false;
  for ch in pattern.chars() {
    match ch {
      '\\' => {
        out.push('\\');
        pending_escape = !pending_escape;
      }
      '/' if !pending_escape => {
        out.push_str("\\/");
        pending_escape = false;
      }
      '\n' if !pending_escape => {
        out.push_str("\\n");
        pending_escape = false;
      }
      '\r' if !pending_escape => {
        out.push_str("\\r");
        pending_escape = false;
      }
      '\u{2028}' if !pending_escape => {
        out.push_str("\\u2028");
        pending_escape = false;
      }
      '\u{2029}' if !pending_escape => {
        out.push_str("\\u2029");
        pending_escape = false;
      }
      other => {
        out.push(other);
        pending_escape = false;
      }
    }
  }
  out
}

/// Canonical order of `RegExp` flag characters, matching the fixed order
/// `RegExp.prototype.flags` emits (`d, g, i, m, s, u, v, y`).
const FLAG_ORDER: &[char] = &['d', 'g', 'i', 'm', 's', 'u', 'v', 'y'];

/// Reproduces `RegExp.prototype.flags` for `new RegExp(pattern, raw)` after the
/// `g`/`y` strip the trigger compiler applies: remove `g` and `y`, dedup, and
/// return the remaining flags in canonical order.
pub(super) fn canonical_regexp_flags(raw: &str) -> String {
  let mut kept: HashSet<char> = HashSet::new();
  for ch in raw.chars() {
    if ch == 'g' || ch == 'y' {
      continue;
    }
    if FLAG_ORDER.contains(&ch) {
      kept.insert(ch);
    }
  }
  FLAG_ORDER
    .iter()
    .filter(|flag| kept.contains(flag))
    .copied()
    .collect()
}
