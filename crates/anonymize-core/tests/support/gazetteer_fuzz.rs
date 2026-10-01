//! Exercise the public gazetteer path with bounded arbitrary entries and text.
//! Fixed opaque envelopes keep the privacy invariant meaningful with empty
//! fuzz input or input that contains no useful gazetteer term.

use super::gazetteer;

const MAX_INPUT_BYTES: usize = 768;
const MAX_ENTRIES: usize = 4;
const MAX_ENTRY_CHARS: usize = 40;
const MAX_TEXT_CHARS: usize = 512;
const OPAQUE_TERM: &str = "dead";
const HIT_TERM: &str = "NeutralFixture";
const ID_COMPOUND: &str = "a1b2-dead-c3d4";

fn bounded_chars(value: &str, limit: usize) -> String {
  value.chars().take(limit).collect()
}

fn is_combining_mark(character: char) -> bool {
  matches!(
    u32::from(character),
    0x0300..=0x036f
      | 0x0483..=0x0489
      | 0x0591..=0x05bd
      | 0x05bf
      | 0x05c1..=0x05c2
      | 0x05c4..=0x05c5
      | 0x0610..=0x061a
      | 0x064b..=0x065f
      | 0x0670
      | 0x06d6..=0x06ed
      | 0x1ab0..=0x1aff
      | 0x1dc0..=0x1dff
      | 0x20d0..=0x20ff
      | 0xfe20..=0xfe2f
  )
}

fn is_word_interior(character: char) -> bool {
  !is_unspaced_script(character)
    && (character.is_alphanumeric() || is_combining_mark(character))
}

fn is_unspaced_script(character: char) -> bool {
  matches!(u32::from(character),
    0x0E00..=0x0EFF | 0x1000..=0x109F | 0x1780..=0x17FF
    | 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
    | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0x20000..=0x323AF)
}

fn marker_ranges(text: &str) -> Vec<(usize, usize)> {
  let mut ranges = Vec::new();
  let mut marker_start = None;
  for (offset, character) in text.char_indices() {
    if character.is_whitespace() {
      marker_start = None;
    } else if character == '⟦' {
      marker_start = Some(offset);
    } else if character == '⟧'
      && let Some(start) = marker_start.take()
    {
      ranges.push((start, offset + character.len_utf8()));
    }
  }
  ranges
}

fn append_opaque_envelopes(text: &mut String) -> Vec<(usize, usize)> {
  let uuid = "a1b2dead-dead-c3d4-a1b2-c3d4deadbeef";
  let hex = "a1b2deadc3d4";
  let samples = [
    format!("https://example.test/path/{ID_COMPOUND}/end"),
    format!("neutral+{ID_COMPOUND}@example.test"),
    format!("prefix_{ID_COMPOUND}_suffix"),
    format!("[{ID_COMPOUND}]"),
    format!("⟦{ID_COMPOUND}⟧"),
    format!("code:{uuid}"),
    format!("hash:{hex}"),
  ];
  let mut ranges = Vec::new();
  for sample in samples {
    text.push('\n');
    let base = text.len();
    if let Some(offset) = sample.find(ID_COMPOUND) {
      ranges.push((base + offset, base + offset + ID_COMPOUND.len()));
    } else if let Some(offset) = sample.find(uuid) {
      ranges.push((base + offset, base + offset + uuid.len()));
    } else if let Some(offset) = sample.find(hex) {
      ranges.push((base + offset, base + offset + hex.len()));
    }
    text.push_str(&sample);
  }
  ranges
}

fn is_identifier_segment(segment: &str) -> bool {
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

const fn is_compound_joiner(character: char) -> bool {
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
      let mut chars = head.chars().rev().peekable();
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
      let mut chars = tail.chars().peekable();
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

fn touches_identifier(text: &str, start: usize, end: usize) -> bool {
  adjacent_identifier_segment(text, Edge::Start(start))
    .is_some_and(|value| is_identifier_segment(&value))
    || adjacent_identifier_segment(text, Edge::End(end))
      .is_some_and(|value| is_identifier_segment(&value))
}

fn edges_are_free(text: &str, start: usize, end: usize) -> bool {
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

fn glue_is_free(glue: &[char], edge: Option<char>) -> bool {
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

pub(super) fn exercise(data: &[u8]) {
  // Arbitrary bytes become synthetic text before any offsets are measured.
  // Preserve valid chunks and replace each invalid sequence with one marker.
  let mut input = String::new();
  for chunk in data[..data.len().min(MAX_INPUT_BYTES)].utf8_chunks() {
    input.push_str(chunk.valid());
    if !chunk.invalid().is_empty() {
      input.push(char::REPLACEMENT_CHARACTER);
    }
  }
  let mut chunks = input.split('\n');
  let mut entries = chunks
    .by_ref()
    .take(MAX_ENTRIES)
    .map(|chunk| bounded_chars(chunk, MAX_ENTRY_CHARS))
    .filter(|chunk| !chunk.is_empty())
    .collect::<Vec<_>>();
  let remaining_text = chunks.collect::<Vec<_>>().join("\n");
  let mut text = bounded_chars(&remaining_text, MAX_TEXT_CHARS);

  entries.push(OPAQUE_TERM.to_owned());
  entries.push(HIT_TERM.to_owned());
  text.push('\n');
  let hit_start = text.len();
  text.push_str(HIT_TERM);
  let hit_end = text.len();
  let mut protected = marker_ranges(&text);
  protected.extend(append_opaque_envelopes(&mut text));
  let engine = gazetteer::engine(&entries, "cs")
    .unwrap_or_else(|error| panic!("bounded synthetic config failed: {error}"));
  let entities = engine
    .detect_static_entities(&text)
    .unwrap_or_else(|error| panic!("bounded synthetic text failed: {error}"))
    .entities
    .all_entities();

  assert!(
    entities.iter().any(|entity| {
      usize::try_from(entity.start).ok() == Some(hit_start)
        && usize::try_from(entity.end).ok() == Some(hit_end)
    }),
    "manufactured plain gazetteer term was not detected"
  );

  for entity in entities {
    let start = usize::try_from(entity.start).expect("entity start fits usize");
    let end = usize::try_from(entity.end).expect("entity end fits usize");
    assert!(
      start <= end && end <= text.len(),
      "entity range is out of bounds"
    );
    assert!(text.is_char_boundary(start), "entity start splits UTF-8");
    assert!(text.is_char_boundary(end), "entity end splits UTF-8");

    assert!(
      edges_are_free(&text, start, end),
      "gazetteer span splits a word"
    );

    assert!(
      protected.iter().all(|(opaque_start, opaque_end)| {
        end <= *opaque_start || start >= *opaque_end
          // Caller-specified identifier values may match exactly in full.
          || (start <= *opaque_start && end >= *opaque_end
            && entries.iter().any(|entry| text.get(start..end) == Some(entry.as_str())))
      }),
      "gazetteer span overlaps a protected opaque token"
    );
    assert!(
      !touches_identifier(&text, start, end),
      "gazetteer span is joined to an identifier segment"
    );
  }
}
