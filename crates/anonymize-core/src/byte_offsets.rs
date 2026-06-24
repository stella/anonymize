use crate::types::{Error, Result};

pub(crate) struct ByteOffsets<'a> {
  text: &'a str,
}

impl<'a> ByteOffsets<'a> {
  pub(crate) const fn new(text: &'a str) -> Self {
    Self { text }
  }

  pub(crate) fn len(&self) -> Result<u32> {
    u32::try_from(self.text.len())
      .map_err(|_| Error::ByteOffsetOutOfBounds { offset: u32::MAX })
  }

  pub(crate) fn validate_offset(&self, offset: u32) -> Result<usize> {
    let index = usize::try_from(offset)
      .map_err(|_| Error::ByteOffsetOutOfBounds { offset })?;
    if index > self.text.len() {
      return Err(Error::ByteOffsetOutOfBounds { offset });
    }
    if !self.text.is_char_boundary(index) {
      return Err(Error::ByteOffsetInsideCodepoint { offset });
    }
    Ok(index)
  }

  pub(crate) fn floor_offset(&self, offset: u32) -> Result<u32> {
    let mut index = usize::try_from(offset)
      .map_err(|_| Error::ByteOffsetOutOfBounds { offset })?;
    if index > self.text.len() {
      index = self.text.len();
    }
    while index > 0 && !self.text.is_char_boundary(index) {
      index = index.saturating_sub(1);
    }
    u32::try_from(index)
      .map_err(|_| Error::ByteOffsetOutOfBounds { offset: u32::MAX })
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
