//! Typed error surface shared by every adapter-contract module.

pub type Result<T> = std::result::Result<T, ContractError>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContractError {
  InvalidCallerDetection { index: usize, reason: String },
  InvalidExternalDetectionBatch { reason: String },
  CompactStringIndexOutOfRange { field: &'static str, index: u32 },
  FuzzyDistanceOutOfRange { distance: u32 },
  InvalidCompactStringGroups { field: &'static str, reason: String },
  InvalidBindingOffset { offset: u32 },
  InvalidPreparedSearchPackage { reason: String },
  MissingDenyListDataForLiteralPatterns,
  UnsupportedOperator { value: String },
  InvalidOperatorConfig { label: String, reason: String },
  UnsupportedSearchPatternKind { kind: String },
  UnsupportedSourceDetail { value: String },
  UnsupportedCallerDetectionContractVersion { version: u32 },
}

impl std::fmt::Display for ContractError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::InvalidCallerDetection { index, reason } => {
        write!(formatter, "Caller detection {index} is invalid: {reason}")
      }
      Self::InvalidExternalDetectionBatch { reason } => {
        write!(formatter, "External detection batch is invalid: {reason}")
      }
      Self::CompactStringIndexOutOfRange { field, index } => {
        write!(
          formatter,
          "Compact string index out of range in {field}: {index}"
        )
      }
      Self::FuzzyDistanceOutOfRange { distance } => {
        write!(formatter, "Fuzzy distance exceeds u8 range: {distance}")
      }
      Self::InvalidCompactStringGroups { field, reason } => {
        write!(
          formatter,
          "Compact string groups are invalid in {field}: {reason}"
        )
      }
      Self::InvalidBindingOffset { offset } => {
        write!(
          formatter,
          "Binding offset is not on a character boundary: {offset}"
        )
      }
      Self::InvalidPreparedSearchPackage { reason } => {
        write!(formatter, "Prepared search package is invalid: {reason}")
      }
      Self::MissingDenyListDataForLiteralPatterns => formatter.write_str(
        "Deny-list data is required when literal patterns are derived from it",
      ),
      Self::UnsupportedOperator { value } => {
        write!(formatter, "Unsupported anonymization operator: {value}")
      }
      Self::InvalidOperatorConfig { label, reason } => {
        write!(formatter, "Invalid operator config for '{label}': {reason}")
      }
      Self::UnsupportedSearchPatternKind { kind } => {
        write!(formatter, "Unsupported search pattern kind: {kind}")
      }
      Self::UnsupportedSourceDetail { value } => {
        write!(formatter, "Unsupported source detail: {value}")
      }
      Self::UnsupportedCallerDetectionContractVersion { version } => {
        write!(
          formatter,
          "Unsupported caller detection contract version: {version}"
        )
      }
    }
  }
}
impl std::error::Error for ContractError {}
pub(crate) fn invalid_prepared_search_package(
  reason: impl Into<String>,
) -> ContractError {
  ContractError::InvalidPreparedSearchPackage {
    reason: reason.into(),
  }
}
