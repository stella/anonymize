//! Authenticated binary persistence for redaction-session state.
//!
//! Version 1 is `STLASESS` followed by a big-endian `u32` version, a one-byte
//! algorithm id, a 24-byte nonce, a big-endian `u32` ciphertext length, and the
//! ciphertext with its 16-byte tag. The entire fixed header is associated data.

use std::{fmt, str};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use zeroize::Zeroizing;

use crate::SessionTimestamp;
use crate::session::{MAX_SESSION_STATE_BYTES, RedactionSession};
use crate::types::{Error, Result};

/// Current binary format version for encrypted redaction-session archives.
pub const REDACTION_SESSION_ARCHIVE_VERSION: u32 = 1;
/// XChaCha20-Poly1305 algorithm identifier stored in version-1 archives.
pub const REDACTION_SESSION_ARCHIVE_ALGORITHM: u8 = 1;
/// Required caller-owned key length for encrypted session archives.
pub const REDACTION_SESSION_ARCHIVE_KEY_BYTES: usize = 32;

const ARCHIVE_MAGIC: &[u8; 8] = b"STLASESS";
const NONCE_BYTES: usize = 24;
const TAG_BYTES: usize = 16;
const MAGIC_END: usize = ARCHIVE_MAGIC.len();
const VERSION_END: usize = MAGIC_END + size_of::<u32>();
const ALGORITHM_OFFSET: usize = VERSION_END;
const NONCE_START: usize = ALGORITHM_OFFSET + size_of::<u8>();
const NONCE_END: usize = NONCE_START + NONCE_BYTES;
const CIPHERTEXT_LENGTH_END: usize = NONCE_END + size_of::<u32>();
const HEADER_BYTES: usize = CIPHERTEXT_LENGTH_END;
/// Maximum accepted or produced encrypted session archive length.
pub const REDACTION_SESSION_ARCHIVE_MAX_BYTES: usize =
  HEADER_BYTES + MAX_SESSION_STATE_BYTES + TAG_BYTES;

/// Caller-owned 256-bit key for encrypted redaction-session archives.
///
/// The key is cleared when this value is dropped. Applications remain
/// responsible for generating, storing, rotating, and authorizing access to
/// key material; the archive format does not derive keys from passwords.
pub struct SessionArchiveKey(
  Zeroizing<[u8; REDACTION_SESSION_ARCHIVE_KEY_BYTES]>,
);

impl SessionArchiveKey {
  #[must_use]
  pub fn from_bytes(bytes: [u8; REDACTION_SESSION_ARCHIVE_KEY_BYTES]) -> Self {
    Self(Zeroizing::new(bytes))
  }

  fn as_bytes(&self) -> &[u8] {
    self.0.as_ref()
  }
}

impl fmt::Debug for SessionArchiveKey {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str("SessionArchiveKey([REDACTED])")
  }
}

/// Inputs for restoring an encrypted redaction-session archive.
#[derive(Clone, Copy)]
pub struct OpenSessionArchiveOptions<'a> {
  pub archive: &'a [u8],
  pub key: &'a SessionArchiveKey,
  pub observed_at: Option<SessionTimestamp>,
}

impl RedactionSession {
  /// Encrypts this session into a bounded, authenticated binary archive.
  ///
  /// The archive contains personal data as ciphertext. Its fixed header is
  /// authenticated and contains only format metadata plus a random nonce.
  pub fn to_encrypted_archive(
    &self,
    key: &SessionArchiveKey,
  ) -> Result<Vec<u8>> {
    let plaintext = Zeroizing::new(self.to_plaintext_json()?);
    encrypt_plaintext(&plaintext, key)
  }

  /// Encrypts an active lifecycle session at a caller-supplied time.
  pub fn to_encrypted_archive_at(
    &self,
    key: &SessionArchiveKey,
    observed_at: SessionTimestamp,
  ) -> Result<Vec<u8>> {
    let plaintext = Zeroizing::new(self.to_plaintext_json_at(observed_at)?);
    encrypt_plaintext(&plaintext, key)
  }

