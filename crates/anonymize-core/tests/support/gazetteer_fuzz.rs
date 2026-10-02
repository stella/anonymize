//! Exercise the public gazetteer path with bounded arbitrary entries and text.
//! Fixed opaque envelopes keep the privacy invariant meaningful with empty
//! fuzz input or input that contains no useful gazetteer term.

use super::gazetteer_policy::CandidatePolicy;
use super::gazetteer_reference;

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
    .filter(|chunk| {
      // Marker-bearing caller literals have special exact-match semantics,
      // outside this oracle's protected-token input contract.
      !chunk.is_empty() && !chunk.contains(['⟦', '⟧'])
    })
    .collect::<Vec<_>>();
  let remaining_text = chunks.collect::<Vec<_>>().join("\n");
  let mut text = bounded_chars(&remaining_text, MAX_TEXT_CHARS);

  entries.push(OPAQUE_TERM.to_owned());
  entries.push(HIT_TERM.to_owned());
  text.push('\n');
  let hit_start = text.len();
  text.push_str(HIT_TERM);
  let hit_end = text.len();
  let protected = append_opaque_envelopes(&mut text);
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

  // Probe every Unicode boundary, including rejected candidates, rather than
  // checking only spans that the matcher already admitted.
  let policy = CandidatePolicy::new(&text);
  for (start, ch) in text.char_indices() {
    let end = start + ch.len_utf8();
    assert_eq!(
      (
        policy.edges_are_free(start, end),
        policy.in_identifier(start, end)
      ),
      gazetteer_reference::acceptance(&text, start..end),
      "production/reference candidate policy divergence"
    );
  }
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
      policy.edges_are_free(start, end),
      "gazetteer span splits a word"
    );

    // Arbitrary caller entries may cover normalized complete identifiers or
    // eligible subsegments. Only the injected short seed has fixed rejection
    // semantics in these envelopes; assert that independently of the policy.
    assert!(
      protected.iter().all(|(opaque_start, opaque_end)| {
        text
          .get(*opaque_start..*opaque_end)
          .into_iter()
          .flat_map(|opaque| opaque.match_indices(OPAQUE_TERM))
          .all(|(offset, term)| {
            start != opaque_start.saturating_add(offset)
              || end
                != opaque_start
                  .saturating_add(offset)
                  .saturating_add(term.len())
          })
      }),
      "injected seed matched inside a protected opaque token"
    );
    assert!(
      !policy.identifier(start..end, || {
        text.get(start..end).is_some_and(shows_a_name)
      }),
      "gazetteer span is joined to an identifier segment"
    );
  }
}

/// Whether `surface` shows a name: a capital letter, or letters only of
/// scripts without case or written in one case (Georgian Mkhedruli). A template field kept as a name must show one
/// (`[[Zeta2024]]`, `[[محمد2024]]`).
fn shows_a_name(surface: &str) -> bool {
  let letters = surface
    .chars()
    .filter(|character| character.is_alphabetic())
    .collect::<Vec<_>>();
  !letters.is_empty()
    && (letters.iter().any(|character| character.is_uppercase())
      || letters.iter().all(|character| {
        !character.is_lowercase()
          || ('\u{10D0}'..='\u{10FF}').contains(character)
      }))
}
