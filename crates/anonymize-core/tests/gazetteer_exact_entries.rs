#![allow(clippy::expect_used, clippy::unwrap_used)]

//! An exact gazetteer entry standing as its own token is always redacted,
//! for every label, however common the word: the entry is the caller's
//! explicit instruction, so no prose heuristic may discard it.

use proptest::prelude::*;
use proptest::test_runner::RngSeed;
use stella_anonymize_adapter_contract::{
  assemble_static_search_config, prepared_search_config_from_binding,
};
use stella_anonymize_core::assemble::{GazetteerEntry, PipelineConfig};
use stella_anonymize_core::{OperatorConfig, PreparedEngine};

const LABELS: [&str; 4] =
  ["person", "organization", "location", "registration number"];

/// Common English and Czech words that are also names.
const COMMON_WORDS: [&str; 40] = [
  "Mark", "Will", "Grant", "Bill", "Rose", "Hope", "Rich", "Black", "White",
  "May", "June", "Art", "Pat", "Sue", "Nick", "Jack", "Frank", "Wood", "Hall",
  "Park", "Lane", "Young", "Long", "Little", "Král", "Malý", "Černý", "Novák",
  "Marek", "Dobrý", "Nový", "Velký", "Mír", "Zima", "Jaro", "Les", "Hora",
  "Most", "Doubek", "Liška",
];

/// The chat pipeline's detectors, gazetteer included, with one entry.
fn engine(word: &str, label: &str) -> PreparedEngine {
  let config: PipelineConfig = serde_json::from_value(serde_json::json!({
    "threshold": 0.4,
    "enableTriggerPhrases": true,
    "enableRegex": true,
    "enableNameCorpus": true,
    "enableDenyList": false,
    "enableGazetteer": true,
    "enableConfidenceBoost": false,
    "enableCoreference": true,
    "enableLegalForms": true,
    "labels": LABELS,
    "workspaceId": "exact-entries"
  }))
  .unwrap();
  let entry: GazetteerEntry = serde_json::from_value(serde_json::json!({
    "id": "entry",
    "canonical": word,
    "label": label,
    "variants": [],
    "workspaceId": "exact-entries",
    "createdAt": 0,
    "source": "manual"
  }))
  .unwrap();
  let binding = assemble_static_search_config(&config, None, &[entry]).unwrap();
  PreparedEngine::new(prepared_search_config_from_binding(binding).unwrap())
    .unwrap()
}

/// Whether the redaction covers `surface`, which occurs once in `text`.
fn redacted(engine: &PreparedEngine, text: &str, surface: &str) -> bool {
  let start = text.find(surface).unwrap();
  let end = start.saturating_add(surface.len());
  engine
    .redact_static_entities(text, &OperatorConfig::default())
    .unwrap()
    .resolved_entities
    .iter()
    .any(|entity| {
      usize::try_from(entity.start).unwrap() <= start
        && usize::try_from(entity.end).unwrap() >= end
    })
}

#[test]
fn common_word_person_entries_are_redacted() {
  for word in ["Mark", "Will", "Grant"] {
    let engine = engine(word, "person");
    for text in [
      format!("Hello {word} there."),
      format!("{word} signed the deal."),
      format!("Smlouvu podepsal {word} dnes."),
    ] {
      assert!(redacted(&engine, &text, word), "{text}");
    }
  }
}

proptest! {
  #![proptest_config(ProptestConfig {
    cases: 64,
    rng_seed: RngSeed::Fixed(0x6578_6163_7465_6e74),
    failure_persistence: None,
    ..ProptestConfig::default()
  })]

  #[test]
  fn exact_entries_standing_alone_are_always_redacted(
    word in prop_oneof![
      prop::sample::select(COMMON_WORDS.to_vec()).prop_map(str::to_owned),
      "[A-Z][a-z]{2,8}",
    ],
    label in prop::sample::select(LABELS.to_vec()),
    lowercase in any::<bool>(),
    context in prop::sample::select(vec![
      ("Hello ", " there."),
      ("", " signed the deal."),
      ("Smlouvu podepsal ", " dnes."),
      ("Ask ", ", please."),
      ("„", "“ souhlasí."),
    ]),
  ) {
    let surface = if lowercase { word.to_lowercase() } else { word.clone() };
    let text = format!("{}{surface}{}", context.0, context.1);
    let engine = engine(&word, label);
    prop_assert!(redacted(&engine, &text, &surface), "{label} {text:?}");
  }
}
