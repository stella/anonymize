//! Separately supplied dictionaries must be honored by the assembler
//! (JSON callers pass large bundles out of band instead of inlining them
//! into the pipeline config).

use stella_anonymize_adapter_contract::assemble_static_search_config;
use stella_anonymize_core::assemble::{Dictionaries, PipelineConfig};

fn base_config_json(with_dictionaries: Option<&str>) -> String {
  let dictionaries = with_dictionaries
    .map(|json| format!(r#","dictionaries":{json}"#))
    .unwrap_or_default();
  format!(
    r#"{{
      "threshold": 0.5,
      "enableTriggerPhrases": false,
      "enableRegex": false,
      "enableLegalForms": false,
      "enableNameCorpus": true,
      "enableDenyList": false,
      "enableGazetteer": false,
      "enableCountries": false,
      "enableNer": false,
      "enableConfidenceBoost": false,
      "enableCoreference": false,
      "enableZoneClassification": false,
      "labels": ["person"],
      "workspaceId": "test"{dictionaries}
    }}"#
  )
}

const DICTIONARIES_JSON: &str =
  r#"{"firstNames":{"en":["Zorblaxian"]},"surnames":{"en":["Vantablack"]}}"#;

#[test]
fn separately_supplied_dictionaries_match_inline_config_dictionaries()
-> Result<(), Box<dyn std::error::Error>> {
  let inline_config: PipelineConfig =
    serde_json::from_str(&base_config_json(Some(DICTIONARIES_JSON)))?;
  let bare_config: PipelineConfig =
    serde_json::from_str(&base_config_json(None))?;
  let dictionaries: Dictionaries = serde_json::from_str(DICTIONARIES_JSON)?;

  let inline = assemble_static_search_config(&inline_config, None, &[])?;
  let separate =
    assemble_static_search_config(&bare_config, Some(&dictionaries), &[])?;

  assert_eq!(
    inline, separate,
    "separately supplied dictionaries must assemble identically to inline ones"
  );
  let corpus = separate
    .name_corpus_data
    .as_ref()
    .ok_or("expected name corpus data when dictionaries are supplied")?;
  assert!(
    corpus
      .first_names
      .iter()
      .any(|name| name == "zorblaxian" || name == "Zorblaxian"),
    "injected first name must reach the assembled corpus"
  );
  Ok(())
}

const ORDERED_DENY_JSON: &str = r#"{
  "denyList": {"zeta-banks": ["Zeta Trust"], "alpha-courts": ["Alpha Court"]},
  "denyListMeta": {
    "zeta-banks": {"label": "organization", "category": "Financial", "country": null},
    "alpha-courts": {"label": "organization", "category": "Courts", "country": null}
  }
}"#;

#[test]
fn deny_list_dictionary_insertion_order_is_preserved()
-> Result<(), Box<dyn std::error::Error>> {
  let mut config: PipelineConfig =
    serde_json::from_str(&base_config_json(None))?;
  config.enable_deny_list = true;
  config.labels = vec!["organization".to_string()];
  let dictionaries: Dictionaries = serde_json::from_str(ORDERED_DENY_JSON)?;

  let assembled =
    assemble_static_search_config(&config, Some(&dictionaries), &[])?;
  let deny = assembled
    .deny_list_data
    .as_ref()
    .ok_or("expected deny list data")?;

  let zeta = deny
    .originals
    .iter()
    .position(|term| term == "Zeta Trust")
    .ok_or("Zeta Trust missing from originals")?;
  let alpha = deny
    .originals
    .iter()
    .position(|term| term == "Alpha Court")
    .ok_or("Alpha Court missing from originals")?;
  assert!(
    zeta < alpha,
    "deny-list dictionaries must be applied in JSON insertion order \
     (zeta-banks before alpha-courts), not lexicographic order"
  );
  Ok(())
}
