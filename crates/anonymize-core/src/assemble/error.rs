//! Typed errors for stage-1 native-config assembly.

use std::fmt;

/// Errors produced while assembling a prepared static-search config from a
/// pipeline config, dictionaries, and gazetteer entries.
///
/// Hand-rolled (rather than `thiserror`) so the core crate gains no new
/// third-party dependency for the assembly seam.
#[derive(Debug)]
#[non_exhaustive]
pub enum AssembleError {
  /// An embedded data file could not be found by name.
  MissingDataFile {
    /// The requested data file name (for example `countries.json`).
    name: String,
  },
  /// An embedded data file failed to parse as the requested type.
  DataParse {
    /// The data file name that failed to parse.
    name: String,
    /// The underlying serde error message.
    message: String,
  },
  /// A regex meta entry references a validator the native config cannot
  /// support. Mirrors the `toNativeRegexMeta` throw in the TypeScript source.
  UnsupportedRegexValidator {
    /// The unsupported validator id (or `"unknown"` when absent).
    validator: String,
  },
}

impl fmt::Display for AssembleError {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::MissingDataFile { name } => {
        write!(formatter, "missing embedded data file: {name}")
      }
      Self::DataParse { name, message } => {
        write!(formatter, "failed to parse data file {name}: {message}")
      }
      Self::UnsupportedRegexValidator { validator } => {
        write!(
          formatter,
          "native static config does not support regex validator {validator}"
        )
      }
    }
  }
}

impl std::error::Error for AssembleError {}