  /// Authenticates, decrypts, validates, and restores a session archive.
  ///
  /// Lifecycle sessions require `observed_at`; archives that are not yet
  /// active or have expired fail before a usable session is returned.
  pub fn from_encrypted_archive(
    options: OpenSessionArchiveOptions<'_>,
  ) -> Result<Self> {
    let OpenSessionArchiveOptions {
      archive,
      key,
      observed_at,
    } = options;
    let parsed = ParsedSessionArchive::parse(archive)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_bytes())
      .map_err(|_| Error::SessionArchiveAuthenticationFailed)?;
    let nonce = XNonce::from(parsed.nonce);
    let plaintext = cipher
      .decrypt(
        &nonce,
        Payload {
          msg: parsed.ciphertext,
          aad: parsed.header,
        },
      )
      .map_err(|_| Error::SessionArchiveAuthenticationFailed)?;
    let plaintext = Zeroizing::new(plaintext);
    let plaintext = str::from_utf8(&plaintext).map_err(|_| {
      invalid_archive("decrypted session state is not valid UTF-8")
    })?;
    let session = Self::from_plaintext_json(plaintext)?;
    session.ensure_active(observed_at)?;
    Ok(session)
  }
}

fn encrypt_plaintext(
  plaintext: &str,
  key: &SessionArchiveKey,
) -> Result<Vec<u8>> {
  let mut nonce_bytes = [0_u8; NONCE_BYTES];
  getrandom::fill(&mut nonce_bytes)
    .map_err(|_| Error::SessionArchiveRandomnessUnavailable)?;
  encrypt_plaintext_with_nonce(plaintext, key, nonce_bytes)
}

fn encrypt_plaintext_with_nonce(
  plaintext: &str,
  key: &SessionArchiveKey,
  nonce_bytes: [u8; NONCE_BYTES],
) -> Result<Vec<u8>> {
  if plaintext.len() > MAX_SESSION_STATE_BYTES {
    return Err(invalid_archive(
      "session state exceeds the maximum archive payload length",
    ));
  }
  let ciphertext_len = plaintext
    .len()
    .checked_add(TAG_BYTES)
    .ok_or_else(|| invalid_archive("archive length overflow"))?;
  let ciphertext_len_u32 = u32::try_from(ciphertext_len).map_err(|_| {
    invalid_archive("archive payload length is not addressable")
  })?;
  let header = archive_header(&nonce_bytes, ciphertext_len_u32);
  let cipher = XChaCha20Poly1305::new_from_slice(key.as_bytes())
    .map_err(|_| Error::SessionArchiveEncryptionFailed)?;
  let nonce = XNonce::from(nonce_bytes);
  let ciphertext = cipher
    .encrypt(
      &nonce,
      Payload {
        msg: plaintext.as_bytes(),
        aad: &header,
      },
    )
    .map_err(|_| Error::SessionArchiveEncryptionFailed)?;
  if ciphertext.len() != ciphertext_len {
    return Err(Error::SessionArchiveEncryptionFailed);
  }

  let archive_len = HEADER_BYTES
    .checked_add(ciphertext.len())
    .ok_or_else(|| invalid_archive("archive length overflow"))?;
  let mut archive = Vec::with_capacity(archive_len);
  archive.extend_from_slice(&header);
  archive.extend_from_slice(&ciphertext);
  Ok(archive)
}

fn archive_header(nonce: &[u8; NONCE_BYTES], ciphertext_len: u32) -> Vec<u8> {
  let mut header = Vec::with_capacity(HEADER_BYTES);
  header.extend_from_slice(ARCHIVE_MAGIC);
  header.extend_from_slice(&REDACTION_SESSION_ARCHIVE_VERSION.to_be_bytes());
  header.push(REDACTION_SESSION_ARCHIVE_ALGORITHM);
  header.extend_from_slice(nonce);
  header.extend_from_slice(&ciphertext_len.to_be_bytes());
  header
}

struct ParsedSessionArchive<'a> {
  header: &'a [u8],
  nonce: [u8; NONCE_BYTES],
  ciphertext: &'a [u8],
}

