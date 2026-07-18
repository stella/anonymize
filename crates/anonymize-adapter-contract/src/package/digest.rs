//! Payload digest verification (BLAKE3, 32 bytes).

use crate::error::Result;
use crate::error::invalid_prepared_search_package;

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
