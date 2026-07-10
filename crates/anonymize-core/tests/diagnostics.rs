#![allow(clippy::unwrap_used)]

#[path = "support/snapshots.rs"]
mod snapshots;
mod support;

use snapshots::diagnostics_snapshot;
use stella_anonymize_core::{
  DenyListMatchData, DenyListPatternMetaSet, DiagnosticEvent,
  DiagnosticEventKind, DiagnosticPhase, DiagnosticScope, DiagnosticStage,
  Error, GazetteerMatchData, LiteralSearchOptions, OperatorConfig,
  PatternSlice, PreparedEngine, PreparedEngineConfig, PreparedEngineSlices,
  RegexMatchMeta, RegexSearchOptions, SearchEngine, SearchOptions,
  SearchPattern, StaticRedactionStreamEvent,
};
use support::prepared_config;

fn empty_config(slices: PreparedEngineSlices) -> PreparedEngineConfig {
  prepared_config! {
    regex_patterns: vec![],
    custom_regex_patterns: vec![],
    literal_patterns: vec![],
    regex_options: SearchOptions::default(),
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions::default(),
    allowed_labels: vec![],
    threshold: 0.0,
    confidence_boost: false,
    slices: slices,
    regex_meta: vec![],
    custom_regex_meta: vec![],
    deny_list_data: None,
    false_positive_filters: None,
    gazetteer_data: None,
    country_data: None,
    hotword_data: None,
    trigger_data: None,
    legal_form_data: None,
    address_seed_data: None,
    zone_data: None,
    address_context_data: None,
    coreference_data: None,
    name_corpus_data: None,
    signature_data: None,
    date_data: None,
    monetary_data: None,
  }
}

fn static_redaction_diagnostics_engine() -> PreparedEngine {
  PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\b[A-Z]{2}\d{4}\b",
    ))],
    custom_regex_patterns: vec![],
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Acme"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    regex_options: SearchOptions {
      regex: RegexSearchOptions {
        whole_words: false,
        overlap_all: false,
        ..RegexSearchOptions::default()
      },
      ..SearchOptions::default()
    },
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    allowed_labels: vec![],
    threshold: 0.0,
    confidence_boost: false,
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      gazetteer: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("registration number", 0.9)],
    custom_regex_meta: vec![],
    deny_list_data: None,
    false_positive_filters: None,
    gazetteer_data: Some(GazetteerMatchData {
      labels: vec![String::from("organization")],
      is_fuzzy: vec![false],
    }),
    country_data: None,
    hotword_data: None,
    trigger_data: None,
    legal_form_data: None,
    address_seed_data: None,
    zone_data: None,
    address_context_data: None,
    coreference_data: None,
    name_corpus_data: None,
    signature_data: None,
    date_data: None,
    monetary_data: None,
  })
  .unwrap()
}

#[test]
fn engine_reports_static_redaction_diagnostics() {
  const INPUT: &str = "Acme s.r.o. filed AB1234.";
  let prepared = static_redaction_diagnostics_engine();
  let result = prepared
    .redact_static_entities_with_diagnostics(INPUT, &OperatorConfig::default())
    .unwrap();

  assert_eq!(
    result.result.redaction.redacted_text,
    "[ORGANIZATION_1] filed [REGISTRATION_NUMBER_1]."
  );
  let events = &result.diagnostics.events;
  assert_stage_summary(events, DiagnosticStage::SearchRegex, Some(1), None);
  assert_stage_summary(
    events,
    DiagnosticStage::DetectTotal,
    Some(2),
    Some(INPUT.len()),
  );
  assert!(result.diagnostics.events.iter().any(|event| {
    event.stage == DiagnosticStage::FindLiteral
      && event.kind == DiagnosticEventKind::StageSummary
      && event.engine == Some(SearchEngine::Literal)
      && event.slot == Some(0)
      && event.pattern_count == Some(1)
      && event.count == Some(1)
  }));
  assert!(result.diagnostics.events.iter().any(|event| {
    event.stage == DiagnosticStage::Sanitize
      && event.kind == DiagnosticEventKind::Entity
      && event.label.as_deref() == Some("organization")
      && event.span_valid == Some(true)
  }));
  assert!(
    result
      .diagnostics
      .events
      .iter()
      .all(|event| event.text.is_none())
  );
  assert_stage_summary(events, DiagnosticStage::Redaction, Some(2), None);
  assert_stage_summary(
    events,
    DiagnosticStage::RedactTotal,
    Some(2),
    Some(INPUT.len()),
  );
  insta::assert_yaml_snapshot!(
    "static_redaction_diagnostics",
    diagnostics_snapshot(&result.result.redaction, events)
  );
}

