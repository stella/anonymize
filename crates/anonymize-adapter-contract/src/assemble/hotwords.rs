//! `hotword_data`: ports `loadHotwordRuleSet` + `toNativeHotwordRule`, plus the
//! `expandLabelsForHotwordRuleSet` label expansion used to gate every
//! label-scoped field when `enableHotwordRules` is on.
//!
//! `hotword_data` is emitted when the rule set is non-empty (i.e. only when
//! `enableHotwordRules === true`). `pattern_rule_indices` is always empty in the
//! assembler, matching the TypeScript source.

use std::collections::HashSet;

use serde::Deserialize;
use stella_anonymize_core::assemble::{AssembleError, parse_data_file};

use crate::{BindingHotwordRule, BindingHotwordRuleData};

/// Raw `hotword-rules.json` rule, in the SDK's camelCase shape.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HotwordRule {
  #[serde(default)]
  hotwords: Vec<String>,
  #[serde(default)]
  target_labels: Vec<String>,
  score_adjustment: f64,
  #[serde(default)]
  reclassify_to: Option<String>,
  proximity_before: u32,
  proximity_after: u32,
}

#[derive(Deserialize)]
struct HotwordRulesConfig {
  #[serde(default)]
  rules: Vec<HotwordRule>,
}

/// Mirrors `loadHotwordRuleSet`: the `rules` array of `hotword-rules.json`.
///
/// # Errors
///
/// Returns [`AssembleError`] when `hotword-rules.json` fails to parse.
pub(super) fn load_hotword_rules() -> Result<Vec<HotwordRule>, AssembleError> {
  let config: HotwordRulesConfig = parse_data_file("hotword-rules.json")?;
  Ok(config.rules)
}

/// Mirrors `expandLabelsForHotwordRuleSet`: add every target label of a rule
/// whose `reclassifyTo` is among the requested labels. An empty request is
/// returned unchanged.
pub(super) fn expand_labels_for_hotword_rule_set(
  requested: &[String],
  rule_set: &[HotwordRule],
) -> Vec<String> {
  if requested.is_empty() {
    return requested.to_vec();
  }
  let requested_set: HashSet<&str> =
    requested.iter().map(String::as_str).collect();
  let mut expanded = requested.to_vec();
  let mut seen: HashSet<String> = requested.iter().cloned().collect();
  for rule in rule_set {
    let Some(reclassify) = rule.reclassify_to.as_ref() else {
      continue;
    };
    if !requested_set.contains(reclassify.as_str()) {
      continue;
    }
    for label in &rule.target_labels {
      if seen.insert(label.clone()) {
        expanded.push(label.clone());
      }
    }
  }
  expanded
}

/// Mirrors the `hotword_data` assembly: present only when the rule set is
/// non-empty, with `pattern_rule_indices` left empty.
pub(super) fn build_hotword_data(
  rules: &[HotwordRule],
) -> Option<BindingHotwordRuleData> {
  if rules.is_empty() {
    return None;
  }
  Some(BindingHotwordRuleData {
    rules: rules.iter().map(to_native_hotword_rule).collect(),
    pattern_rule_indices: Vec::new(),
  })
}

/// Mirrors `toNativeHotwordRule`.
fn to_native_hotword_rule(rule: &HotwordRule) -> BindingHotwordRule {
  BindingHotwordRule {
    hotwords: rule.hotwords.clone(),
    target_labels: rule.target_labels.clone(),
    score_adjustment: rule.score_adjustment,
    reclassify_to: rule.reclassify_to.clone(),
    proximity_before: rule.proximity_before,
    proximity_after: rule.proximity_after,
  }
}
