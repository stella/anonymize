#![allow(clippy::expect_used, clippy::float_cmp, clippy::unwrap_used)]

use stella_anonymize_core::{
  DetectionSource, PipelineEntity, SourceDetail, merge_and_dedup,
  sanitize_entities,
};

fn entity(
  source: DetectionSource,
  score: f64,
  start: u32,
  end: u32,
  label: &str,
) -> PipelineEntity {
  PipelineEntity::detected(
    start,
    end,
    label,
    "x".repeat(usize::try_from(end.saturating_sub(start)).unwrap_or(0)),
    score,
    source,
  )
}

fn text_entity(
  text: &str,
  label: &str,
  source: DetectionSource,
) -> PipelineEntity {
  PipelineEntity::detected(0, utf16_len(text), label, text, 0.9, source)
}

fn utf16_len(text: &str) -> u32 {
  u32::try_from(text.encode_utf16().count()).unwrap_or(u32::MAX)
}

#[test]
fn non_overlapping_entities_pass_through_sorted() {
  let result = merge_and_dedup(&[
    entity(DetectionSource::Regex, 0.9, 20, 25, "person"),
    entity(DetectionSource::Regex, 0.7, 0, 5, "person"),
    entity(DetectionSource::Regex, 0.8, 10, 15, "person"),
  ]);

  assert_eq!(result.len(), 3);
  assert_eq!(
    result.iter().map(|entry| entry.start).collect::<Vec<_>>(),
    vec![0, 10, 20]
  );
}

#[test]
fn source_priority_beats_score_for_same_span() {
  let result = merge_and_dedup(&[
    entity(DetectionSource::Ner, 0.99, 0, 10, "person"),
    entity(DetectionSource::Trigger, 0.7, 0, 10, "person"),
  ]);

  assert_eq!(result.len(), 1);
  assert_eq!(
    result.first().expect("result").source,
    DetectionSource::Trigger
  );
}

#[test]
fn gazetteer_has_highest_source_priority() {
  let result = merge_and_dedup(&[
    entity(DetectionSource::Ner, 0.99, 5, 15, "person"),
    entity(DetectionSource::Trigger, 0.99, 5, 15, "person"),
    entity(DetectionSource::Gazetteer, 0.8, 5, 15, "person"),
  ]);

  assert_eq!(result.len(), 1);
  assert_eq!(
    result.first().expect("result").source,
    DetectionSource::Gazetteer
  );
}

#[test]
fn same_priority_uses_score_then_length() {
  let higher_score = merge_and_dedup(&[
    entity(DetectionSource::Regex, 0.85, 0, 8, "person"),
    entity(DetectionSource::Regex, 0.92, 0, 8, "person"),
  ]);
  assert_eq!(higher_score.len(), 1);
  assert_eq!(higher_score.first().expect("result").score, 0.92);

  let longer = merge_and_dedup(&[
    entity(DetectionSource::Ner, 0.9, 0, 5, "person"),
    entity(DetectionSource::Ner, 0.9, 0, 10, "person"),
  ]);
  assert_eq!(longer.len(), 1);
  assert_eq!(longer.first().expect("result").end, 10);
}

#[test]
fn identical_spans_with_different_labels_are_kept() {
  let result = merge_and_dedup(&[
    entity(DetectionSource::Regex, 0.9, 0, 5, "person"),
    entity(DetectionSource::Regex, 0.9, 0, 5, "project"),
  ]);

  assert_eq!(result.len(), 2);
  assert_eq!(
    result
      .iter()
      .map(|entry| entry.label.as_str())
      .collect::<Vec<_>>(),
    vec!["person", "project"]
  );
}

#[test]
fn literal_container_beats_shorter_same_label_match() {
  let result = merge_and_dedup(&[
    entity(DetectionSource::Regex, 1.0, 0, 6, "postal code"),
    entity(DetectionSource::DenyList, 1.0, 0, 11, "postal code"),
  ]);

  assert_eq!(result.len(), 1);
  let kept = result.first().expect("result");
  assert_eq!(kept.source, DetectionSource::DenyList);
  assert_eq!(kept.end, 11);
}

#[test]
fn caller_owned_boundaries_win_overlap_resolution() {
  let mut custom = entity(DetectionSource::Regex, 0.5, 0, 8, "person");
  custom.source_detail = Some(SourceDetail::CustomRegex);
  let result = merge_and_dedup(&[
    entity(DetectionSource::Trigger, 0.99, 0, 10, "person"),
    custom,
  ]);

  assert_eq!(result.len(), 1);
  assert_eq!(
    result.first().expect("result").source_detail,
    Some(SourceDetail::CustomRegex)
  );
}

#[test]
fn same_span_country_loses_to_person() {
  let result = merge_and_dedup(&[
    entity(DetectionSource::Country, 0.95, 0, 5, "country"),
    entity(DetectionSource::DenyList, 0.9, 0, 5, "person"),
  ]);

  assert_eq!(result.len(), 1);
  assert_eq!(result.first().expect("result").label, "person");
}

#[test]
fn sanitize_trims_punctuation_and_updates_utf16_offsets() {
  let mut input =
    text_entity("\"Tesla Shares\"", "organization", DetectionSource::Ner);
  input.start = 10;
  input.end = 10_u32.saturating_add(utf16_len(&input.text));

  let result = sanitize_entities(&[input]);
  assert_eq!(result.len(), 1);
  let entity = result.first().expect("result");
  assert_eq!(entity.text, "Tesla Shares");
  assert_eq!(entity.start, 11);
  assert_eq!(entity.end, 23);
}

#[test]
fn sanitize_preserves_literal_dictionary_punctuation() {
  let result = sanitize_entities(&[
    text_entity("Hello bank!", "organization", DetectionSource::DenyList),
    text_entity(
      "\"Juez y parte\"",
      "organization",
      DetectionSource::DenyList,
    ),
  ]);

  assert_eq!(
    result
      .iter()
      .map(|entry| entry.text.as_str())
      .collect::<Vec<_>>(),
    vec!["Hello bank!", "\"Juez y parte\""]
  );
}

#[test]
fn sanitize_keeps_known_period_suffixes_from_data() {
  let result = sanitize_entities(&[
    text_entity("Acme Inc.", "organization", DetectionSource::Ner),
    text_entity("123 Main St.", "address", DetectionSource::Ner),
    text_entity("Washington, D.C.", "location", DetectionSource::Ner),
  ]);

  assert_eq!(
    result
      .iter()
      .map(|entry| entry.text.as_str())
      .collect::<Vec<_>>(),
    vec!["Acme Inc.", "123 Main St.", "Washington, D.C."]
  );
}

#[test]
fn sanitize_drops_empty_entities() {
  let result = sanitize_entities(&[text_entity(
    "\";!",
    "organization",
    DetectionSource::Ner,
  )]);

  assert!(result.is_empty());
}
