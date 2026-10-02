//! Deliberately slow reference for the documented candidate policy.
//! No production helpers, marker index, or visit accounting are reused.

use std::ops::Range;

use unicode_properties::{GeneralCategory, UnicodeGeneralCategory};

fn word(character: char) -> bool {
  let unspaced = matches!(u32::from(character),
    0x0E00..=0x0EFF | 0x1000..=0x109F | 0x1100..=0x11FF
    | 0x1780..=0x17FF | 0x19E0..=0x19FF | 0x2E80..=0x2FDF
    | 0x3040..=0x30FF | 0x3130..=0x318F | 0x31F0..=0x31FF
    | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xA960..=0xA97F
    | 0xA9E0..=0xA9FF | 0xAA60..=0xAA7F | 0xAC00..=0xD7AF
    | 0xD7B0..=0xD7FF | 0xF900..=0xFAFF | 0xFF66..=0xFFDC
    | 0x116D0..=0x116FF | 0x1AFF0..=0x1B16F | 0x20000..=0x323AF);
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

fn joined_word(neighbours: &[char]) -> &[char] {
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
    return &[];
  }
  let start = position;
  while neighbours.get(position).is_some_and(|ch| word(*ch)) {
    position += 1;
  }
  neighbours.get(start..position).unwrap_or_default()
}

fn identifier_on_side(neighbours: &[char]) -> bool {
  let mut count = 0;
  let mut digits = 0;
  let mut hex_letters = 0;
  let mut non_hex = 0;
  let mut uppercase = 0;
  let mut lowercase = 0;
  for ch in joined_word(neighbours) {
    count += 1;
    digits += usize::from(ch.is_ascii_digit());
    hex_letters +=
      usize::from(ch.is_ascii_hexdigit() && ch.is_ascii_alphabetic());
    non_hex += usize::from(!ch.is_ascii_hexdigit());
    uppercase += usize::from(ch.is_uppercase());
    lowercase += usize::from(ch.is_lowercase());
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

fn template_closer(
  characters: &[(usize, char)],
  position: usize,
) -> Option<char> {
  let first = characters.get(position)?.1;
  let second = characters.get(position.checked_add(1)?)?.1;
  if first != second {
    return None;
  }
  match first {
    '<' => Some('>'),
    '{' => Some('}'),
    '[' => Some(']'),
    _ => None,
  }
}

// Recursively parse a single delimiter pair, rather than building the production
// marker index. Mismatched closers are text; any line break abandons the pair.
fn close_template(
  characters: &[(usize, char)],
  position: &mut usize,
  closer: char,
) -> Option<usize> {
  *position += 2;
  while let Some((offset, ch)) = characters.get(*position).copied() {
    if matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
      return None;
    }
    if ch == closer
      && characters
        .get(position.checked_add(1)?)
        .is_some_and(|(_, next)| *next == closer)
    {
      *position += 2;
      return Some(offset);
    }
    if let Some(nested_closer) = template_closer(characters, *position) {
      close_template(characters, position, nested_closer)?;
    } else {
      *position += 1;
    }
  }
  None
}

fn template_enclosed(text: &str, span: &Range<usize>) -> bool {
  let characters = text.char_indices().collect::<Vec<_>>();
  let mut position = 0;
  while let Some((opening, _)) = characters.get(position).copied() {
    let Some(closer) = template_closer(&characters, position) else {
      position += 1;
      continue;
    };
    if close_template(&characters, &mut position, closer)
      .is_some_and(|closing| opening < span.start && span.end <= closing)
    {
      return true;
    }
  }
  false
}

fn template_field(
  text: &str,
  span: &Range<usize>,
  left: &[char],
  right: &[char],
) -> bool {
  template_enclosed(text, span)
    && (left.first().is_some_and(|ch| word(*ch))
      || right.first().is_some_and(|ch| word(*ch))
      || joined_word(left).iter().any(|ch| ch.is_numeric())
      || joined_word(right).iter().any(|ch| ch.is_numeric()))
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
      || template_field(text, &range, &left, &right)
      || identifier_on_side(&left)
      || identifier_on_side(&right),
  )
}