impl<'a> ParsedSessionArchive<'a> {
  fn parse(archive: &'a [u8]) -> Result<Self> {
    if archive.len() > REDACTION_SESSION_ARCHIVE_MAX_BYTES {
      return Err(invalid_archive("archive exceeds the maximum byte length"));
    }
    let header = archive
      .get(..HEADER_BYTES)
      .ok_or_else(|| invalid_archive("archive header is truncated"))?;
    let magic = header
      .get(..MAGIC_END)
      .ok_or_else(|| invalid_archive("archive magic is truncated"))?;
    if magic != ARCHIVE_MAGIC {
      return Err(invalid_archive("archive magic does not match"));
    }

    let version_bytes = header
      .get(MAGIC_END..VERSION_END)
      .ok_or_else(|| invalid_archive("archive version is truncated"))?;
    let version = u32::from_be_bytes(
      version_bytes
        .try_into()
        .map_err(|_| invalid_archive("archive version is malformed"))?,
    );
    if version != REDACTION_SESSION_ARCHIVE_VERSION {
      return Err(Error::UnsupportedSessionArchiveVersion { version });
    }

    let algorithm = header
      .get(ALGORITHM_OFFSET)
      .copied()
      .ok_or_else(|| invalid_archive("archive algorithm is truncated"))?;
    if algorithm != REDACTION_SESSION_ARCHIVE_ALGORITHM {
      return Err(Error::UnsupportedSessionArchiveAlgorithm { algorithm });
    }

    let nonce = header
      .get(NONCE_START..NONCE_END)
      .ok_or_else(|| invalid_archive("archive nonce is truncated"))?
      .try_into()
      .map_err(|_| invalid_archive("archive nonce is malformed"))?;
    let ciphertext_len_bytes = header
      .get(NONCE_END..CIPHERTEXT_LENGTH_END)
      .ok_or_else(|| invalid_archive("archive payload length is truncated"))?;
    let ciphertext_len = u32::from_be_bytes(
      ciphertext_len_bytes
        .try_into()
        .map_err(|_| invalid_archive("archive payload length is malformed"))?,
    );
    let ciphertext_len = usize::try_from(ciphertext_len).map_err(|_| {
      invalid_archive("archive payload length is not addressable")
    })?;
    if ciphertext_len < TAG_BYTES {
      return Err(invalid_archive("archive payload is shorter than its tag"));
    }
    let expected_archive_len = HEADER_BYTES
      .checked_add(ciphertext_len)
      .ok_or_else(|| invalid_archive("archive length overflow"))?;
    if archive.len() != expected_archive_len {
      return Err(invalid_archive(
        "archive payload length does not match its header",
      ));
    }
    let ciphertext = archive
      .get(HEADER_BYTES..)
      .ok_or_else(|| invalid_archive("archive payload is truncated"))?;
    Ok(Self {
      header,
      nonce,
      ciphertext,
    })
  }
}

fn invalid_archive(reason: impl Into<String>) -> Error {
  Error::InvalidSessionArchive {
    reason: reason.into(),
  }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
  use sha2::{Digest, Sha256};

  use super::*;
  use crate::SessionId;

  #[test]
  fn version_one_archive_bytes_have_a_stable_digest() {
    let session = RedactionSession::new(
      SessionId::new("format_1").expect("session id should be valid"),
    );
    let plaintext = session
      .to_plaintext_json()
      .expect("session should serialize");
    let key = SessionArchiveKey::from_bytes(
      [0x42; REDACTION_SESSION_ARCHIVE_KEY_BYTES],
    );
    let archive =
      encrypt_plaintext_with_nonce(&plaintext, &key, [0x24; NONCE_BYTES])
        .expect("fixed archive should encrypt");
    let digest: [u8; 32] = Sha256::digest(&archive).into();

    assert_eq!(
      digest,
      [
        192, 195, 58, 255, 52, 135, 100, 205, 18, 127, 91, 65, 150, 218, 163,
        156, 200, 88, 218, 199, 69, 111, 22, 109, 57, 32, 111, 172, 27, 32, 33,
        132,
      ],
    );
  }
}
