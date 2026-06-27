use crate::types::{Error, Result};

pub(crate) struct ArtifactWriter {
  bytes: Vec<u8>,
}

impl ArtifactWriter {
  pub(crate) fn new(header: [u8; 8], version: u32) -> Self {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&header);
    write_u32(&mut bytes, version);
    Self { bytes }
  }

  pub(crate) fn write_len(
    &mut self,
    len: usize,
    field: &'static str,
  ) -> Result<()> {
    write_u32(&mut self.bytes, checked_len_u32(len, field)?);
    Ok(())
  }

  pub(crate) fn write_len_prefixed_bytes(
    &mut self,
    field: &'static str,
    bytes: &[u8],
  ) -> Result<()> {
    self.write_len(bytes.len(), field)?;
    self.bytes.extend_from_slice(bytes);
    Ok(())
  }

  pub(crate) fn into_bytes(self) -> Vec<u8> {
    self.bytes
  }
}

pub(crate) struct ArtifactReader<'a> {
  bytes: &'a [u8],
  offset: usize,
  field: &'static str,
}

impl<'a> ArtifactReader<'a> {
  pub(crate) fn new(
    bytes: &'a [u8],
    header: [u8; 8],
    version: u32,
    field: &'static str,
  ) -> Result<Self> {
    let mut reader = Self {
      bytes,
      offset: 0,
      field,
    };
    let actual_header = reader.read_bytes(header.len())?;
    if actual_header != header {
      return Err(invalid_artifact(field, "unexpected header"));
    }
    let actual_version = reader.read_u32()?;
    if actual_version != version {
      return Err(invalid_artifact(field, "unsupported version"));
    }
    Ok(reader)
  }

  pub(crate) fn read_usize(&mut self) -> Result<usize> {
    usize::try_from(self.read_u32()?)
      .map_err(|_| invalid_artifact(self.field, "length is not addressable"))
  }

  pub(crate) fn read_len_prefixed_bytes(&mut self) -> Result<&'a [u8]> {
    let len = self.read_usize()?;
    self.read_bytes(len)
  }

  pub(crate) fn finish(&self) -> Result<()> {
    if self.offset == self.bytes.len() {
      return Ok(());
    }
    Err(invalid_artifact(self.field, "trailing data"))
  }

  fn read_u32(&mut self) -> Result<u32> {
    let bytes = self.read_bytes(4)?;
    let array = <[u8; 4]>::try_from(bytes)
      .map_err(|_| invalid_artifact(self.field, "malformed u32"))?;
    Ok(u32::from_le_bytes(array))
  }

  fn read_bytes(&mut self, len: usize) -> Result<&'a [u8]> {
    let end = self
      .offset
      .checked_add(len)
      .ok_or_else(|| invalid_artifact(self.field, "length overflow"))?;
    let bytes = self
      .bytes
      .get(self.offset..end)
      .ok_or_else(|| invalid_artifact(self.field, "truncated data"))?;
    self.offset = end;
    Ok(bytes)
  }
}

fn write_u32(bytes: &mut Vec<u8>, value: u32) {
  bytes.extend_from_slice(&value.to_le_bytes());
}

fn checked_len_u32(len: usize, field: &'static str) -> Result<u32> {
  u32::try_from(len).map_err(|_| Error::InvalidStaticData {
    field,
    reason: format!("length exceeds u32: {len}"),
  })
}

fn invalid_artifact(field: &'static str, reason: impl Into<String>) -> Error {
  Error::InvalidStaticData {
    field,
    reason: reason.into(),
  }
}