#[test]
fn engine_streams_diagnostic_batches() {
  let prepared = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Secret Code"),
      case_insensitive: Some(true),
      whole_words: Some(true),
    }],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("matter")]].into(),
      custom_labels: vec![vec![String::from("matter")]].into(),
      originals: vec![String::from("Secret Code")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("custom-deny-list")]].into(),
      filters: None,
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let mut streamed_events = Vec::new();
  let mut batch_stages = Vec::new();

  let result = prepared
    .redact_static_entities_with_diagnostics_observer(
      "Secret Code was disclosed.",
      &OperatorConfig::default(),
      |events| {
        batch_stages
          .push(events.iter().map(|event| event.stage).collect::<Vec<_>>());
        streamed_events.extend_from_slice(events);
        Ok::<(), Error>(())
      },
    )
    .unwrap();

  assert_eq!(
    result.result.redaction.redacted_text,
    "[MATTER_1] was disclosed."
  );
  assert_eq!(streamed_events, result.diagnostics.events);
  assert!(
    batch_stages
      .first()
      .is_some_and(|stages| stages.contains(&DiagnosticStage::DetectTotal)
        && !stages.contains(&DiagnosticStage::Redaction))
  );
  assert!(
    batch_stages
      .last()
      .is_some_and(|stages| stages.contains(&DiagnosticStage::Redaction)
        && stages.contains(&DiagnosticStage::RedactTotal))
  );
}

#[test]
fn engine_streams_static_redaction_results() {
  let prepared = PreparedEngine::new(prepared_config! {
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Secret Code"),
      case_insensitive: Some(false),
      whole_words: Some(true),
    }],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: false,
        whole_words: true,
      },
      ..SearchOptions::default()
    },
    slices: PreparedEngineSlices {
      deny_list: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    deny_list_data: Some(DenyListMatchData {
      labels: vec![vec![String::from("matter")]].into(),
      custom_labels: vec![vec![String::from("matter")]].into(),
      originals: vec![String::from("Secret Code")],
      pattern_meta: DenyListPatternMetaSet::default(),
      sources: vec![vec![String::from("custom-deny-list")]].into(),
      filters: None,
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();
  let mut event_types = Vec::new();
  let mut event_counts = Vec::new();

  let result = prepared
    .redact_static_entities_with_result_observer(
      "Secret Code was disclosed.",
      &OperatorConfig::default(),
      |event| {
        match event {
          StaticRedactionStreamEvent::DetectedEntities(detections) => {
            event_types.push("detected");
            event_counts.push(detections.entity_count());
          }
          StaticRedactionStreamEvent::ResolvedEntities(entities) => {
            event_types.push("resolved");
            event_counts.push(entities.len());
          }
          StaticRedactionStreamEvent::Redacted(redaction) => {
            event_types.push("redacted");
            event_counts.push(redaction.entity_count);
          }
        }
        Ok::<(), Error>(())
      },
    )
    .unwrap();

  assert_eq!(event_types, ["detected", "resolved", "redacted"]);
  assert_eq!(event_counts, [1, 1, 1]);
  assert_eq!(result.redaction.redacted_text, "[MATTER_1] was disclosed.");
}

fn assert_stage_summary(
  events: &[DiagnosticEvent],
  stage: DiagnosticStage,
  count: Option<usize>,
  input_bytes: Option<usize>,
) {
  assert!(
    events.iter().any(|event| {
      event.stage == stage
        && event.kind == DiagnosticEventKind::StageSummary
        && event.count == count
        && input_bytes
          .is_none_or(|expected| event.input_bytes == Some(expected))
        && event.elapsed_us.is_some()
    }),
    "missing summary stage {stage:?} count {count:?}",
  );
}

#[test]
fn diagnostic_stages_report_pipeline_phase() {
  assert_eq!(
    DiagnosticStage::PrepareRegex.phase(),
    DiagnosticPhase::Prepare
  );
  assert_eq!(DiagnosticStage::WarmRegex.phase(), DiagnosticPhase::Warm);
  assert_eq!(
    DiagnosticStage::FindLiteral.phase(),
    DiagnosticPhase::Search
  );
  assert_eq!(
    DiagnosticStage::EntityDenyList.phase(),
    DiagnosticPhase::Detect
  );
  assert_eq!(
    DiagnosticStage::EntityHotword.phase(),
    DiagnosticPhase::Resolve
  );
  assert_eq!(DiagnosticStage::Sanitize.phase(), DiagnosticPhase::Resolve);
  assert_eq!(
    DiagnosticStage::RedactTotal.phase(),
    DiagnosticPhase::Redact
  );
}

#[test]
fn engine_reports_lazy_regex_warm_diagnostics() {
  let prepared = PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::RegexWithOptions {
      pattern: String::from(r"\b[A-Z]{2}\d{4}\b"),
      lazy: true,
      prefilter_any: Vec::new(),
      prefilter_case_insensitive: None,
      prefilter_regex: None,
      prefilter_window_bytes: None,
      prepared_artifact_policy: None,
    }],
    custom_regex_patterns: vec![SearchPattern::RegexWithOptions {
      pattern: String::from(r"\bREF-\d{3}\b"),
      lazy: true,
      prefilter_any: Vec::new(),
      prefilter_case_insensitive: None,
      prefilter_regex: None,
      prefilter_window_bytes: None,
      prepared_artifact_policy: None,
    }],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      custom_regex: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("registration number", 0.9)],
    custom_regex_meta: vec![RegexMatchMeta::new("reference number", 0.9)],
    ..empty_config(PreparedEngineSlices::default())
  })
  .unwrap();

  let diagnostics = prepared.warm_lazy_regex_diagnostics().unwrap();
  let events = &diagnostics.events;

  assert_stage_summary(events, DiagnosticStage::WarmRegex, Some(1), None);
  assert_stage_summary(events, DiagnosticStage::WarmCustomRegex, Some(1), None);
  assert_stage_summary(
    events,
    DiagnosticStage::WarmLegalFormSearch,
    Some(0),
    None,
  );
  assert_stage_summary(
    events,
    DiagnosticStage::WarmTriggerSearch,
    Some(0),
    None,
  );
  assert_stage_summary(events, DiagnosticStage::WarmLiteral, Some(0), None);
  assert_stage_summary(events, DiagnosticStage::WarmTotal, Some(2), None);
}

