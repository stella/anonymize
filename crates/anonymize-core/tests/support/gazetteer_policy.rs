//! Test-only acceptance oracle for bounded gazetteer fuzz inputs.
//! Production keeps these predicates private. Duplicate them here so the
//! standalone fuzz crate can use them without adding a public runtime API;
//! core unit properties compare every predicate with production directly.

use unicode_normalization::char::is_combining_mark;

pub(super) fn marker_ranges(text: &str) -> Vec<(usize, usize)> {
  let mut ranges = Vec::new();
  let mut open = Vec::new();
  for (offset, character) in text.char_indices() {
    match character {
      '⟦' => open.push(offset),
      '⟧' => {
        if let Some(start) = open.pop()
          && open.is_empty()
        {
          ranges.push((start, offset.saturating_add(character.len_utf8())));
        }
      }
      _ if character.is_whitespace() => open.clear(),
      _ => {}
    }
  }
  ranges
}

pub(super) fn is_word_interior(character: char) -> bool {
  !is_unspaced_script(character)
    && (character.is_alphanumeric() || is_combining_mark(character))
}

pub(super) fn is_unspaced_script(character: char) -> bool {
  matches!(u32::from(character),
    0x0E00..=0x0EFF | 0x1000..=0x109F | 0x1780..=0x17FF
    | 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
    | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0x20000..=0x323AF)
}

pub(super) fn is_identifier_segment(segment: &str) -> bool {
  let length = segment.chars().count();
  let has_digit = segment.chars().any(|character| character.is_ascii_digit());
  let hex = length >= 4
    && has_digit
    && segment
      .chars()
      .all(|character| character.is_ascii_hexdigit())
    && segment
      .chars()
      .any(|character| character.is_ascii_alphabetic());
  let base64 = length >= 12
    && has_digit
    && segment.chars().any(char::is_uppercase)
    && segment.chars().any(char::is_lowercase);
  hex || base64
}

pub(super) const fn is_compound_joiner(character: char) -> bool {
  matches!(
    character,
    '-' | '_' | '.' | '/' | '+' | '=' | ':' | '@' | '#' | '\\'
  )
}

#[derive(Clone, Copy)]
enum Edge {
  Start(usize),
  End(usize),
}

fn adjacent_identifier_segment(text: &str, edge: Edge) -> Option<String> {
  match edge {
    Edge::Start(edge) => {
      let head = text.get(..edge)?;
      let mut chars = head
        .chars()
        .rev()
        .skip_while(|character| is_word_interior(*character))
        .peekable();
      if !chars
        .peek()
        .is_some_and(|character| is_compound_joiner(*character))
      {
        return None;
      }
      while chars
        .peek()
        .is_some_and(|character| is_compound_joiner(*character))
      {
        chars.next();
      }
      let segment = chars
        .take_while(|character| is_word_interior(*character))
        .collect::<String>();
      (!segment.is_empty()).then_some(segment)
    }
    Edge::End(edge) => {
      let tail = text.get(edge..)?;
      let mut chars = tail
        .chars()
        .skip_while(|character| is_word_interior(*character))
        .peekable();
      if !chars
        .peek()
        .is_some_and(|character| is_compound_joiner(*character))
      {
        return None;
      }
      while chars
        .peek()
        .is_some_and(|character| is_compound_joiner(*character))
      {
        chars.next();
      }
      let segment = chars
        .take_while(|character| is_word_interior(*character))
        .collect::<String>();
      (!segment.is_empty()).then_some(segment)
    }
  }
}

pub(super) fn touches_identifier(text: &str, start: usize, end: usize) -> bool {
  adjacent_identifier_segment(text, Edge::Start(start))
    .is_some_and(|value| is_identifier_segment(&value))
    || adjacent_identifier_segment(text, Edge::End(end))
      .is_some_and(|value| is_identifier_segment(&value))
}

pub(super) fn edges_are_free(text: &str, start: usize, end: usize) -> bool {
  let span = text.get(start..end).unwrap_or_default();
  let first = span.chars().next();
  let last = span.chars().next_back();
  let left = text
    .get(..start)
    .unwrap_or_default()
    .chars()
    .rev()
    .take_while(|character| is_word_interior(*character))
    .collect::<Vec<_>>();
  let right = text
    .get(end..)
    .unwrap_or_default()
    .chars()
    .take_while(|character| is_word_interior(*character))
    .collect::<Vec<_>>();
  glue_is_free(&left, first) && glue_is_free(&right, last)
}

pub(super) fn glue_is_free(glue: &[char], edge: Option<char>) -> bool {
  let Some(first) = glue.first() else {
    return true;
  };
  if !edge.is_some_and(is_word_interior) {
    return true;
  }
  edge.is_some_and(char::is_alphabetic)
    && first.is_numeric()
    && glue.iter().skip(1).all(|character| character.is_numeric())
}

pub(super) fn in_marker(text: &str, start: usize, end: usize) -> bool {
  marker_ranges(text).iter().any(|(open, close)| {
    *open < start && close.saturating_sub('⟧'.len_utf8()) >= end
  })
}

const TEMPLATE_DELIMITERS: [(&str, &str); 3] =
  [("<<", ">>"), ("{{", "}}"), ("[[", "]]")];

const fn is_line_break(character: char) -> bool {
  matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Outermost template placeholders (`<<…>>`, `{{…}}`, `[[…]]`), closing
/// delimiter included. A template spans spaces but never a line break; a
/// closer that does not match the innermost open delimiter is ignored.
pub(super) fn template_ranges(text: &str) -> Vec<(usize, usize)> {
  let mut ranges = Vec::new();
  let mut open: Vec<(usize, &str)> = Vec::new();
  let mut next = 0;
  for (offset, character) in text.char_indices() {
    if offset < next {
      continue;
    }
    if is_line_break(character) {
      open.clear();
      continue;
    }
    let rest = text.get(offset..).unwrap_or_default();
    if let Some(&(start, closer)) = open.last()
      && rest.starts_with(closer)
    {
      open.pop();
      next = offset.saturating_add(closer.len());
      if open.is_empty() {
        ranges.push((start, next));
      }
      continue;
    }
    if let Some((opener, closer)) = TEMPLATE_DELIMITERS
      .iter()
      .find(|(opener, _)| rest.starts_with(opener))
    {
      open.push((offset, closer));
      next = offset.saturating_add(opener.len());
    }
  }
  ranges
}

/// A span inside a template placeholder that is glued to a word character
/// or joined to a segment with a digit (`<<token:zeta9>>`): a field, not a
/// name. Plain names inside (`[[Jan Novák]]`) are not fields.
pub(super) fn in_template_field(text: &str, start: usize, end: usize) -> bool {
  let enclosed = template_ranges(text)
    .iter()
    .any(|(open, close)| *open < start && close.saturating_sub(2) >= end);
  if !enclosed {
    return false;
  }
  let glued = text
    .get(..start)
    .and_then(|head| head.chars().next_back())
    .is_some_and(is_word_interior)
    || text
      .get(end..)
      .and_then(|tail| tail.chars().next())
      .is_some_and(is_word_interior);
  glued
    || [
      adjacent_identifier_segment(text, Edge::Start(start)),
      adjacent_identifier_segment(text, Edge::End(end)),
    ]
    .into_iter()
    .flatten()
    .any(|segment| segment.chars().any(char::is_numeric))
}
