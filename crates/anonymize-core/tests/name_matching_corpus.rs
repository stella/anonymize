//! Deterministic, synthetic gazetteer corpus gate. Run with --nocapture for
//! aggregate metrics. Scores resolved byte spans, including forced identifiers.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::io::{self, Write};
use std::ops::Range;

use serde::Deserialize;
use stella_anonymize_adapter_contract::{
  assemble_static_search_config, prepared_search_config_from_binding,
};
use stella_anonymize_core::assemble::{
  GazetteerEntry, GazetteerSource, PipelineConfig,
};
use stella_anonymize_core::{
  DetectionSource, OperatorConfig, PipelineEntity, PreparedEngine,
};
use unicode_segmentation::UnicodeSegmentation;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Corpus {
  entries: Vec<GazetteerEntry>,
  cases: Vec<Case>,
  forced_values: Vec<String>,
  forced_cases: Vec<Case>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Expectation {
  Redact,
  Keep,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
  expectation: Expectation,
  kind: String,
  text: String,
  surface: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "metric", rename_all = "kebab-case", deny_unknown_fields)]
enum Threshold {
  Recall {
    total: u32,
    minimum_exact_hits: u32,
  },
  FalsePositives {
    total: u32,
    maximum_false_positives: u32,
  },
}

struct Tally {
  expectation: Expectation,
  passed: u32,
  total: u32,
}

type Report = BTreeMap<String, Tally>;

fn engine(
  entries: &[GazetteerEntry],
) -> Result<PreparedEngine, Box<dyn Error>> {
  // This profile isolates caller-owned names from unrelated dictionary,
  // regex and contextual detectors while using production assembly/resolution.
  let config: PipelineConfig = serde_json::from_value(serde_json::json!({
    "threshold": 0.3, "enableTriggerPhrases": false, "enableRegex": false,
    "languages": ["cs", "sk", "en"], "enableLegalForms": false,
    "enableNameCorpus": false, "enableDenyList": false,
    "enableGazetteer": true, "enableCountries": false,
    "enableConfidenceBoost": false, "enableCoreference": false,
    "enableZoneClassification": false, "enableHotwordRules": false,
    "labels": [], "workspaceId": "synthetic-corpus"
  }))?;
  let binding = assemble_static_search_config(&config, None, entries)?;
  Ok(PreparedEngine::new(prepared_search_config_from_binding(
    binding,
  )?)?)
}

fn surface_range(case: &Case) -> Result<Range<u32>, Box<dyn Error>> {
  if case.surface.is_empty() || case.text.matches(&case.surface).count() != 1 {
    return Err(
      format!("{}: surface must occur exactly once", case.kind).into(),
    );
  }
  let start = case.text.find(&case.surface).ok_or("missing surface")?;
  Ok(
    u32::try_from(start)?
      ..u32::try_from(
        start
          .checked_add(case.surface.len())
          .ok_or("offset overflow")?,
      )?,
  )
}

const fn overlaps(entity: &PipelineEntity, range: &Range<u32>) -> bool {
  entity.start < range.end && range.start < entity.end
}

fn exact_hit(entities: &[PipelineEntity], range: &Range<u32>) -> bool {
  entities
    .iter()
    .any(|entity| entity.start == range.start && entity.end == range.end)
    && !overreaches(entities, range)
}

fn overreaches(entities: &[PipelineEntity], range: &Range<u32>) -> bool {
  entities.iter().any(|entity| {
    overlaps(entity, range)
      && (entity.start < range.start || entity.end > range.end)
  })
}

fn swallows_word(
  entities: &[PipelineEntity],
  range: &Range<u32>,
  text: &str,
) -> Result<bool, Box<dyn Error>> {
  let surface_start = usize::try_from(range.start)?;
  let surface_end = usize::try_from(range.end)?;
  for entity in entities.iter().filter(|entity| overlaps(entity, range)) {
    if entity.start < range.start {
      let prefix = text
        .get(usize::try_from(entity.start)?..surface_start)
        .ok_or("invalid prefix span")?;
      if prefix.unicode_words().next().is_some() {
        return Ok(true);
      }
    }
    if entity.end > range.end {
      let suffix = text
        .get(surface_end..usize::try_from(entity.end)?)
        .ok_or("invalid suffix span")?;
      if suffix.unicode_words().next().is_some() {
        return Ok(true);
      }
    }
  }
  Ok(false)
}

fn record(
  report: &mut Report,
  key: String,
  expectation: Expectation,
  passed: bool,
) -> Result<(), Box<dyn Error>> {
  let tally = report.entry(key).or_insert(Tally {
    expectation,
    passed: 0,
    total: 0,
  });
  if tally.expectation != expectation {
    return Err("class has conflicting expectations".into());
  }
  tally.total = tally.total.checked_add(1).ok_or("case count overflow")?;
  tally.passed = tally
    .passed
    .checked_add(u32::from(passed))
    .ok_or("case count overflow")?;
  Ok(())
}

