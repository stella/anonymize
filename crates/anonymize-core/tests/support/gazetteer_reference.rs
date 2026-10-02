//! Deliberately slow reference for the documented candidate policy.
//! No production helpers, marker index, or visit accounting are reused.

use std::ops::Range;

use unicode_properties::{GeneralCategory, UnicodeGeneralCategory};

fn word(character: char) -> bool {
  let unspaced = matches!(u32::from(character),
    0x0E00..=0x0EFF | 0x1000..=0x109F | 0x1780..=0x17FF
    | 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
    | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0x20000..=0x323AF);
  !unspaced
    && (character.is_alphanumeric()
      || matches!(
        character.general_category(),
        GeneralCategory::NonspacingMark
          | GeneralCategory::SpacingMark
          | GeneralCategory::EnclosingMark
      ))
}

fn edge_is_free(edge: Option<char>, neighbours: &[char]) -> bool {
  if !edge.is_some_and(word) {
    return true;
  }
  let run = neighbours
    .iter()
    .copied()
    .take_while(|ch| word(*ch))
    .collect::<Vec<_>>();
  run.is_empty()
    || (edge.is_some_and(char::is_alphabetic)
      && run.iter().all(|ch| ch.is_numeric()))
}

fn identifier_on_side(neighbours: &[char]) -> bool {
  let mut position = 0;
  while neighbours.get(position).is_some_and(|ch| word(*ch)) {
    position += 1;
  }
  let first_joiner = position;
  while neighbours.get(position).is_some_and(|ch| {
    matches!(
      ch,
      '-' | '_' | '.' | '/' | '+' | '=' | ':' | '@' | '#' | '\\'
    )
  }) {
    position += 1;
  }
  if position == first_joiner {
    return false;
  }
  let mut count = 0;
  let mut digits = 0;
  let mut hex_letters = 0;
  let mut non_hex = 0;
  let mut uppercase = 0;
  let mut lowercase = 0;
  while let Some(ch) = neighbours.get(position).filter(|ch| word(**ch)) {
    count += 1;
    digits += usize::from(ch.is_ascii_digit());
    hex_letters +=
      usize::from(ch.is_ascii_hexdigit() && ch.is_ascii_alphabetic());
    non_hex += usize::from(!ch.is_ascii_hexdigit());
    uppercase += usize::from(ch.is_uppercase());
    lowercase += usize::from(ch.is_lowercase());
    position += 1;
  }
  (count >= 4 && digits > 0 && hex_letters > 0 && non_hex == 0)
    || (count >= 12 && digits > 0 && uppercase > 0 && lowercase > 0)
}

fn enclosed(text: &str, span: &Range<usize>) -> bool {
  // Find each possible outer opening independently, then walk to its close.
  // An opening still enclosed by an unmatched outer marker is not outermost.
  for (opening, ch) in text.char_indices() {
    if ch != '⟦' || opening >= span.start {
      continue;
    }
    let mut preceding_depth = 0usize;
    for previous in text.get(..opening).unwrap_or_default().chars() {
      match previous {
        '⟦' => preceding_depth += 1,
        '⟧' => preceding_depth = preceding_depth.saturating_sub(1),
        _ if previous.is_whitespace() => preceding_depth = 0,
        _ => {}
      }
    }
    if preceding_depth != 0 {
      continue;
    }
    let mut depth = 0usize;
    for (offset, current) in
      text.get(opening..).unwrap_or_default().char_indices()
    {
      if current.is_whitespace() {
        break;
      }
      match current {
        '⟦' => depth += 1,
        '⟧' => {
          depth -= 1;
          if depth == 0 {
            if opening + offset >= span.end {
              return true;
            }
            break;
          }
        }
        _ => {}
      }
    }
  }
  false
}

/// Separate edge and identifier results expose regressions in either predicate.
pub(super) fn acceptance(text: &str, range: Range<usize>) -> (bool, bool) {
  let left = text
    .get(..range.start)
    .unwrap_or_default()
    .chars()
    .rev()
    .collect::<Vec<_>>();
  let right = text
    .get(range.end..)
    .unwrap_or_default()
    .chars()
    .collect::<Vec<_>>();
  let span = text.get(range.clone()).unwrap_or_default();
  (
    edge_is_free(span.chars().next(), &left)
      && edge_is_free(span.chars().next_back(), &right),
    enclosed(text, &range)
      || identifier_on_side(&left)
      || identifier_on_side(&right),
  )
}
