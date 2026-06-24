use crate::types::{Error, Result};

pub(crate) struct Utf16Offsets {
  offsets: Vec<Option<usize>>,
}

impl Utf16Offsets {
  pub(crate) fn new(text: &str) -> Self {
    let capacity = text.encode_utf16().count().saturating_add(1);
    let mut offsets = Vec::with_capacity(capacity);
    offsets.push(Some(0));

    let mut byte_cursor: usize = 0;
    for ch in text.chars() {
      byte_cursor = byte_cursor.saturating_add(ch.len_utf8());
      if ch.len_utf16() == 2 {
        offsets.push(None);
      }
      offsets.push(Some(byte_cursor));
    }

    Self { offsets }
  }

  pub(crate) fn len(&self) -> Result<u32> {
    let len = self
      .offsets
      .len()
      .checked_sub(1)
      .ok_or(Error::Utf16OffsetOutOfBounds { offset: 0 })?;
    u32::try_from(len)
      .map_err(|_| Error::Utf16OffsetOutOfBounds { offset: u32::MAX })
  }

  pub(crate) fn validate_offset(&self, offset: u32) -> Result<usize> {
    let index = usize::try_from(offset)
      .map_err(|_| Error::Utf16OffsetOutOfBounds { offset })?;
    self
      .offsets
      .get(index)
      .copied()
      .ok_or(Error::Utf16OffsetOutOfBounds { offset })?
      .ok_or(Error::Utf16OffsetInsideSurrogate { offset })
  }

  pub(crate) fn slice(
    &self,
    full_text: &str,
    start: u32,
    end: u32,
  ) -> Result<String> {
    if start > end {
      return Err(Error::InvalidSpan { start, end });
    }

    let start_byte = self.validate_offset(start)?;
    let end_byte = self.validate_offset(end)?;

    Ok(
      full_text
        .get(start_byte..end_byte)
        .ok_or(Error::InvalidSpan { start, end })?
        .to_owned(),
    )
  }
}
