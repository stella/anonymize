//! `signature_data`: ports `buildNativeSignatureData`
//! (`build-unified-search.ts`).
//!
//! Every field is `languageKeyedTerms(SIGNATURE_DETECTION.<field>, undefined)`,
//! so all languages are included and terms are deduped by exact string in
//! first-occurrence order. The field is emitted unconditionally.

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
  image_stub_prefixes: OrderedMap<Value>,
}

/// # Errors
///
/// Returns [`AssembleError`] when `signature-detection.json` fails to parse.
pub(super) fn build_signature_data()
-> Result<BindingSignatureData, AssembleError> {
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
    image_stub_prefixes: language_keyed_terms(&data.image_stub_prefixes, None),
  })
}