#[test]
fn diagnostic_events_report_scope() {
  let total = DiagnosticEvent {
    stage: DiagnosticStage::RedactTotal,
    kind: DiagnosticEventKind::StageSummary,
    count: None,
    slot: None,
    subslot: None,
    pattern_count: None,
    engine: None,
    pattern: None,
    source: None,
    source_detail: None,
    provider_id: None,
    detection_id: None,
    label: None,
    start: None,
    end: None,
    text: None,
    score: None,
    span_valid: None,
    elapsed_us: None,
    input_bytes: None,
    artifact_count: None,
    artifact_bytes: None,
    reason: None,
  };
  let mut slot = total.clone();
  slot.stage = DiagnosticStage::FindLiteral;
  slot.slot = Some(0);
  let mut detail = total.clone();
  detail.kind = DiagnosticEventKind::Entity;

  assert_eq!(total.scope(), DiagnosticScope::Total);
  assert_eq!(slot.scope(), DiagnosticScope::Slot);
  assert_eq!(detail.scope(), DiagnosticScope::Detail);
}

#[test]
fn engine_reports_prepare_slot_diagnostics() {
  let config = prepared_config! {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"\b[A-Z]{2}\d{4}\b",
    ))],
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Acme"),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedEngineSlices {
      regex: PatternSlice { start: 0, end: 1 },
      gazetteer: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("registration number", 0.9)],
    gazetteer_data: Some(GazetteerMatchData {
      labels: vec![String::from("organization")],
      is_fuzzy: vec![false],
    }),
    ..empty_config(PreparedEngineSlices::default())
  };
  let artifacts = PreparedEngine::prepare_artifacts(config.clone()).unwrap();

  let result =
    PreparedEngine::new_with_artifacts_diagnostics(config, &artifacts).unwrap();

  assert!(result.diagnostics.events.iter().any(|event| {
    event.stage == DiagnosticStage::PrepareRegex
      && event.kind == DiagnosticEventKind::StageSummary
      && event.slot.is_none()
      && event.count == Some(1)
  }));
  assert!(result.diagnostics.events.iter().any(|event| {
    event.stage == DiagnosticStage::PrepareRegex
      && event.kind == DiagnosticEventKind::StageSummary
      && event.slot == Some(0)
      && event.engine == Some(SearchEngine::Regex)
      && event.pattern_count == Some(1)
      && event.artifact_count.is_some_and(|count| count > 0)
      && event.artifact_bytes.is_some_and(|bytes| bytes > 0)
      && event.elapsed_us.is_some()
  }));
}
