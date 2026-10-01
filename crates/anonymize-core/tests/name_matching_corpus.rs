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
  DetectionSource, Operator, OperatorConfig, PipelineEntity, PreparedEngine,
};

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

#[derive(Clone, Copy, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "lowercase")]
enum Language {
  Cs,
  Sk,
  En,
}

impl Language {
  const fn code(self) -> &'static str {
    match self {
      Self::Cs => "cs",
      Self::Sk => "sk",
      Self::En => "en",
    }
  }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
  expectation: Expectation,
  language: Language,
  #[serde(rename = "expectedEntities")]
  expected_entities: Vec<ExpectedEntity>,
  #[serde(rename = "forcedExpectedEntities")]
  forced_expected_entities: Option<Vec<ExpectedEntity>>,
  kind: String,
  text: String,
  surface: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedEntity {
  start: u32,
  end: u32,
  label: String,
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
  languages: &[Language],
) -> Result<PreparedEngine, Box<dyn Error>> {
  // This profile isolates caller-owned names from unrelated dictionary,
  // regex and contextual detectors while using production assembly/resolution.
  let language_codes = languages
    .iter()
    .map(|language| language.code())
    .collect::<Vec<_>>();
  let config: PipelineConfig = serde_json::from_value(serde_json::json!({
    "threshold": 0.3, "enableTriggerPhrases": false, "enableRegex": false,
    "languages": language_codes, "enableLegalForms": false,
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

fn exact_entities(
  entities: &[PipelineEntity],
  expected: &[ExpectedEntity],
) -> bool {
  let mut actual_set = entities
    .iter()
    .map(|entity| {
      (
        entity.start,
        entity.end,
        entity.label.as_str(),
        entity.source == DetectionSource::Gazetteer,
      )
    })
    .collect::<Vec<_>>();
  let mut expected_set = expected
    .iter()
    .map(|entity| (entity.start, entity.end, entity.label.as_str(), true))
    .collect::<Vec<_>>();
  actual_set.sort_unstable();
  expected_set.sort_unstable();
  actual_set == expected_set
}

fn expected_redaction(
  text: &str,
  expected: &[ExpectedEntity],
  operators: &OperatorConfig,
) -> Result<String, Box<dyn Error>> {
  let mut ordered = expected.iter().collect::<Vec<_>>();
  ordered.sort_unstable_by_key(|entity| entity.start);
  let mut output = String::new();
  let mut cursor = 0;
  for entity in ordered {
    let start = usize::try_from(entity.start)?;
    let end = usize::try_from(entity.end)?;
    if start < cursor || start >= end || entity.label.is_empty() {
      return Err("invalid expected entity".into());
    }
    text.get(start..end).ok_or("invalid expected UTF-8 span")?;
    if operators.operators.get(&entity.label) != Some(&Operator::Redact) {
      return Err("corpus oracle requires the redact operator".into());
    }
    output.push_str(text.get(cursor..start).ok_or("invalid expected gap")?);
    output.push_str(&operators.redact_string);
    cursor = end;
  }
  output.push_str(text.get(cursor..).ok_or("invalid expected tail")?);
  Ok(output)
}

fn exact_case(
  entities: &[PipelineEntity],
  redacted_text: &str,
  expected: &[ExpectedEntity],
  expected_text: &str,
) -> bool {
  exact_entities(entities, expected) && redacted_text == expected_text
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
  entries: &[GazetteerEntry],
  cases: &[(&Case, &[ExpectedEntity])],
  mode: &str,
  report: &mut Report,
) -> Result<(), Box<dyn Error>> {
  let scopes = [
    vec![Language::Cs],
    vec![Language::Sk],
    vec![Language::En],
    vec![Language::Cs, Language::Sk],
    vec![Language::Cs, Language::En],
    vec![Language::Sk, Language::En],
    vec![Language::Cs, Language::Sk, Language::En],
  ];
  let engines = scopes
    .into_iter()
    .map(|scope| {
      let scoped_engine = engine(entries, &scope)?;
      Ok((scope, scoped_engine))
    })
    .collect::<Result<BTreeMap<_, _>, Box<dyn Error>>>()?;
  let operators = OperatorConfig {
    operators: entries
      .iter()
      .map(|entry| (entry.label.clone(), Operator::Redact))
      .collect(),
    ..OperatorConfig::default()
  };
  for (case, expected) in cases {
    let range = surface_range(case)?;
    let expected_text = expected_redaction(&case.text, expected, &operators)?;
    let surface_expected = expected
      .iter()
      .any(|entity| entity.start == range.start && entity.end == range.end);
    if (case.expectation == Expectation::Redact) != surface_expected {
      return Err(
        "case expectation must agree with the annotated surface".into(),
      );
    }
    let isolated = engines
      .get([case.language].as_slice())
      .ok_or("missing language scope")?;
    let result = isolated.redact_static_entities(&case.text, &operators)?;
    let mut unchanged = true;
    for (scope, expanded) in &engines {
      if scope.len() == 1 || !scope.contains(&case.language) {
        continue;
      }
      let comparison =
        expanded.redact_static_entities(&case.text, &operators)?;
      unchanged &= result.resolved_entities == comparison.resolved_entities
        && result.redaction == comparison.redaction;
    }
    record(
      report,
      format!("{mode}/language-scope"),
      Expectation::Keep,
      unchanged,
    )?;
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
    let passed = exact_case(
      entities,
      &result.redaction.redacted_text,
      expected,
      &expected_text,
    );
    record(
      report,
      format!("{mode}/{}", case.kind),
      case.expectation,
      passed,
    )?;
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
    &corpus.entries,
    &corpus
      .cases
      .iter()
      .map(|case| (case, case.expected_entities.as_slice()))
      .collect::<Vec<_>>(),
    "deny-list",
    &mut report,
  )?;
  let mut forced_cases = corpus
    .forced_cases
    .iter()
    .map(|case| (case, case.expected_entities.as_slice()))
    .collect::<Vec<_>>();
  for case in corpus
    .cases
    .iter()
    .filter(|case| case.expectation == Expectation::Keep)
  {
    let expected = case
      .forced_expected_entities
      .as_deref()
      .ok_or("missing forced replay expectations")?;
    forced_cases.push((case, expected));
  }
  measure(&forced_entries, &forced_cases, "forced", &mut report)?;
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
fn exact_scoring_rejects_missing_extra_and_mislabelled_entities() {
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
  let expected = [ExpectedEntity {
    start: 10,
    end: 15,
    label: String::from("person"),
  }];
  assert!(
    exact_entities(&[span(10, 15)], &expected),
    "exact entity must pass"
  );
  assert!(
    !exact_entities(&[], &expected),
    "missing expected match must fail keep and redact cases"
  );
  assert!(
    !exact_entities(&[span(11, 14)], &expected),
    "substring must fail"
  );
  assert!(
    !exact_entities(&[span(10, 21)], &expected),
    "swallowed neighbor must fail"
  );
  assert!(
    !exact_entities(&[span(10, 12), span(12, 15)], &expected),
    "partial matches must fail"
  );
  for extra in [span(0, 4), span(16, 21), span(22, 27), span(8, 17)] {
    assert!(
      !exact_entities(&[span(10, 15), extra], &expected),
      "extra entity must fail, including distant context"
    );
  }
  let mut wrong_label = span(10, 15);
  wrong_label.label = String::from("organization");
  assert!(
    !exact_entities(&[wrong_label], &expected),
    "wrong label must fail"
  );
  let mut wrong_source = span(10, 15);
  wrong_source.source = DetectionSource::Regex;
  assert!(
    !exact_entities(&[wrong_source], &expected),
    "wrong source must fail"
  );
  assert!(exact_entities(&[], &[]), "empty entity sets must pass");
  assert!(
    !exact_entities(&[span(10, 15)], &[]),
    "empty expected set must reject any false positive"
  );
  assert!(
    !exact_entities(&[span(10, 15), span(10, 15)], &expected),
    "duplicate entity must fail"
  );
}

#[test]
fn redaction_scoring_preserves_every_unannotated_byte()
-> Result<(), Box<dyn Error>> {
  let text = "žena\u{a0}Alice\r\nnext Bob\nend";
  let expected = [
    ExpectedEntity {
      start: 7,
      end: 12,
      label: String::from("person"),
    },
    ExpectedEntity {
      start: 19,
      end: 22,
      label: String::from("person"),
    },
  ];
  let operators = OperatorConfig {
    operators: BTreeMap::from([(String::from("person"), Operator::Redact)]),
    redact_string: String::from("<removed>"),
  };
  let oracle = expected_redaction(text, &expected, &operators)?;
  assert_eq!(
    oracle, "žena\u{a0}<removed>\r\nnext <removed>\nend",
    "oracle must replace only annotated byte ranges"
  );
  let entities = expected
    .iter()
    .map(|entity| {
      PipelineEntity::detected(
        entity.start,
        entity.end,
        &entity.label,
        "synthetic",
        1.0,
        DetectionSource::Gazetteer,
      )
    })
    .collect::<Vec<_>>();
  assert!(
    exact_case(&entities, &oracle, &expected, &oracle),
    "exact entities and output must pass"
  );
  for corrupted in [
    text.to_owned(),
    oracle.replace("\r\n", "\n"),
    oracle.replace('\u{a0}', " "),
    oracle.replace("end", "END"),
  ] {
    assert!(
      !exact_case(&entities, &corrupted, &expected, &oracle),
      "unchanged source or corrupted context must fail"
    );
  }
  assert_eq!(
    expected_redaction(text, &[], &operators)?,
    text,
    "empty annotations must preserve all text"
  );
  Ok(())
}
