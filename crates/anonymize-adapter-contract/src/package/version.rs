//! Package header layout: magic headers, format version constants, and
//! header read/write helpers. Bump a version constant whenever the
//! payload codec or header layout changes; decoders reject other
//! versions with a typed error.

use crate::error::Result;
use crate::error::invalid_prepared_search_package;

use super::PackageCompression;

// Versions below 16 (binding) / 23 (core) carried bincode payloads. Postcard
// began at those versions; current versions also reject postcard payloads
// whose positional struct schema predates the current DTOs. Version numbers
// are unique per header magic, across compression variants.
pub(crate) const PREPARED_SEARCH_PACKAGE_HEADER: [u8; 8] = *b"ANONPKG1";
pub(crate) const PREPARED_SEARCH_PACKAGE_VERSION: u32 = 17;
pub(crate) const PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER: [u8; 8] =
  *b"ANONPKZ1";
pub(crate) const PREPARED_SEARCH_COMPRESSED_PACKAGE_VERSION: u32 = 19;
pub(crate) const PREPARED_SEARCH_COMPRESSED_PACKAGE_ZSTD_VERSION: u32 = 17;
pub(crate) const PREPARED_SEARCH_COMPRESSED_PACKAGE_PAYLOAD_DIGEST_VERSION:
  u32 = 18;
pub(crate) const PREPARED_SEARCH_CORE_PACKAGE_HEADER: [u8; 8] = *b"ANONCPK1";
pub(crate) const PREPARED_SEARCH_CORE_PACKAGE_VERSION: u32 = 24;
pub(crate) const PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER: [u8; 8] =
  *b"ANONCPZ1";
pub(crate) const PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_VERSION: u32 = 26;
pub(crate) const PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_ZSTD_VERSION: u32 = 24;
pub(crate) const PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_PAYLOAD_DIGEST_VERSION: u32 = 25;
pub(crate) const PREPARED_SEARCH_PACKAGE_DIGEST_BYTES: usize = 32;
#[cfg(test)]
pub(crate) const PREPARED_SEARCH_PACKAGE_ZSTD_LEVEL: i32 = 1;
pub(crate) const MAX_PREPARED_SEARCH_PACKAGE_PAYLOAD_BYTES: usize =
  256 * 1024 * 1024;
pub(crate) const fn raw_package_header_len(payload: &[u8]) -> usize {
  PREPARED_SEARCH_PACKAGE_HEADER
    .len()
    .saturating_add(std::mem::size_of::<u32>())
    .saturating_add(PREPARED_SEARCH_PACKAGE_DIGEST_BYTES)
    .saturating_add(payload.len())
}

pub(crate) fn write_package_header(
  bytes: &mut Vec<u8>,
  header: [u8; 8],
  version: u32,
  digest: &[u8; PREPARED_SEARCH_PACKAGE_DIGEST_BYTES],
) {
  bytes.extend_from_slice(&header);
  bytes.extend_from_slice(&version.to_le_bytes());
  bytes.extend_from_slice(digest);
}
#[derive(Clone, Copy)]
pub(crate) struct RawPackageHeader<'a> {
  pub(crate) version: u32,
  pub(crate) digest: [u8; 32],
  pub(crate) payload: &'a [u8],
}
pub(crate) fn compressed_package_header(
  bytes: &[u8],
  lz4_compressed_digest_version: u32,
  zstd_compressed_digest_version: u32,
  payload_digest_version: u32,
  header_len: usize,
) -> Result<(RawPackageHeader<'_>, PackageCompression)> {
  let raw = raw_package_header_any_version(bytes, header_len)?;
  let compression = if raw.version == lz4_compressed_digest_version {
    PackageCompression::Lz4
  } else if raw.version == zstd_compressed_digest_version {
    PackageCompression::ZstdCompressed
  } else if raw.version == payload_digest_version {
    PackageCompression::ZstdPayload
  } else {
    return Err(invalid_prepared_search_package("unsupported version"));
  };
  Ok((raw, compression))
}

pub(crate) fn raw_package_header(
  bytes: &[u8],
  expected_version: u32,
  header_len: usize,
) -> Result<RawPackageHeader<'_>> {
  let raw = raw_package_header_any_version(bytes, header_len)?;
  if raw.version != expected_version {
    return Err(invalid_prepared_search_package("unsupported version"));
  }
  Ok(raw)
}

pub(crate) fn raw_package_header_any_version(
  bytes: &[u8],
  header_len: usize,
) -> Result<RawPackageHeader<'_>> {
  let version_start = header_len;
  let version_end = version_start.saturating_add(std::mem::size_of::<u32>());
  let version_bytes = bytes
    .get(version_start..version_end)
    .ok_or_else(|| invalid_prepared_search_package("truncated version"))?;
  let version_array = <[u8; 4]>::try_from(version_bytes)
    .map_err(|_| invalid_prepared_search_package("malformed version"))?;
  let version = u32::from_le_bytes(version_array);
  let digest_end =
    version_end.saturating_add(PREPARED_SEARCH_PACKAGE_DIGEST_BYTES);
  let digest_bytes = bytes
    .get(version_end..digest_end)
    .ok_or_else(|| invalid_prepared_search_package("truncated digest"))?;
  let digest =
    <[u8; PREPARED_SEARCH_PACKAGE_DIGEST_BYTES]>::try_from(digest_bytes)
      .map_err(|_| invalid_prepared_search_package("malformed digest"))?;
  let payload = bytes
    .get(digest_end..)
    .ok_or_else(|| invalid_prepared_search_package("missing payload"))?;
  Ok(RawPackageHeader {
    version,
    digest,
    payload,
  })
}
