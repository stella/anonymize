// Shared production acceptance policy for gazetteer candidate spans.

use std::cell::Cell;

use unicode_normalization::char::is_combining_mark;

/// Characters that join word runs into one compound (`9b1d0c3e-acfe`,
/// `novak@acme.cz`, `Acme_v2`).
pub(super) const COMPOUND_JOINERS: [char; 10] =
  ['-', '_', '.', '/', '+', '=', ':', '@', '#', '\\'];

/// Shortest hex run read as an identifier segment (`4c1b`, `9b1d0c3e`).
const MIN_HEX_SEGMENT_CHARS: usize = 4;

/// Shortest mixed-case alphanumeric run read as a base64 segment.
const MIN_BASE64_SEGMENT_CHARS: usize = 12;

/// Word characters for token boundaries. Scripts written without spaces never
/// form tokens, so a name inside them keeps matching as a substring.
pub(super) fn is_word_char(ch: char) -> bool {
  !is_unspaced_script(ch) && (ch.is_alphanumeric() || is_combining_mark(ch))
}

pub(super) fn is_unspaced_script(ch: char) -> bool {
  matches!(u32::from(ch),
    0x0E00..=0x0EFF // Thai, Lao
    | 0x1000..=0x109F // Myanmar
    | 0x1780..=0x17FF // Khmer
    | 0x3040..=0x30FF // Hiragana, Katakana
    | 0x3400..=0x4DBF // CJK Extension A
    | 0x4E00..=0x9FFF // CJK Unified Ideographs
    | 0xAC00..=0xD7AF // Hangul Syllables
    | 0xF900..=0xFAFF // CJK Compatibility
    | 0x20000..=0x323AF // CJK Extensions B-I
  )
}

/// Neighbourhood checks for candidate spans in one document. Marker runs
/// are indexed once; adjacent scans stop after one joined segment.
pub(super) struct CandidatePolicy<'t> {
  text: &'t str,
  /// Outermost balanced `⟦…⟧` markers, sorted and disjoint.
  markers: Vec<(usize, usize)>,
  /// Characters the scans have looked at, for scaling tests.
  pub(super) visits: Cell<usize>,
}

impl<'t> CandidatePolicy<'t> {
  pub(super) fn new(text: &'t str) -> Self {
    Self {
      text,
      markers: markers(text),
      visits: Cell::new(0),
    }
  }

  fn visit<I: Iterator<Item = char>>(
    &self,
    chars: I,
  ) -> impl Iterator<Item = char> {
    chars.inspect(|_| self.visits.set(self.visits.get().saturating_add(1)))
  }

  /// Whether the span's edges sit on token boundaries. Digits glued to a
  /// letter edge are allowed (`Acme2024`, `novak2`); letters, or digit runs
  /// mixed with letters (`acme0a1b`), are not.
  pub(super) fn edges_are_free(&self, start: usize, end: usize) -> bool {
    let head = self.text.get(..start).unwrap_or_default();
    let tail = self.text.get(end..).unwrap_or_default();
    let span = self.text.get(start..end).unwrap_or_default();
    glue_is_free(
      self
        .visit(head.chars().rev())
        .take_while(|ch| is_word_char(*ch)),
      span.chars().next(),
    ) && glue_is_free(
      self.visit(tail.chars()).take_while(|ch| is_word_char(*ch)),
      span.chars().next_back(),
    )
  }

  /// Whether the span belongs to an identifier: it sits inside a `⟦…⟧`
  /// marker, or a compound joiner links it to an identifier-shaped segment
  /// (`9b1d0c3e-acfe-4c1b`). Plain numbers, years, and words next to a name
  /// (`Acme/2024`, `Novák-1`, `acme.cz`) do not count.
  pub(super) fn in_identifier(&self, start: usize, end: usize) -> bool {
    let head = self.text.get(..start).unwrap_or_default();
    let tail = self.text.get(end..).unwrap_or_default();
    self.in_marker(start, end)
      || joined_segment(
        self
          .visit(head.chars().rev())
          .skip_while(|ch| is_word_char(*ch)),
      )
      .is_some_and(|segment| is_identifier_segment(&segment))
      || joined_segment(
        self.visit(tail.chars()).skip_while(|ch| is_word_char(*ch)),
      )
      .is_some_and(|segment| is_identifier_segment(&segment))
  }

  /// Whether a balanced `⟦…⟧` marker encloses the span: one binary search
  /// over the indexed markers.
  pub(super) fn in_marker(&self, start: usize, end: usize) -> bool {
    let opened_before = self.markers.partition_point(|(open, _)| *open < start);
    opened_before
      .checked_sub(1)
      .and_then(|index| self.markers.get(index))
      .is_some_and(|(_, close)| *close >= end)
  }
}

/// Outermost balanced `⟦…⟧` markers as `(open, close)` byte offsets, in one
/// pass. Markers never contain whitespace, so whitespace drops any bracket
/// still open; a `⟧` without an open `⟦` is ignored.
fn markers(text: &str) -> Vec<(usize, usize)> {
  let mut markers = Vec::new();
  if !text.contains('⟦') {
    return markers;
  }
  let mut open = Vec::new();
  for (index, ch) in text.char_indices() {
    match ch {
      '⟦' => open.push(index),
      '⟧' => {
        if let Some(start) = open.pop()
          && open.is_empty()
        {
          markers.push((start, index));
        }
      }
      _ if ch.is_whitespace() => open.clear(),
      _ => {}
    }
  }
  markers
}

fn glue_is_free(
  mut glue: impl Iterator<Item = char>,
  edge: Option<char>,
) -> bool {
  let Some(first) = glue.next() else {
    return true;
  };
  // A span ending in punctuation (`Inc.`) does not cut into the next token.
  if !edge.is_some_and(is_word_char) {
    return true;
  }
  edge.is_some_and(char::is_alphabetic)
    && first.is_numeric()
    && glue.all(char::is_numeric)
}

/// The word run behind one or more compound joiners at the start of `chars`.
/// The run comes back reversed when `chars` walks backwards; the shape test
/// does not depend on order.
fn joined_segment(chars: impl Iterator<Item = char>) -> Option<String> {
  let mut chars = chars.peekable();
  let mut joined = false;
  while chars.next_if(|ch| COMPOUND_JOINERS.contains(ch)).is_some() {
    joined = true;
  }
  let segment = chars.take_while(|ch| is_word_char(*ch)).collect::<String>();
  (joined && !segment.is_empty()).then_some(segment)
}

/// Hex with both digits and hex letters (`4c1b`, `9b1d0c3e`), or a long
/// mixed-case alphanumeric run (`QWNtZUEvb3Ji`).
fn is_identifier_segment(segment: &str) -> bool {
  let chars = segment.chars().count();
  let has_digit = segment.chars().any(|ch| ch.is_ascii_digit());
  let hex = chars >= MIN_HEX_SEGMENT_CHARS
    && has_digit
    && segment.chars().all(|ch| ch.is_ascii_hexdigit())
    && segment.chars().any(|ch| ch.is_ascii_alphabetic());
  let base64 = chars >= MIN_BASE64_SEGMENT_CHARS
    && has_digit
    && segment.chars().any(char::is_uppercase)
    && segment.chars().any(char::is_lowercase);
  hex || base64
}
