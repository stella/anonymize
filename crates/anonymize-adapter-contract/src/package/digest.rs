//! Payload digest verification (BLAKE3, 32 bytes).

use crate::error::Result;
use crate::error::invalid_prepared_search_package;

use super::PackageCompression;

pub(crate) fn prepared_search_compressed_package_digest(
  compression: PackageCompression,
  payload: &[u8],
) -> blake3::Hash {
  let mut hasher = blake3::Hasher::new();
  hasher.update(&[compression.wire_tag()]);
  hasher.update(payload);
  hasher.finalize()
}

pub(crate) fn verify_prepared_search_package_digest(
  expected: [u8; 32],
  payload: &[u8],
) -> Result<()> {
  let actual = blake3::hash(payload);
  if actual.as_bytes() != &expected {
    return Err(invalid_prepared_search_package("digest mismatch"));
  }
  Ok(())
}

pub(crate) fn verify_prepared_search_compressed_package_digest(
  expected: [u8; 32],
  compression: PackageCompression,
  payload: &[u8],
) -> Result<()> {
  let actual = prepared_search_compressed_package_digest(compression, payload);
  if actual.as_bytes() != &expected {
    return Err(invalid_prepared_search_package("digest mismatch"));
  }
  Ok(())
}
