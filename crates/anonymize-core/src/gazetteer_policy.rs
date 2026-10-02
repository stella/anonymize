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

/// Every block of the scripts written without spaces between words: Thai,
/// Lao, Myanmar, Khmer, Hiragana, Katakana, Hangul, and CJK ideographs.
pub(super) fn is_unspaced_script(ch: char) -> bool {
  matches!(u32::from(ch),
    0x0E00..=0x0EFF // Thai, Lao
    | 0x1000..=0x109F // Myanmar
    | 0x1100..=0x11FF // Hangul Jamo
    | 0x1780..=0x17FF // Khmer
    | 0x19E0..=0x19FF // Khmer Symbols
    | 0x2E80..=0x2FDF // CJK Radicals Supplement, Kangxi Radicals
    | 0x3040..=0x30FF // Hiragana, Katakana
    | 0x3130..=0x318F // Hangul Compatibility Jamo
    | 0x31F0..=0x31FF // Katakana Phonetic Extensions
    | 0x3400..=0x4DBF // CJK Extension A
    | 0x4E00..=0x9FFF // CJK Unified Ideographs
    | 0xA960..=0xA97F // Hangul Jamo Extended-A
    | 0xA9E0..=0xA9FF // Myanmar Extended-B
    | 0xAA60..=0xAA7F // Myanmar Extended-A
    | 0xAC00..=0xD7AF // Hangul Syllables
    | 0xD7B0..=0xD7FF // Hangul Jamo Extended-B
    | 0xF900..=0xFAFF // CJK Compatibility Ideographs
    | 0xFF66..=0xFFDC // Halfwidth Katakana and Hangul
    | 0x116D0..=0x116FF // Myanmar Extended-C
    | 0x1AFF0..=0x1B16F // Kana Extended-B, Supplement, Extended-A, Small
    | 0x20000..=0x323AF // CJK Extensions B-I, Compatibility Supplement
  )
}

/// Candidate boundaries and identifier context, shared with the fuzz driver.
pub(super) struct CandidatePolicy<'t> {
  text: &'t str,
  pub(super) markers: Markers,
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
    self.identifier(start..end, || false)
  }

  /// See [`Self::in_identifier`]; `spelling` is the entry's, for an exact
  /// hit, checked only for a hit in a template field.
  pub(super) fn identifier(
    &self,
    span: std::ops::Range<usize>,
    spells: impl FnOnce() -> bool,
  ) -> bool {
    let start = span.start;
    let end = span.end;
    let head = self.text.get(..start).unwrap_or_default();
    let tail = self.text.get(end..).unwrap_or_default();
    let before = joined_segment(
      self
        .visit(head.chars().rev())
        .skip_while(|ch| is_word_char(*ch)),
    );
    let after = joined_segment(
      self.visit(tail.chars()).skip_while(|ch| is_word_char(*ch)),
    );
    let in_marker = match self.marker_kind(start, end) {
      Some(MarkerKind::Opaque) => true,
      // A template placeholder may hold a real name (`[[Orbis]]`,
      // `<<Novák>>`); only a field built around it (`<<token:zeta9>>`,
      // `{{acme_01}}`) is an identifier.
      Some(MarkerKind::Template) => {
        let field = head.chars().next_back().is_some_and(is_word_char)
          || tail.chars().next().is_some_and(is_word_char)
          || [&before, &after]
            .into_iter()
            .flatten()
            .any(|segment| segment.chars().any(char::is_numeric));
        field && !spells()
      }
      None => false,
    };
    in_marker
      || before.is_some_and(|segment| is_identifier_segment(&segment))
      || after.is_some_and(|segment| is_identifier_segment(&segment))
  }

  pub(super) fn in_marker(&self, start: usize, end: usize) -> bool {
    encloses(&self.markers.opaque, start, end)
  }

  /// The strongest kind of balanced marker enclosing the span, if any: an
  /// opaque marker wins over a template around it. Binary searches over the
  /// indexed markers.
  fn marker_kind(&self, start: usize, end: usize) -> Option<MarkerKind> {
    if self.in_marker(start, end) {
      return Some(MarkerKind::Opaque);
    }
    encloses(&self.markers.template, start, end).then_some(MarkerKind::Template)
  }
}

