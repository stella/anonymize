//! Balanced outermost marker ranges used by the fuzz oracle.

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
