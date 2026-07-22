//! `signature_data`: ports `buildNativeSignatureData`
//! (`build-unified-search.ts`).
//!
//! Existing detection fields include all languages for captured parity. The
//! Generic form labels are scoped to configured content languages so an
//! unrelated language's label cannot truncate a surname. PDF signing software
//! stamps are language-neutral because tools commonly emit English text inside
//! otherwise non-English documents.

use serde::Deserialize;
use serde_json::Value;
use stella_anonymize_core::assemble::{AssembleError, OrderedMap};

use super::language::language_keyed_terms;
use crate::BindingSignatureData;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignatureDetection {
  #[serde(default)]
  labels: OrderedMap<Value>,
  #[serde(default)]
  witness_phrases: OrderedMap<Value>,
  #[serde(default)]
  name_particles: OrderedMap<Value>,
  #[serde(default)]
  post_nominal_suffixes: OrderedMap<Value>,
  #[serde(default)]
  organization_suffixes: OrderedMap<Value>,
  #[serde(default)]
  form_field_labels: OrderedMap<Value>,
  #[serde(default)]
  signature_stamp_phrases: OrderedMap<Value>,
  #[serde(default)]
  image_stub_prefixes: OrderedMap<Value>,
}

pub(super) fn form_field_labels(
  selected: Option<&[String]>,
) -> Result<Vec<String>, AssembleError> {
  let data: SignatureDetection =
    stella_anonymize_core::assemble::parse_data_file(
      "signature-detection.json",
    )?;
  Ok(language_keyed_terms(&data.form_field_labels, selected))
}

/// # Errors
///
/// Returns [`AssembleError`] when `signature-detection.json` fails to parse.
pub(super) fn build_signature_data(
  selected: Option<&[String]>,
) -> Result<BindingSignatureData, AssembleError> {
  let data: SignatureDetection =
    stella_anonymize_core::assemble::parse_data_file(
      "signature-detection.json",
    )?;
  Ok(BindingSignatureData {
    labels: language_keyed_terms(&data.labels, None),
    witness_phrases: language_keyed_terms(&data.witness_phrases, None),
    name_particles: language_keyed_terms(&data.name_particles, None),
    post_nominal_suffixes: language_keyed_terms(
      &data.post_nominal_suffixes,
      None,
    ),
    organization_suffixes: language_keyed_terms(
      &data.organization_suffixes,
      None,
    ),
    form_field_labels: language_keyed_terms(&data.form_field_labels, selected),
    signature_stamp_phrases: language_keyed_terms(
      &data.signature_stamp_phrases,
      None,
    ),
    image_stub_prefixes: language_keyed_terms(&data.image_stub_prefixes, None),
  })
}

#[cfg(test)]
mod tests {
  #![allow(clippy::unwrap_used)]

  use super::{build_signature_data, form_field_labels};

  #[test]
  fn scoped_packages_keep_cross_locale_signing_software_stamps() {
    let data = build_signature_data(Some(&[String::from("cs")])).unwrap();

    assert!(
      data
        .signature_stamp_phrases
        .iter()
        .any(|phrase| phrase == "digitally signed by")
    );
    assert!(data.form_field_labels.iter().any(|label| label == "jméno"));
    assert!(!data.form_field_labels.iter().any(|label| label == "name"));
  }

  #[test]
  fn german_registry_labels_share_the_scoped_field_source() {
    let german = form_field_labels(Some(&[String::from("de")])).unwrap();
    let english = form_field_labels(Some(&[String::from("en")])).unwrap();

    assert!(german.iter().any(|label| label == "hrb"));
    assert!(german.iter().any(|label| label == "ust-idnr."));
    assert!(!english.iter().any(|label| label == "hrb"));
    assert!(english.iter().any(|label| label == "vat"));
  }
}
