use std::ops::Range;
use std::sync::OnceLock;

use unicode_normalization::char::is_combining_mark;
use unicode_segmentation::UnicodeSegmentation;

use crate::byte_offsets::ByteOffsets;
use crate::gazetteer::is_unspaced_script;
use crate::types::Result;

/// The stretches of a document no entity edge may cut: words of spaced
/// scripts, joined across an inner apostrophe (`O'Connor`), and every other
/// grapheme cluster of more than one character (`ซื้`, `e\u{301}`).
/// A character of a script written without spaces is never part of a word:
/// its word edges are not in the text, so only its clusters are kept whole.
#[derive(Debug)]
pub(super) struct WordAnalysis {
  /// Sorted, disjoint byte ranges.
  units: Vec<Range<u32>>,
}

impl WordAnalysis {
  /// Start of the unit `position` sits strictly inside, else `position`.
  pub(super) fn word_start_at(&self, position: u32) -> u32 {
    self
      .unit_around(position)
      .map_or(position, |unit| unit.start)
  }

  /// End of the unit `position` sits strictly inside, else `position`.
  pub(super) fn word_end_at(&self, position: u32) -> u32 {
    self.unit_around(position).map_or(position, |unit| unit.end)
  }

  fn unit_around(&self, position: u32) -> Option<&Range<u32>> {
    let index = self.units.partition_point(|unit| unit.end <= position);
    self.units.get(index).filter(|unit| unit.start < position)
  }
}

pub(crate) struct ResolutionDocument<'a> {
  text: &'a str,
  line_starts: OnceLock<Vec<usize>>,
  #[cfg(test)]
  line_operations: std::cell::Cell<usize>,
  word_analysis: OnceLock<WordAnalysis>,
}

impl<'a> ResolutionDocument<'a> {
  pub(crate) const fn new(text: &'a str) -> Self {
    Self {
      text,
      line_starts: OnceLock::new(),
      #[cfg(test)]
      line_operations: std::cell::Cell::new(0),
      word_analysis: OnceLock::new(),
    }
  }

  pub(crate) const fn text(&self) -> &'a str {
    self.text
  }

  pub(crate) const fn offsets(&self) -> ByteOffsets<'a> {
    ByteOffsets::new(self.text)
  }

  pub(crate) fn slice_ref(&self, start: u32, end: u32) -> Result<&'a str> {
    self.offsets().slice_ref(start, end)
  }

  pub(crate) fn line_range(
    &self,
    start: usize,
    end: usize,
  ) -> Option<Range<usize>> {
    if start > end || end > self.text.len() {
      return None;
    }
    let starts = self.line_starts();
    let line_index = self.line_index_at(start)?;
    let line_start = *starts.get(line_index)?;
    let line_end = starts
      .get(line_index.saturating_add(1))
      .and_then(|next_start| self.delimiter_start_before(*next_start))
      .unwrap_or(self.text.len());
    (end <= line_end).then_some(line_start..line_end)
  }

  pub(crate) fn line_prefix_and_previous(
    &self,
    offset: usize,
  ) -> Option<(&'a str, Option<&'a str>)> {
    if offset > self.text.len() {
      return None;
    }
    let starts = self.line_starts();
    let line_index = self.line_index_at(offset)?;
    let line_start = *starts.get(line_index)?;
    let current = self.text.get(line_start..offset)?;
    let Some(previous_index) = line_index.checked_sub(1) else {
      return Some((current, None));
    };
    let previous_start = *starts.get(previous_index)?;
    let previous_end = self.delimiter_start_before(line_start)?;
    let separator = self.text.get(previous_end..line_start)?;
    if separator.starts_with('\u{2029}') {
      return Some((current, None));
    }
    Some((current, self.text.get(previous_start..previous_end)))
  }

  fn line_starts(&self) -> &[usize] {
    self.line_starts.get_or_init(|| {
      let mut starts = vec![0];
      let bytes = self.text.as_bytes();
      let mut index = 0_usize;
      while index < bytes.len() {
        #[cfg(test)]
        self
          .line_operations
          .set(self.line_operations.get().saturating_add(1));
        let delimiter_len = line_delimiter_len(bytes, index);
        if delimiter_len == 0 {
          index = index.saturating_add(1);
          continue;
        }
        index = index.saturating_add(delimiter_len);
        starts.push(index);
      }
      starts
    })
  }

  fn line_index_at(&self, offset: usize) -> Option<usize> {
    let starts = self.line_starts();
    let mut left = 0_usize;
    let mut right = starts.len();
    while left < right {
      #[cfg(test)]
      self
        .line_operations
        .set(self.line_operations.get().saturating_add(1));
      let middle = left.midpoint(right);
      if *starts.get(middle)? <= offset {
        left = middle.saturating_add(1);
      } else {
        right = middle;
      }
    }
    left.checked_sub(1)
  }

  fn delimiter_start_before(&self, line_start: usize) -> Option<usize> {
    let before = self.text.get(..line_start)?;
    let (last_start, last) = before.char_indices().next_back()?;
    if last == '\n'
      && let Some((carriage_start, '\r')) =
        before.get(..last_start)?.char_indices().next_back()
    {
      return Some(carriage_start);
    }
    is_line_delimiter(last).then_some(last_start)
  }

  pub(super) fn word_analysis(&self) -> &WordAnalysis {
    self.word_analysis.get_or_init(|| WordAnalysis {
      units: word_units(self.text),
    })
  }
}

