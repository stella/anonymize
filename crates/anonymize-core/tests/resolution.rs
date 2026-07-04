#![allow(clippy::expect_used, clippy::float_cmp, clippy::unwrap_used)]

use stella_anonymize_core::{
  DetectionSource, PipelineEntity, SourceDetail, enforce_boundary_consistency,
  merge_and_dedup, sanitize_entities,
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
  PipelineEntity::detected(0, byte_len(text), label, text, 0.9, source)
}

fn byte_len(text: &str) -> u32 {
  u32::try_from(text.len()).unwrap_or(u32::MAX)
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
fn structured_regex_span_beats_inner_trigger_fragment() {
  let result = merge_and_dedup(&[
    entity(DetectionSource::Regex, 0.95, 0, 22, "registration number"),
    entity(DetectionSource::Trigger, 0.95, 7, 8, "registration number"),
  ]);

  assert_eq!(result.len(), 1);
  let kept = result.first().expect("result");
  assert_eq!(kept.source, DetectionSource::Regex);
  assert_eq!(kept.start, 0);
  assert_eq!(kept.end, 22);
}

#[test]
fn structured_regex_span_beats_trigger_fragment_with_trailing_punctuation() {
  let regex_text = "oddíl C, vložka 240118";
  let trigger_start = byte_len("oddíl C, vložka ");
  let trigger_text = "240118,";
  let result = merge_and_dedup(&[
    PipelineEntity::detected(
      0,
      byte_len(regex_text),
      "registration number",
      regex_text,
      0.95,
      DetectionSource::Regex,
    ),
    PipelineEntity::detected(
      trigger_start,
      trigger_start + byte_len(trigger_text),
      "registration number",
      trigger_text,
      0.95,
      DetectionSource::Trigger,
    ),
  ]);

  assert_eq!(result.len(), 1);
  let kept = result.first().expect("result");
  assert_eq!(kept.source, DetectionSource::Regex);
  assert_eq!(kept.start, 0);
  assert_eq!(kept.end, byte_len(regex_text));
}

#[test]
fn structured_regex_span_beats_sentence_final_trigger_fragment() {
  // "...vložka 12345." — the n-word trigger captures "12345." with the
  // sentence-final period, poking one byte past the commercial-register regex
  // end. The trailing period must be ignored so the regex still absorbs the
  // fragment and the fuller phrase wins.
  let regex_text = "oddíl C, vložka 12345";
  let trigger_start = byte_len("oddíl C, vložka ");
  let trigger_text = "12345.";
  let result = merge_and_dedup(&[
    PipelineEntity::detected(
      0,
      byte_len(regex_text),
      "registration number",
      regex_text,
      0.95,
      DetectionSource::Regex,
    ),
    PipelineEntity::detected(
      trigger_start,
      trigger_start + byte_len(trigger_text),
      "registration number",
      trigger_text,
      0.95,
      DetectionSource::Trigger,
    ),
  ]);

  assert_eq!(result.len(), 1);
  let kept = result.first().expect("result");
  assert_eq!(kept.source, DetectionSource::Regex);
  assert_eq!(kept.text, regex_text);
}

#[test]
fn structured_date_regex_span_beats_trigger_fragment() {
  let regex_text = "21. März 1968";
  let trigger_text = "21.";
  let result = merge_and_dedup(&[
    PipelineEntity::detected(
      0,
      byte_len(regex_text),
      "date of birth",
      regex_text,
      0.9,
      DetectionSource::Regex,
    ),
    PipelineEntity::detected(
      0,
      byte_len(trigger_text),
      "date of birth",
      trigger_text,
      0.95,
      DetectionSource::Trigger,
    ),
  ]);

  assert_eq!(result.len(), 1);
  let kept = result.first().expect("result");
  assert_eq!(kept.source, DetectionSource::Regex);
  assert_eq!(kept.text, regex_text);
}

#[test]
fn person_regex_span_beats_inner_name_fragment() {
  let result = merge_and_dedup(&[
    entity(DetectionSource::Regex, 0.9, 0, 21, "person"),
    entity(DetectionSource::Trigger, 0.95, 5, 21, "person"),
  ]);

  assert_eq!(result.len(), 1);
  let kept = result.first().expect("result");
  assert_eq!(kept.source, DetectionSource::Regex);
  assert_eq!(kept.start, 0);
  assert_eq!(kept.end, 21);
}

#[test]
fn address_trigger_still_beats_inner_address_regex() {
  let result = merge_and_dedup(&[
    entity(DetectionSource::Trigger, 0.95, 0, 30, "address"),
    entity(DetectionSource::Regex, 0.9, 10, 20, "address"),
  ]);

  assert_eq!(result.len(), 1);
  let kept = result.first().expect("result");
  assert_eq!(kept.source, DetectionSource::Trigger);
  assert_eq!(kept.start, 0);
  assert_eq!(kept.end, 30);
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
fn literal_container_survives_overlapping_shorter_fragment() {
  let result = merge_and_dedup(&[
    entity(DetectionSource::Regex, 0.7, 551, 557, "address"),
    entity(DetectionSource::DenyList, 0.9, 501, 518, "organization"),
    entity(DetectionSource::DenyList, 1.0, 511, 518, "address"),
    entity(DetectionSource::DenyList, 1.0, 543, 550, "address"),
    entity(DetectionSource::DenyList, 1.0, 527, 533, "address"),
    entity(DetectionSource::Trigger, 0.95, 511, 518, "organization"),
    entity(DetectionSource::Trigger, 0.95, 511, 518, "organization"),
    entity(DetectionSource::Trigger, 1.0, 527, 557, "address"),
    entity(DetectionSource::Trigger, 1.0, 527, 557, "address"),
    entity(DetectionSource::Regex, 0.9, 527, 557, "address"),
  ]);

  assert!(
    result
      .iter()
      .any(|entry| entry.source == DetectionSource::DenyList
        && entry.label == "organization"
        && entry.start == 501
        && entry.end == 518),
    "merged entities: {result:?}",
  );
  assert!(
    result
      .iter()
      .all(|entry| !(entry.source == DetectionSource::Trigger
        && entry.label == "organization"
        && entry.start == 511
        && entry.end == 518)),
    "merged entities: {result:?}",
  );
}

#[test]
fn address_component_beats_low_confidence_name_collision() {
  let result = merge_and_dedup(&[
    entity(DetectionSource::DenyList, 0.5, 510, 521, "person"),
    entity(DetectionSource::DenyList, 0.9, 515, 521, "address"),
    entity(DetectionSource::DenyList, 0.9, 523, 531, "address"),
  ]);

  assert!(
    result.iter().any(|entry| entry.label == "address"
      && entry.start == 515
      && entry.end == 521),
    "merged entities: {result:?}",
  );
  assert!(
    result.iter().all(|entry| !(entry.label == "person"
      && entry.start == 510
      && entry.end == 521)),
    "merged entities: {result:?}",
  );
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
fn sanitize_trims_punctuation_and_updates_byte_offsets() {
  let mut input =
    text_entity("\"Tesla Shares\"", "organization", DetectionSource::Ner);
  input.start = 10;
  input.end = 10_u32.saturating_add(byte_len(&input.text));

  let result = sanitize_entities(&[input]);
  assert_eq!(result.len(), 1);
  let entity = result.first().expect("result");
  assert_eq!(entity.text, "Tesla Shares");
  assert_eq!(entity.start, 11);
  assert_eq!(entity.end, 23);
}

#[test]
fn sanitize_trims_leading_date_ellipsis() {
  let mut input = text_entity("...2. 2. 2026", "date", DetectionSource::Regex);
  input.start = 10;
  input.end = 10_u32.saturating_add(byte_len(&input.text));

  let result = sanitize_entities(&[input]);
  assert_eq!(result.len(), 1);
  let entity = result.first().expect("result");
  assert_eq!(entity.text, "2. 2. 2026");
  assert_eq!(entity.start, 13);
}

#[test]
fn sanitize_trims_single_dot_date_filler() {
  let mut input = text_entity(". 2. 2. 2026", "date", DetectionSource::Regex);
  input.start = 10;
  input.end = 10_u32.saturating_add(byte_len(&input.text));

  let result = sanitize_entities(&[input]);
  assert_eq!(result.len(), 1);
  let entity = result.first().expect("result");
  assert_eq!(entity.text, "2. 2. 2026");
  assert_eq!(entity.start, 12);
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
fn sanitize_preserves_single_non_breaking_space() {
  let result = sanitize_entities(&[
    text_entity(
      "Městským soudem v\u{00a0}Praze",
      "organization",
      DetectionSource::Trigger,
    ),
    text_entity("Acme\n  Corp", "organization", DetectionSource::Trigger),
  ]);

  assert_eq!(
    result
      .iter()
      .map(|entry| entry.text.as_str())
      .collect::<Vec<_>>(),
    vec!["Městským soudem v\u{00a0}Praze", "Acme Corp"]
  );
}

#[test]
fn sanitize_keeps_legal_form_periods_from_legal_form_source() {
  let result = sanitize_entities(&[
    text_entity("Acme INC.", "organization", DetectionSource::LegalForm),
    text_entity("Eagles z.s.", "organization", DetectionSource::LegalForm),
    text_entity(
      "Národní agentura s. p.",
      "organization",
      DetectionSource::LegalForm,
    ),
  ]);

  assert_eq!(
    result
      .iter()
      .map(|entry| entry.text.as_str())
      .collect::<Vec<_>>(),
    vec!["Acme INC.", "Eagles z.s.", "Národní agentura s. p."]
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

#[test]
fn boundary_merges_adjacent_same_label_entities() {
  let full_text = "Kontaktujte Jan Novák prosím.";
  let jan_start = byte_len("Kontaktujte ");
  let jan_end = jan_start.saturating_add(byte_len("Jan"));
  let surname_start = jan_end.saturating_add(byte_len(" "));
  let surname_end = surname_start.saturating_add(byte_len("Novák"));
  let result = enforce_boundary_consistency(
    &[
      entity(DetectionSource::Ner, 0.8, jan_start, jan_end, "person"),
      entity(
        DetectionSource::Ner,
        0.95,
        surname_start,
        surname_end,
        "person",
      ),
    ],
    full_text,
  )
  .unwrap();

  assert_eq!(result.len(), 1);
  let person = result.first().expect("person");
  assert_eq!(person.text, "Jan Novák");
  assert_eq!(person.start, jan_start);
  assert_eq!(person.end, surname_end);
  assert_eq!(person.score, 0.95);
}

#[test]
fn boundary_expands_partial_words() {
  let full_text = "Kontaktujte Novák prosím.";
  let start = byte_len("Kontaktujte ");
  let partial_end = start.saturating_add(byte_len("Nová"));
  let result = enforce_boundary_consistency(
    &[PipelineEntity::detected(
      start,
      partial_end,
      "person",
      "Nová",
      0.9,
      DetectionSource::Ner,
    )],
    full_text,
  )
  .unwrap();

  assert_eq!(result.len(), 1);
  let person = result.first().expect("person");
  assert_eq!(person.text, "Novák");
  assert_eq!(person.end, start.saturating_add(byte_len("Novák")));
}

#[test]
fn boundary_expands_inside_apostrophe_names() {
  let full_text = "Kontaktujte O'Connor prosím.";
  let start = byte_len("Kontaktujte O'");
  let end = start.saturating_add(byte_len("Connor"));
  let result = enforce_boundary_consistency(
    &[PipelineEntity::detected(
      start,
      end,
      "person",
      "Connor",
      0.9,
      DetectionSource::Ner,
    )],
    full_text,
  )
  .unwrap();

  assert_eq!(result.len(), 1);
  let person = result.first().expect("person");
  assert_eq!(person.start, byte_len("Kontaktujte "));
  assert_eq!(person.text, "O'Connor");
}

#[test]
fn boundary_expands_across_combining_marks() {
  let full_text = "Podepsal Cafe\u{0301}.";
  let start = byte_len("Podepsal ");
  let end = start.saturating_add(byte_len("Cafe"));
  let result = enforce_boundary_consistency(
    &[PipelineEntity::detected(
      start,
      end,
      "organization",
      "Cafe",
      0.9,
      DetectionSource::Ner,
    )],
    full_text,
  )
  .unwrap();

  assert_eq!(result.len(), 1);
  let organization = result.first().expect("organization");
  assert_eq!(organization.text, "Cafe\u{0301}");
}

#[test]
fn boundary_clamps_expansion_at_cross_label_neighbors() {
  let full_text = "JanPraha";
  let result = enforce_boundary_consistency(
    &[
      entity(DetectionSource::Ner, 0.9, 0, 3, "person"),
      entity(DetectionSource::Ner, 0.8, 3, 8, "address"),
    ],
    full_text,
  )
  .unwrap();

  assert_eq!(result.len(), 2);
  let person = result
    .iter()
    .find(|entry| entry.label == "person")
    .expect("person");
  let address = result
    .iter()
    .find(|entry| entry.label == "address")
    .expect("address");
  assert!(person.end <= address.start);
}

#[test]
fn boundary_resolves_cross_label_partial_overlaps() {
  let full_text = "JanXPraha";
  let result = enforce_boundary_consistency(
    &[
      entity(DetectionSource::Ner, 0.9, 0, 3, "person"),
      entity(DetectionSource::Ner, 0.8, 4, 9, "address"),
    ],
    full_text,
  )
  .unwrap();

  assert_eq!(result.len(), 2);
  let person = result
    .iter()
    .find(|entry| entry.label == "person")
    .expect("person");
  let address = result
    .iter()
    .find(|entry| entry.label == "address")
    .expect("address");
  assert!(person.end <= address.start);
}

#[test]
fn boundary_removes_nested_same_label_entities() {
  let full_text = "Ing. Pavel Novák";
  let result = enforce_boundary_consistency(
    &[
      PipelineEntity::detected(
        0,
        byte_len("Ing. Pavel Novák"),
        "person",
        "Ing. Pavel Novák",
        0.9,
        DetectionSource::Ner,
      ),
      PipelineEntity::detected(
        5,
        10,
        "person",
        "Pavel",
        0.8,
        DetectionSource::Ner,
      ),
    ],
    full_text,
  )
  .unwrap();

  assert_eq!(result.len(), 1);
  assert_eq!(result.first().expect("person").text, "Ing. Pavel Novák");
}

#[test]
fn boundary_does_not_merge_legal_form_orgs_across_comma() {
  let full_text = "Twitter, Inc., X Corp.";
  let result = enforce_boundary_consistency(
    &[
      PipelineEntity::detected(
        0,
        13,
        "organization",
        "Twitter, Inc.",
        0.9,
        DetectionSource::LegalForm,
      ),
      PipelineEntity::detected(
        15,
        22,
        "organization",
        "X Corp.",
        0.8,
        DetectionSource::LegalForm,
      ),
    ],
    full_text,
  )
  .unwrap();

  assert_eq!(
    result
      .iter()
      .map(|entry| entry.text.as_str())
      .collect::<Vec<_>>(),
    vec!["Twitter, Inc.", "X Corp."]
  );
}