fn measure(
  engine: &PreparedEngine,
  cases: &[&Case],
  mode: &str,
  report: &mut Report,
) -> Result<(), Box<dyn Error>> {
  let operators = OperatorConfig::default();
  for case in cases {
    let range = surface_range(case)?;
    let result = engine.redact_static_entities(&case.text, &operators)?;
    let entities = &result.resolved_entities;
    for entity in entities {
      let start = usize::try_from(entity.start)?;
      let end = usize::try_from(entity.end)?;
      if start >= end
        || end > case.text.len()
        || !case.text.is_char_boundary(start)
        || !case.text.is_char_boundary(end)
      {
        return Err(
          format!("{mode}/{}: invalid resolved span", case.kind).into(),
        );
      }
    }
    let passed = match case.expectation {
      Expectation::Redact => exact_hit(entities, &range),
      Expectation::Keep => {
        !entities.iter().any(|entity| overlaps(entity, &range))
      }
    };
    record(
      report,
      format!("{mode}/{}", case.kind),
      case.expectation,
      passed,
    )?;
    if case.expectation == Expectation::Redact {
      // Overreach is a false positive even when the identifying text vanished.
      record(
        report,
        format!("{mode}/adjacent-word"),
        Expectation::Keep,
        !swallows_word(entities, &range, &case.text)?,
      )?;
      record(
        report,
        format!("{mode}/span-extent"),
        Expectation::Keep,
        !overreaches(entities, &range),
      )?;
    }
  }
  Ok(())
}

#[test]
fn labeled_name_matching_corpus_gate() -> Result<(), Box<dyn Error>> {
  let corpus: Corpus =
    serde_json::from_str(include_str!("fixtures/name_matching/corpus.json"))?;
  let thresholds: BTreeMap<String, Threshold> = serde_json::from_str(
    include_str!("fixtures/name_matching/thresholds.json"),
  )?;
  let forced_entries = corpus
    .forced_values
    .iter()
    .enumerate()
    .map(|(index, value)| GazetteerEntry {
      id: format!("forced-{index}"),
      canonical: value.clone(),
      label: String::from("registration number"),
      variants: vec![],
      workspace_id: String::from("synthetic-corpus"),
      created_at: 0,
      source: GazetteerSource::Manual,
    })
    .collect::<Vec<_>>();
  let mut report = Report::new();
  measure(
    &engine(&corpus.entries)?,
    &corpus.cases.iter().collect::<Vec<_>>(),
    "deny-list",
    &mut report,
  )?;
  let forced_cases = corpus
    .forced_cases
    .iter()
    .chain(
      corpus
        .cases
        .iter()
        .filter(|case| case.expectation == Expectation::Keep),
    )
    .collect::<Vec<_>>();
  measure(
    &engine(&forced_entries)?,
    &forced_cases,
    "forced",
    &mut report,
  )?;
  check_thresholds(&report, &thresholds)
}

fn check_thresholds(
  report: &Report,
  thresholds: &BTreeMap<String, Threshold>,
) -> Result<(), Box<dyn Error>> {
  assert_eq!(
    report.keys().collect::<BTreeSet<_>>(),
    thresholds.keys().collect::<BTreeSet<_>>(),
    "threshold classes must exactly match measured classes"
  );
  let mut failures = Vec::new();
  let mut table = io::stdout().lock();
  writeln!(table, "class | metric | count/total | bound")?;
  for (key, tally) in report {
    let threshold = thresholds.get(key).ok_or("missing threshold")?;
    let (total, count, bound, holds, metric) = match threshold {
      Threshold::Recall {
        total,
        minimum_exact_hits,
      } => {
        assert_eq!(
          tally.expectation,
          Expectation::Redact,
          "recall requires redact cases"
        );
        assert!(*minimum_exact_hits <= *total, "invalid recall floor");
        (
          *total,
          tally.passed,
          *minimum_exact_hits,
          tally.passed >= *minimum_exact_hits,
          "recall",
        )
      }
      Threshold::FalsePositives {
        total,
        maximum_false_positives,
      } => {
        assert_eq!(
          tally.expectation,
          Expectation::Keep,
          "false positives require keep cases"
        );
        assert!(*maximum_false_positives <= *total, "invalid FP ceiling");
        let count = tally
          .total
          .checked_sub(tally.passed)
          .ok_or("invalid tally")?;
        (
          *total,
          count,
          *maximum_false_positives,
          count <= *maximum_false_positives,
          "false-positives",
        )
      }
    };
    writeln!(
      table,
      "{key} | {metric} | {count}/{} | {bound}",
      tally.total
    )?;
    if tally.total != total || !holds {
      failures.push(key.clone());
    }
  }
  assert!(
    failures.is_empty(),
    "corpus thresholds failed: {}",
    failures.join(", ")
  );
  Ok(())
}

#[test]
fn exact_span_scoring_rejects_substrings_and_swallowed_neighbors()
-> Result<(), Box<dyn Error>> {
  let span = |start, end| {
    PipelineEntity::detected(
      start,
      end,
      "person",
      "synthetic",
      1.0,
      DetectionSource::Gazetteer,
    )
  };
  let expected = 5..10;
  assert!(exact_hit(&[span(5, 10)], &expected), "exact span must pass");
  assert!(!exact_hit(&[span(6, 9)], &expected), "substring must fail");
  assert!(
    !exact_hit(&[span(5, 17)], &expected),
    "swallowed neighbor must fail recall"
  );
  assert!(
    overreaches(&[span(5, 17)], &expected),
    "swallowed neighbor must count as FP"
  );
  assert!(
    !exact_hit(&[span(5, 10), span(3, 17)], &expected),
    "exact candidate cannot hide overreach"
  );
  assert!(
    !exact_hit(&[span(5, 7), span(7, 10)], &expected),
    "partial spans cannot masquerade as an exact hit"
  );
  assert!(
    swallows_word(&[span(5, 17)], &expected, "lead Alice signed")?,
    "adjacent word must count as FP"
  );
  assert!(
    !swallows_word(&[span(5, 11)], &expected, "lead Alice.")?,
    "terminal punctuation is an extent mismatch, not a swallowed word"
  );
  Ok(())
}