fn line_delimiter_len(bytes: &[u8], index: usize) -> usize {
  match bytes.get(index..) {
    Some([b'\r', b'\n', ..]) => 2,
    Some([b'\r' | b'\n', ..]) => 1,
    Some([0xe2, 0x80, 0xa8 | 0xa9, ..]) => 3,
    _ => 0,
  }
}

const fn is_line_delimiter(ch: char) -> bool {
  matches!(ch, '\r' | '\n' | '\u{2028}' | '\u{2029}')
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ClusterClass {
  Word,
  Connector,
  Other,
}

fn cluster_class(cluster: &str) -> ClusterClass {
  let Some(first) = cluster.chars().next() else {
    return ClusterClass::Other;
  };
  if is_unspaced_script(first) {
    ClusterClass::Other
  } else if first.is_alphanumeric() || is_combining_mark(first) {
    ClusterClass::Word
  } else if cluster.chars().count() == 1 && is_word_connector(first) {
    ClusterClass::Connector
  } else {
    ClusterClass::Other
  }
}

fn word_units(text: &str) -> Vec<Range<u32>> {
  let mut units = Vec::new();
  let mut word = None::<Range<usize>>;
  // A connector joins only when a word cluster follows it.
  let mut pending_connector = false;
  let mut push = |range: Range<usize>| {
    if let (Ok(start), Ok(end)) =
      (u32::try_from(range.start), u32::try_from(range.end))
    {
      units.push(start..end);
    }
  };

  for (start, cluster) in text.grapheme_indices(true) {
    let end = start.saturating_add(cluster.len());
    let class = cluster_class(cluster);
    if class == ClusterClass::Word {
      pending_connector = false;
      match word.as_mut() {
        Some(run) => run.end = end,
        None => word = Some(start..end),
      }
      continue;
    }
    if class == ClusterClass::Connector && word.is_some() && !pending_connector
    {
      pending_connector = true;
      continue;
    }
    if let Some(run) = word.take() {
      push(run);
    }
    pending_connector = false;
    if cluster.chars().nth(1).is_some() {
      push(start..end);
    }
  }
  if let Some(run) = word {
    push(run);
  }
  units
}

const fn is_word_connector(ch: char) -> bool {
  matches!(ch, '\'' | '\u{2018}' | '\u{2019}' | '\u{02bc}' | '\u{ff07}')
}

#[cfg(test)]
mod tests {
  use proptest::prelude::*;

  use super::ResolutionDocument;

  fn generated_text(segments: &[String], ending_codes: &[u8]) -> String {
    let mut text = String::new();
    for (index, segment) in segments.iter().enumerate() {
      text.push_str(segment);
      if index.saturating_add(1) == segments.len() {
        continue;
      }
      let ending = ending_codes
        .get(index.checked_rem(ending_codes.len()).unwrap_or_default())
        .copied()
        .unwrap_or_default();
      text.push_str(match ending % 5 {
        0 => "\n",
        1 => "\r\n",
        2 => "\r",
        3 => "\u{2028}",
        _ => "\u{2029}",
      });
    }
    text
  }

  fn reference_line_ranges(text: &str) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let mut line_start = 0_usize;
    let mut chars = text.char_indices().peekable();
    while let Some((offset, ch)) = chars.next() {
      let delimiter_len = match ch {
        '\r' if chars.peek().is_some_and(|(_, next)| *next == '\n') => {
          chars.next();
          2
        }
        '\r' | '\n' => 1,
        '\u{2028}' | '\u{2029}' => ch.len_utf8(),
        _ => continue,
      };
      ranges.push(line_start..offset);
      line_start = offset.saturating_add(delimiter_len);
    }
    ranges.push(line_start..text.len());
    ranges
  }

  proptest! {
    #[test]
    fn generated_line_index_matches_reference_model(
      segments in proptest::collection::vec("[A-Za-z0-9 ]{0,16}", 1..32),
      ending_codes in proptest::collection::vec(any::<u8>(), 0..32),
      queries in proptest::collection::vec((any::<usize>(), any::<usize>()), 0..64),
    ) {
      let text = generated_text(&segments, &ending_codes);
      let ranges = reference_line_ranges(&text);
      let document = ResolutionDocument::new(&text);
      for (first, second) in queries {
        let divisor = text.len().saturating_add(1);
        let left = first.checked_rem(divisor).unwrap_or_default();
        let right = second.checked_rem(divisor).unwrap_or_default();
        let start = left.min(right);
        let end = left.max(right);
        let expected = ranges
          .iter()
          .find(|range| start >= range.start && end <= range.end)
          .cloned();

        prop_assert_eq!(document.line_range(start, end), expected);
      }
    }
  }

  #[test]
  fn word_analysis_is_built_once_and_reused() {
    let document = ResolutionDocument::new("Jean d’Arc");
    let first = document.word_analysis();
    let second = document.word_analysis();

    assert!(std::ptr::eq(first, second));
    assert_eq!(first.word_start_at(10), 5);
    assert_eq!(first.word_end_at(6), 12);
    assert_eq!(first.word_end_at(4), 4);
  }

  #[test]
  fn word_units_keep_clusters_whole_and_never_cross_non_word_text() {
    let cases: [(&str, u32, u32, u32); 6] = [
      // Edges inside a spaced word extend to the word.
      ("Kontaktujte Novák prosím.", 15, 12, 18),
      // A run of an unspaced script is no word: only clusters stay whole.
      ("本契約は紫苑工房と締結", 12, 12, 12),
      ("ผู้ซื้อคือกมลวรรณ", 30, 30, 30),
      ("ผู้ซื้อ", 12, 9, 18),
      // Punctuation between two edges is never absorbed.
      ("<<Beta s.r.o.>> je", 13, 13, 13),
      ("„Beta s.r.o.“ je", 14, 14, 14),
    ];
    for (text, position, start, end) in cases {
      let document = ResolutionDocument::new(text);
      let analysis = document.word_analysis();
      assert_eq!(analysis.word_start_at(position), start, "{text}");
      assert_eq!(analysis.word_end_at(position), end, "{text}");
    }
  }

  #[test]
  fn line_ranges_are_built_lazily_and_reused() {
    let document = ResolutionDocument::new("first\nsecond");

    assert!(document.line_starts.get().is_none());
    assert_eq!(document.line_range(6, 12), Some(6..12));
    let first = document.line_starts.get().map(Vec::as_ptr);
    assert!(first.is_some());
    assert_eq!(document.line_range(0, 5), Some(0..5));
    assert_eq!(first, document.line_starts.get().map(Vec::as_ptr));
  }

  #[test]
  fn line_ranges_support_all_line_endings() {
    for (text, range) in [
      ("first\nsecond", 6..12),
      ("first\r\nsecond", 7..13),
      ("first\rsecond", 6..12),
      ("first\u{2028}second", 8..14),
      ("first\u{2029}second", 8..14),
    ] {
      let document = ResolutionDocument::new(text);
      assert_eq!(document.line_range(range.start, range.end), Some(range));
    }
  }

  #[test]
  fn line_prefix_returns_adjacent_previous_line() {
    for (text, expected_previous) in [
      ("Name:\nAlice", Some("Name:")),
      ("Name:\r\nAlice", Some("Name:")),
      ("Name:\u{2028}Alice", Some("Name:")),
      ("Name:\u{2029}Alice", None),
      ("Name:\n\nAlice", Some("")),
    ] {
      let document = ResolutionDocument::new(text);
      let offset = text.len().saturating_sub("Alice".len());
      assert_eq!(
        document.line_prefix_and_previous(offset),
        Some(("", expected_previous))
      );
    }
  }

  #[test]
  fn dense_line_queries_have_bounded_structural_work() {
    const LINE_COUNT: usize = 10_000;
    let text = "x\n".repeat(LINE_COUNT);
    let document = ResolutionDocument::new(&text);

    for index in 0..LINE_COUNT {
      let start = index.saturating_mul(2);
      assert_eq!(
        document.line_range(start, start + 1),
        Some(start..start + 1)
      );
    }

    let linear_build_work = text.len();
    let logarithmic_query_work = LINE_COUNT.saturating_mul(20);
    assert!(
      document.line_operations.get()
        <= linear_build_work.saturating_add(logarithmic_query_work)
    );
  }
}
