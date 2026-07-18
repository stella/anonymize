//! Offset maps translating between UTF-8 byte offsets and the UTF-16 or
//! character offsets used at the binding boundary.

use crate::error::{ContractError, Result};

pub(crate) enum Utf16OffsetMap {
  Identity { byte_len: u32 },
  Boundaries(Vec<(u32, u32)>),
}

impl Utf16OffsetMap {
  pub(crate) fn new(text: &str) -> Result<Self> {
    if text.is_ascii() {
      return Ok(Self::Identity {
        byte_len: u32_from_usize(text.len())?,
      });
    }

    let mut boundaries = Vec::new();
    let mut utf16_offset = 0_u32;
    boundaries.push((0, 0));

    for (byte_start, ch) in text.char_indices() {
      utf16_offset = utf16_offset
        .checked_add(char_utf16_width(ch))
        .ok_or_else(|| ContractError::InvalidPreparedSearchPackage {
          reason: String::from("UTF-16 offset exceeds u32 range"),
        })?;
      let byte_end = byte_start.saturating_add(ch.len_utf8());
      boundaries.push((u32_from_usize(byte_end)?, utf16_offset));
    }

    Ok(Self::Boundaries(boundaries))
  }

  pub(crate) fn convert(&self, offset: u32) -> Result<u32> {
    self
      .try_convert(offset)
      .ok_or(ContractError::InvalidBindingOffset { offset })
  }

  fn try_convert(&self, offset: u32) -> Option<u32> {
    match self {
      Self::Identity { byte_len } => (offset <= *byte_len).then_some(offset),
      Self::Boundaries(boundaries) => {
        let index = boundaries
          .binary_search_by_key(&offset, |(byte_offset, _)| *byte_offset)
          .ok()?;
        boundaries.get(index).map(|(_, utf16_offset)| *utf16_offset)
      }
    }
  }

  pub(crate) fn byte_offset(&self, utf16_offset: u32) -> Result<u32> {
    let byte_offset = match self {
      Self::Identity { byte_len } => {
        (utf16_offset <= *byte_len).then_some(utf16_offset)
      }
      Self::Boundaries(boundaries) => {
        let index = boundaries
          .binary_search_by_key(&utf16_offset, |(_, offset)| *offset)
          .ok();
        index.and_then(|index| {
          boundaries.get(index).map(|(byte_offset, _)| *byte_offset)
        })
      }
    };
    byte_offset.ok_or(ContractError::InvalidBindingOffset {
      offset: utf16_offset,
    })
  }
}

pub(crate) struct CharacterOffsetMap {
  boundaries: Vec<(u32, u32)>,
}

impl CharacterOffsetMap {
  pub(crate) fn new(text: &str) -> Result<Self> {
    let mut boundaries = Vec::new();
    let mut character_offset = 0_u32;
    boundaries.push((0, 0));
    for (byte_start, ch) in text.char_indices() {
      character_offset = character_offset.checked_add(1).ok_or_else(|| {
        ContractError::InvalidPreparedSearchPackage {
          reason: String::from("Character offset exceeds u32 range"),
        }
      })?;
      boundaries.push((
        u32_from_usize(byte_start.saturating_add(ch.len_utf8()))?,
        character_offset,
      ));
    }
    Ok(Self { boundaries })
  }

  pub(crate) fn byte_offset(&self, character_offset: u32) -> Result<u32> {
    let index = self
      .boundaries
      .binary_search_by_key(&character_offset, |(_, offset)| *offset)
      .ok();
    index
      .and_then(|index| {
        self
          .boundaries
          .get(index)
          .map(|(byte_offset, _)| *byte_offset)
      })
      .ok_or(ContractError::InvalidBindingOffset {
        offset: character_offset,
      })
  }

  pub(crate) fn convert(&self, byte_offset: u32) -> Result<u32> {
    let index = self
      .boundaries
      .binary_search_by_key(&byte_offset, |(offset, _)| *offset)
      .ok();
    index
      .and_then(|index| {
        self
          .boundaries
          .get(index)
          .map(|(_, character_offset)| *character_offset)
      })
      .ok_or(ContractError::InvalidBindingOffset {
        offset: byte_offset,
      })
  }
}

const fn char_utf16_width(ch: char) -> u32 {
  if ch.len_utf16() == 1 { 1 } else { 2 }
}

fn u32_from_usize(value: usize) -> Result<u32> {
  u32::try_from(value).map_err(|_| {
    ContractError::InvalidPreparedSearchPackage {
      reason: format!("Offset exceeds u32 range: {value}"),
    }
  })
}

#[cfg(test)]
mod tests {
  #![allow(clippy::unwrap_used)]

  use super::{CharacterOffsetMap, Utf16OffsetMap};

  #[test]
  fn binding_input_offsets_map_to_utf8_boundaries() {
    let text = "😀Alice";
    assert_eq!(Utf16OffsetMap::new(text).unwrap().byte_offset(2), Ok(4));
    assert_eq!(CharacterOffsetMap::new(text).unwrap().byte_offset(1), Ok(4));
    assert_eq!(CharacterOffsetMap::new(text).unwrap().convert(4), Ok(1));
  }
}