/// What a balanced marker's content is taken to be.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum MarkerKind {
  /// `⟦…⟧`: an opaque marker; nothing inside it is a name.
  Opaque,
  /// `<<…>>`, `{{…}}`, `[[…]]`: a template placeholder or link that may hold
  /// a name.
  Template,
}

/// Marker delimiters and the kind of marker each opens.
const MARKER_DELIMITERS: [(&str, &str, MarkerKind); 4] = [
  ("⟦", "⟧", MarkerKind::Opaque),
  ("<<", ">>", MarkerKind::Template),
  ("{{", "}}", MarkerKind::Template),
  ("[[", "]]", MarkerKind::Template),
];

/// Balanced markers by kind. Each kind is scanned on its own, so an opaque
/// marker nested in a template stays suppressed (`[[⟦Zeta⟧]]`) and a
/// template delimiter never hides an opaque marker around it.
pub(super) fn markers(text: &str) -> Markers {
  let mut work = 0;
  Markers {
    opaque: marker_spans(text, MarkerKind::Opaque, &mut work),
    template: marker_spans(text, MarkerKind::Template, &mut work),
  }
}

/// Outermost balanced markers of one kind, in one pass, sorted and
/// disjoint. An opaque marker never contains whitespace; a template may, but
/// never a line break, so a delimiter still open there is dropped and
/// suppresses nothing after it. A closing delimiter that does not close the
/// innermost open one is ignored. `work` counts the steps and stack
/// entries visited, which stays linear in the text length.
pub(super) fn marker_spans(
  text: &str,
  kind: MarkerKind,
  work: &mut usize,
) -> Vec<(usize, usize)> {
  let delimiters = || {
    MARKER_DELIMITERS
      .iter()
      .filter(move |(_, _, delimiter_kind)| *delimiter_kind == kind)
  };
  let mut spans = Vec::new();
  if !delimiters().any(|(opener, _, _)| text.contains(opener)) {
    return spans;
  }
  let mut open = Vec::<(&str, usize)>::new();
  let mut index = 0_usize;
  while let Some(rest) = text.get(index..) {
    let Some(ch) = rest.chars().next() else {
      break;
    };
    let closes_all = match kind {
      MarkerKind::Opaque => ch.is_whitespace(),
      MarkerKind::Template => {
        matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
      }
    };
    *work = work.saturating_add(1);
    if closes_all {
      *work = work.saturating_add(open.len());
      open.clear();
    }
    if let Some((closer, start)) = open.last().copied()
      && rest.starts_with(closer)
    {
      open.pop();
      if open.is_empty() {
        spans.push((start, index));
      }
      index = index.saturating_add(closer.len());
      continue;
    }
    if let Some((opener, closer, _)) =
      delimiters().find(|(opener, _, _)| rest.starts_with(opener))
    {
      open.push((closer, index));
      index = index.saturating_add(opener.len());
      continue;
    }
    index = index.saturating_add(ch.len_utf8());
  }
  spans
}

/// Marker spans by kind, each sorted and disjoint.
#[derive(Debug, Default)]
pub(super) struct Markers {
  pub(super) opaque: Vec<(usize, usize)>,
  pub(super) template: Vec<(usize, usize)>,
}

/// Whether one of the sorted, disjoint `spans` encloses `start..end`.
pub(super) fn encloses(
  spans: &[(usize, usize)],
  start: usize,
  end: usize,
) -> bool {
  let opened_before = spans.partition_point(|(open, _)| *open < start);
  opened_before
    .checked_sub(1)
    .and_then(|index| spans.get(index))
    .is_some_and(|(_, close)| *close >= end)
}

pub(super) fn glue_is_free(
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
pub(super) fn is_identifier_segment(segment: &str) -> bool {
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
