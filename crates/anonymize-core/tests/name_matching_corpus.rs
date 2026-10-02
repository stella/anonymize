//! Deterministic, synthetic gazetteer corpus gate. Run with --nocapture for
//! aggregate metrics. Scores resolved byte spans, including forced identifiers.

#[path = "."]
mod corpus {
  #[path = "support/gazetteer_policy.rs"]
  mod gazetteer_policy;

  use gazetteer_policy::CandidatePolicy;

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

  #[derive(Clone, Copy)]
  enum UncoveredLanguage {
    De,
    Es,
    Fr,
    Hu,
    It,
    Lv,
    Pl,
    PtBr,
    Ro,
    Sv,
  }

  impl UncoveredLanguage {
    const fn code(self) -> &'static str {
      match self {
        Self::De => "de",
        Self::Es => "es",
        Self::Fr => "fr",
        Self::Hu => "hu",
        Self::It => "it",
        Self::Lv => "lv",
        Self::Pl => "pl",
        Self::PtBr => "pt-br",
        Self::Ro => "ro",
        Self::Sv => "sv",
      }
    }
  }

  // This synthetic corpus exercises caller-owned names in cs/sk/en scopes;
  // it does not claim vocabulary coverage for other production languages.
  const UNCOVERED_LANGUAGES: [UncoveredLanguage; 10] = [
    UncoveredLanguage::De,
    UncoveredLanguage::Es,
    UncoveredLanguage::Fr,
    UncoveredLanguage::Hu,
    UncoveredLanguage::It,
    UncoveredLanguage::Lv,
    UncoveredLanguage::Pl,
    UncoveredLanguage::PtBr,
    UncoveredLanguage::Ro,
    UncoveredLanguage::Sv,
  ];

  #[derive(Deserialize)]
  #[serde(deny_unknown_fields)]
  struct Case {
    expectation: Expectation,
    language: Language,
    #[serde(rename = "expectedEntities")]
    expected_entities: Vec<ExpectedEntity>,
    #[serde(rename = "forcedExpectedEntities")]
    forced_expected_entities: Option<Vec<ExpectedEntity>>,
    #[serde(rename = "knownFailure")]
    known_failure: Option<KnownFailure>,
    operators: Option<BTreeMap<String, CorpusOperator>>,
    #[serde(rename = "languageExclusions")]
    language_exclusions: Option<Vec<Language>>,
    #[serde(rename = "negativeCheck")]
    negative_check: Option<NegativeCheck>,
    #[serde(rename = "forcedNegativeCheck")]
    forced_negative_check: Option<NegativeCheck>,
    kind: String,
    text: String,
    surface: String,
  }

  #[derive(Deserialize)]
  #[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
  enum NegativeCheck {
    Suppression {
      surface: String,
      label: String,
      context: String,
    },
    Distinct {
      reason: String,
    },
    Context,
  }

  #[derive(Clone, Copy)]
  enum NegativeScope {
    Configured,
    ForcedReplay,
  }

  #[derive(Deserialize)]
  #[serde(deny_unknown_fields)]
  struct ExpectedEntity {
    start: u32,
    end: u32,
    label: String,
  }

  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase", deny_unknown_fields)]
  struct KnownFailure {
    entities: Vec<ExpectedEntity>,
    redacted_text: String,
  }

  #[derive(Clone, Copy, Deserialize)]
  #[serde(rename_all = "lowercase")]
  enum CorpusOperator {
    Redact,
    Keep,
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
    if case.surface.is_empty() || case.text.matches(&case.surface).count() != 1
    {
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
      output.push_str(text.get(cursor..start).ok_or("invalid expected gap")?);
      match operators.operators.get(&entity.label) {
        Some(Operator::Redact) => output.push_str(&operators.redact_string),
        Some(Operator::Keep) => {
          output.push_str(text.get(start..end).ok_or("invalid kept span")?);
        }
        _ => return Err("unsupported corpus operator".into()),
      }
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

  struct KnownFailureCheck<'a> {
    passed: bool,
    entities: &'a [PipelineEntity],
    redacted_text: &'a str,
    known: Option<&'a KnownFailure>,
  }

  fn verify_known_failure(
    KnownFailureCheck {
      passed,
      entities,
      redacted_text,
      known,
    }: KnownFailureCheck<'_>,
  ) -> Result<(), Box<dyn Error>> {
    match (passed, known) {
      (true, None) => Ok(()),
      (true, Some(_)) => Err(
        "pinned failure now passes; remove its pin and tighten the class bound"
          .into(),
      ),
      (false, None) => Err(
        "unannotated corpus failure; reject regression before updating bounds"
          .into(),
      ),
      (false, Some(pin)) => {
        if !exact_case(
          entities,
          redacted_text,
          &pin.entities,
          &pin.redacted_text,
        ) {
          return Err(
            "pinned failure changed its entities or redacted output".into(),
          );
        }
        Ok(())
      }
    }
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

  fn case_operators(
    case: &Case,
    defaults: &OperatorConfig,
  ) -> Result<OperatorConfig, Box<dyn Error>> {
    let mut operators = defaults.clone();
    if let Some(overrides) = &case.operators {
      for (label, choice) in overrides {
        if !operators.operators.contains_key(label) {
          return Err(
            "operator override must refer to a gazetteer label".into(),
          );
        }
        operators.operators.insert(
          label.clone(),
          match choice {
            CorpusOperator::Redact => Operator::Redact,
            CorpusOperator::Keep => Operator::Keep,
          },
        );
      }
    }
    Ok(operators)
  }

  type ScopedEngines = BTreeMap<Vec<Language>, PreparedEngine>;

  fn scoped_engines(
    entries: &[GazetteerEntry],
  ) -> Result<ScopedEngines, Box<dyn Error>> {
    let scopes = [
      vec![Language::Cs],
      vec![Language::Sk],
      vec![Language::En],
      vec![Language::Cs, Language::Sk],
      vec![Language::Cs, Language::En],
      vec![Language::Sk, Language::En],
      vec![Language::Cs, Language::Sk, Language::En],
    ];
    scopes
      .into_iter()
      .map(|scope| {
        let scoped_engine = engine(entries, &scope)?;
        Ok((scope, scoped_engine))
      })
      .collect()
  }

  struct LanguageExclusionCheck<'a> {
    case: &'a Case,
    engines: &'a ScopedEngines,
    operators: &'a OperatorConfig,
    mode: &'a str,
    report: &'a mut Report,
  }

  fn check_language_exclusions(
    LanguageExclusionCheck {
      case,
      engines,
      operators,
      mode,
      report,
    }: LanguageExclusionCheck<'_>,
  ) -> Result<(), Box<dyn Error>> {
    let Some(exclusions) = &case.language_exclusions else {
      return Ok(());
    };
    if exclusions.is_empty() {
      return Err("language exclusion list must not be empty".into());
    }
    for excluded in exclusions {
      if *excluded == case.language {
        return Err("cannot exclude the case's own language".into());
      }
      let excluded_engine = engines
        .get([*excluded].as_slice())
        .ok_or("missing excluded scope")?;
      let excluded_result =
        excluded_engine.redact_static_entities(&case.text, operators)?;
      let excluded_passed = exact_case(
        &excluded_result.resolved_entities,
        &excluded_result.redaction.redacted_text,
        &[],
        &case.text,
      );
      if !excluded_passed {
        return Err(
          format!(
            "{mode}/{}: excluded language matched or changed text",
            case.kind
          )
          .into(),
        );
      }
      record(
        report,
        format!("{mode}/language-exclusion"),
        Expectation::Keep,
        excluded_passed,
      )?;
    }

    Ok(())
  }

  const SUPPRESSION_CLASSES: &[&str] = &[
    "hex",
    "uuid",
    "hash",
    "id-code",
    "marker-suppression",
    "bracketed-id",
  ];

  /// Remove the guarding envelope at the original occurrence, preserving its
  /// byte offsets and every byte outside the annotated surface. Unlike a neutral
  /// sentence, this control proves that the guarded occurrence is a real candidate.
  fn unguarded_control(
    case: &Case,
    seed: &str,
  ) -> Result<(String, usize), Box<dyn Error>> {
    let envelope = surface_range(case)?;
    let envelope_start = usize::try_from(envelope.start)?;
    let envelope_end = usize::try_from(envelope.end)?;
    let seed_start = envelope_start
      .checked_add(case.surface.find(seed).ok_or("missing guard seed")?)
      .ok_or("control offset overflow")?;
    let seed_end = seed_start
      .checked_add(seed.len())
      .ok_or("control offset overflow")?;
    let policy = CandidatePolicy::new(&case.text);
    if policy.edges_are_free(seed_start, seed_end)
      && !policy.in_identifier(seed_start, seed_end)
      && !case.known_failure.as_ref().is_some_and(|known| {
        known.entities.iter().any(|entity| {
          usize::try_from(entity.start).is_ok_and(|start| start <= seed_start)
            && usize::try_from(entity.end).is_ok_and(|end| end >= seed_end)
        })
      })
    {
      return Err(
        "guarded occurrence passes both admission and identifier checks".into(),
      );
    }
    let mut control = String::new();
    control.push_str(
      case
        .text
        .get(..envelope_start)
        .ok_or("invalid envelope start")?,
    );
    control.push_str(
      &" ".repeat(
        seed_start
          .checked_sub(envelope_start)
          .ok_or("invalid seed start")?,
      ),
    );
    control.push_str(seed);
    control.push_str(
      &" ".repeat(
        envelope_end
          .checked_sub(seed_end)
          .ok_or("invalid seed end")?,
      ),
    );
    control.push_str(
      case
        .text
        .get(envelope_end..)
        .ok_or("invalid envelope end")?,
    );
    let control_policy = CandidatePolicy::new(&control);
    if !control_policy.edges_are_free(seed_start, seed_end)
      || control_policy.in_identifier(seed_start, seed_end)
    {
      return Err(
        "counterfactual did not remove the candidate's suppression conditions"
          .into(),
      );
    }
    Ok((control, seed_start))
  }

  struct NegativeControlCheck<'a> {
    case: &'a Case,
    expected: &'a [ExpectedEntity],
    check: Option<&'a NegativeCheck>,
    scope: NegativeScope,
    engine: &'a PreparedEngine,
    operators: &'a OperatorConfig,
  }

  fn check_negative_control(
    NegativeControlCheck {
      case,
      expected,
      check,
      scope,
      engine: isolated,
      operators,
    }: NegativeControlCheck<'_>,
  ) -> Result<Option<bool>, Box<dyn Error>> {
    if case.expectation == Expectation::Redact {
      if check.is_some() {
        return Err("redact fixture cannot declare negative intent".into());
      }
      return Ok(None);
    }
    let intent =
      check.ok_or("every keep fixture must declare its negative intent")?;
    if matches!(scope, NegativeScope::Configured)
      && SUPPRESSION_CLASSES.contains(&case.kind.as_str())
      && !matches!(intent, NegativeCheck::Suppression { .. })
    {
      return Err("guard class requires a suppression positive control".into());
    }
    match intent {
      NegativeCheck::Distinct { reason } => {
        if reason.trim().is_empty() || !expected.is_empty() {
          return Err(
            "distinct negatives require a rationale and an empty expected set"
              .into(),
          );
        }
        Ok(None)
      }
      NegativeCheck::Context => {
        if expected.is_empty() {
          return Err(
            "context negatives require expected matches elsewhere".into(),
          );
        }
        Ok(None)
      }
      NegativeCheck::Suppression {
        surface,
        label,
        context,
      } => {
        if surface.is_empty()
          || !expected.is_empty()
          || case.surface.matches(surface.as_str()).count() != 1
          || context.matches(surface.as_str()).count() != 1
        {
          return Err("suppression control must occur once inside the guarded surface and neutral context".into());
        }
        let start = context.find(surface).ok_or("missing control surface")?;
        let control_expected = [ExpectedEntity {
          start: u32::try_from(start)?,
          end: u32::try_from(
            start
              .checked_add(surface.len())
              .ok_or("control offset overflow")?,
          )?,
          label: label.clone(),
        }];
        let expected_text =
          expected_redaction(context, &control_expected, operators)?;
        let result = isolated.redact_static_entities(context, operators)?;
        if !exact_case(
          &result.resolved_entities,
          &result.redaction.redacted_text,
          &control_expected,
          &expected_text,
        ) {
          return Err("guard positive control did not resolve its complete configured surface".into());
        }
        let (control, guarded_start) = unguarded_control(case, surface)?;
        let counterfactual_expected = [ExpectedEntity {
          start: u32::try_from(guarded_start)?,
          end: u32::try_from(
            guarded_start
              .checked_add(surface.len())
              .ok_or("control offset overflow")?,
          )?,
          label: label.clone(),
        }];
        let counterfactual_text =
          expected_redaction(&control, &counterfactual_expected, operators)?;
        let counterfactual =
          isolated.redact_static_entities(&control, operators)?;
        if !exact_case(
          &counterfactual.resolved_entities,
          &counterfactual.redaction.redacted_text,
          &counterfactual_expected,
          &counterfactual_text,
        ) {
          return Err(
            "unguarded occurrence did not resolve at its original byte span"
              .into(),
          );
        }
        Ok(Some(true))
      }
    }
  }

  fn validate_resolved_spans(
    entities: &[PipelineEntity],
    text: &str,
  ) -> Result<(), Box<dyn Error>> {
    for entity in entities {
      let start = usize::try_from(entity.start)?;
      let end = usize::try_from(entity.end)?;
      if start >= end || text.get(start..end).is_none() {
        return Err("invalid resolved UTF-8 span".into());
      }
    }
    Ok(())
  }

  struct ScoredCase<'a> {
    case: &'a Case,
    expected: &'a [ExpectedEntity],
    known_failure: Option<&'a KnownFailure>,
    negative_check: Option<&'a NegativeCheck>,
    negative_scope: NegativeScope,
  }

  fn measure(
    entries: &[GazetteerEntry],
    cases: &[ScoredCase<'_>],
    mode: &str,
    report: &mut Report,
  ) -> Result<(), Box<dyn Error>> {
    let engines = scoped_engines(entries)?;
    let default_operators = OperatorConfig {
      operators: entries
        .iter()
        .map(|entry| (entry.label.clone(), Operator::Redact))
        .collect(),
      ..OperatorConfig::default()
    };
    for ScoredCase {
      case,
      expected,
      known_failure,
      negative_check,
      negative_scope,
    } in cases
    {
      let operators = case_operators(case, &default_operators)?;
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
      if let Some(control_passed) =
        check_negative_control(NegativeControlCheck {
          case,
          expected,
          check: *negative_check,
          scope: *negative_scope,
          engine: isolated,
          operators: &operators,
        })
        .map_err(|error| format!("{mode}/{}: {error}", case.kind))?
      {
        record(
          report,
          format!("{mode}/guard-control"),
          Expectation::Redact,
          control_passed,
        )?;
      }
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
      check_language_exclusions(LanguageExclusionCheck {
        case,
        engines: &engines,
        operators: &operators,
        mode,
        report,
      })?;
      let entities = &result.resolved_entities;
      validate_resolved_spans(entities, &case.text)?;
      let passed = exact_case(
        entities,
        &result.redaction.redacted_text,
        expected,
        &expected_text,
      );
      verify_known_failure(KnownFailureCheck {
        passed,
        entities,
        redacted_text: &result.redaction.redacted_text,
        known: *known_failure,
      })
      .map_err(|error| format!("{mode}/{}: {error}", case.kind))?;
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
    assert_eq!(
      corpus
        .cases
        .iter()
        .filter(|case| matches!(
          case.negative_check,
          Some(NegativeCheck::Suppression { .. })
        ))
        .map(|case| case.kind.as_str())
        .collect::<BTreeSet<_>>(),
      SUPPRESSION_CLASSES.iter().copied().collect::<BTreeSet<_>>(),
      "declared suppression classes must exactly equal exercised classes"
    );
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
        .map(|case| ScoredCase {
          case,
          expected: &case.expected_entities,
          known_failure: case.known_failure.as_ref(),
          negative_check: case.negative_check.as_ref(),
          negative_scope: NegativeScope::Configured,
        })
        .collect::<Vec<_>>(),
      "deny-list",
      &mut report,
    )?;
    let mut forced_cases = corpus
      .forced_cases
      .iter()
      .map(|case| ScoredCase {
        case,
        expected: &case.expected_entities,
        known_failure: case.known_failure.as_ref(),
        negative_check: case.negative_check.as_ref(),
        negative_scope: NegativeScope::Configured,
      })
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
      forced_cases.push(ScoredCase {
        case,
        expected,
        known_failure: None,
        negative_check: case.forced_negative_check.as_ref(),
        negative_scope: NegativeScope::ForcedReplay,
      });
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

  #[test]
  fn tolerated_failures_cannot_drift_or_silently_improve()
  -> Result<(), Box<dyn Error>> {
    let pin = KnownFailure {
      entities: vec![],
      redacted_text: String::from("Alice signed."),
    };
    verify_known_failure(KnownFailureCheck {
      passed: false,
      entities: &[],
      redacted_text: "Alice signed.",
      known: Some(&pin),
    })?;
    assert!(
      verify_known_failure(KnownFailureCheck {
        passed: false,
        entities: &[],
        redacted_text: "Alice signed!",
        known: Some(&pin)
      })
      .is_err(),
      "changed output must invalidate a pin"
    );
    let unexpected = PipelineEntity::detected(
      6,
      12,
      "person",
      "signed",
      1.0,
      DetectionSource::Gazetteer,
    );
    assert!(
      verify_known_failure(KnownFailureCheck {
        passed: false,
        entities: &[unexpected],
        redacted_text: "Alice signed.",
        known: Some(&pin)
      })
      .is_err(),
      "changed entities must invalidate a pin even when output is identical"
    );
    assert!(
      verify_known_failure(KnownFailureCheck {
        passed: false,
        entities: &[],
        redacted_text: "Alice signed.",
        known: None
      })
      .is_err(),
      "every tolerated failure must be explicitly pinned"
    );
    let improved = verify_known_failure(KnownFailureCheck {
      passed: true,
      entities: &[],
      redacted_text: "[REDACTED] signed.",
      known: Some(&pin),
    });
    assert!(
      improved.is_err(),
      "newly passing pinned failure requires a tightened bound"
    );
    Ok(())
  }

  #[test]
  fn expected_output_honors_per_label_operators() -> Result<(), Box<dyn Error>>
  {
    let expected = [
      ExpectedEntity {
        start: 0,
        end: 4,
        label: String::from("organization"),
      },
      ExpectedEntity {
        start: 5,
        end: 10,
        label: String::from("person"),
      },
    ];
    let operators = OperatorConfig {
      operators: BTreeMap::from([
        (String::from("organization"), Operator::Keep),
        (String::from("person"), Operator::Redact),
      ]),
      redact_string: String::from("<redacted>"),
    };
    let oracle = expected_redaction("Zeta Alice", &expected, &operators)?;
    assert_eq!(
      oracle, "Zeta <redacted>",
      "operator dispatch must preserve kept names and redact only the other label"
    );
    Ok(())
  }

  #[test]
  fn guard_controls_reject_absent_or_unmatchable_seeds()
  -> Result<(), Box<dyn Error>> {
    let corpus: Corpus =
      serde_json::from_str(include_str!("fixtures/name_matching/corpus.json"))?;
    let sample = corpus
      .cases
      .iter()
      .find(|case| case.kind == "uuid")
      .ok_or("missing UUID guard fixture")?;
    let isolated = engine(&corpus.entries, &[sample.language])?;
    let operators = OperatorConfig {
      operators: BTreeMap::from([(
        String::from("organization"),
        Operator::Redact,
      )]),
      ..OperatorConfig::default()
    };
    let verify = |check| {
      check_negative_control(NegativeControlCheck {
        case: sample,
        expected: &[],
        check,
        scope: NegativeScope::Configured,
        engine: &isolated,
        operators: &operators,
      })
    };
    assert_eq!(
      verify(sample.negative_check.as_ref())?,
      Some(true),
      "seeded guard fixture must pass its production positive control"
    );
    assert!(
      verify(None).is_err(),
      "guard fixture cannot omit its control"
    );
    let distinct = NegativeCheck::Distinct {
      reason: String::from("intentional non-match"),
    };
    assert!(
      verify(Some(&distinct)).is_err(),
      "guard class cannot evade its control by declaring a non-match"
    );
    let unrelated = NegativeCheck::Suppression {
      surface: String::from("Zeta"),
      label: String::from("organization"),
      context: String::from("before Zeta after"),
    };
    assert!(
      verify(Some(&unrelated)).is_err(),
      "matchable control must occur inside the guarded region"
    );
    let empty = engine(&[], &[sample.language])?;
    assert!(
      check_negative_control(NegativeControlCheck {
        case: sample,
        expected: &[],
        check: sample.negative_check.as_ref(),
        scope: NegativeScope::Configured,
        engine: &empty,
        operators: &operators
      })
      .is_err(),
      "embedded seed without a configured match must fail its control"
    );
    Ok(())
  }

  #[test]
  fn guarded_occurrence_controls_cover_edge_and_identifier_admission()
  -> Result<(), Box<dyn Error>> {
    let corpus: Corpus =
      serde_json::from_str(include_str!("fixtures/name_matching/corpus.json"))?;
    let mut edge_controls = 0;
    let mut identifier_controls = 0;
    for case in &corpus.cases {
      let Some(NegativeCheck::Suppression { surface, .. }) =
        &case.negative_check
      else {
        continue;
      };
      let (control, start) = unguarded_control(case, surface)?;
      let end = start
        .checked_add(surface.len())
        .ok_or("control offset overflow")?;
      let policy = CandidatePolicy::new(&case.text);
      if policy.edges_are_free(start, end) {
        if policy.in_identifier(start, end) {
          identifier_controls += 1;
        } else {
          assert!(
            case.known_failure.is_some(),
            "admitted unsuppressed seed requires a pinned accepted match"
          );
        }
      } else {
        edge_controls += 1;
      }
      assert_eq!(control.get(start..end), Some(surface.as_str()));
    }
    assert!(edge_controls > 0 && identifier_controls > 0);
    // Exact bot input: this is an edge rejection, not an identifier-guard witness.
    let text = "acfe0a1b2c3d4e5f";
    let policy = CandidatePolicy::new(text);
    assert!(!policy.edges_are_free(0, 4));
    assert!(!policy.in_identifier(0, 4));
    let unguarded_case: Case = serde_json::from_value(serde_json::json!({
      "expectation": "keep", "language": "en", "expectedEntities": [],
      "kind": "hex", "text": "before acfe after", "surface": "acfe"
    }))?;
    assert!(
      unguarded_control(&unguarded_case, "acfe").is_err(),
      "a plain admitted occurrence cannot masquerade as suppression"
    );
    let uuid = "9b1d0c3e-acfe-4ca1-8b2e-5c7a0a1b2c3d";
    let admitted = CandidatePolicy::new(uuid);
    assert!(admitted.edges_are_free(9, 13));
    assert!(admitted.in_identifier(9, 13));
    Ok(())
  }

  #[test]
  fn forced_positive_language_matrix_accounts_for_production_support()
  -> Result<(), Box<dyn Error>> {
    let corpus: Corpus =
      serde_json::from_str(include_str!("fixtures/name_matching/corpus.json"))?;
    let covered = scoped_engines(&[])?
      .into_keys()
      .filter(|scope| scope.len() == 1)
      .collect::<BTreeSet<_>>();
    let covered_codes = covered
      .iter()
      .flatten()
      .map(|language| language.code())
      .collect::<BTreeSet<_>>();
    let uncovered_codes = UNCOVERED_LANGUAGES
      .into_iter()
      .map(UncoveredLanguage::code)
      .collect::<BTreeSet<_>>();
    assert_eq!(uncovered_codes.len(), UNCOVERED_LANGUAGES.len());
    assert!(
      covered_codes.is_disjoint(&uncovered_codes),
      "covered and explicitly uncovered languages must be disjoint"
    );
    // pipeline-language.ts derives SUPPORTED_LANGUAGES from this same file.
    let production: serde_json::Value = serde_json::from_str(include_str!(
      "../../../packages/anonymize/src/data/language-scopes.json"
    ))?;
    let supported_codes = production
      .get("languages")
      .and_then(serde_json::Value::as_object)
      .ok_or("production language scopes must contain a languages object")?
      .keys()
      .map(String::as_str)
      .collect::<BTreeSet<_>>();
    let accounted_codes = covered_codes
      .union(&uncovered_codes)
      .copied()
      .collect::<BTreeSet<_>>();
    assert_eq!(
      accounted_codes, supported_codes,
      "every production language must be covered or explicitly uncovered"
    );
    let mut coverage = BTreeMap::<_, BTreeSet<_>>::new();
    for case in &corpus.forced_cases {
      if case.expectation == Expectation::Redact {
        coverage
          .entry(case.kind.as_str())
          .or_default()
          .insert(vec![case.language]);
      }
    }
    assert!(!coverage.is_empty());
    for languages in coverage.values() {
      assert!(
        *languages == covered,
        "each forced positive class must cover every isolated corpus language"
      );
    }
    Ok(())
  }
}
