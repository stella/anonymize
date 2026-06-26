#![allow(
  clippy::arithmetic_side_effects,
  clippy::expect_used,
  clippy::indexing_slicing,
  clippy::panic,
  clippy::unwrap_used
)]

use proptest::prelude::{ProptestConfig, Strategy, any};
use proptest::{collection, prop_assert, prop_assert_eq, proptest, sample};
use stella_anonymize_core::{
  DetectionSource, Entity, Error, LiteralSearchOptions, OperatorConfig,
  PipelineEntity, SearchIndex, SearchMatch, SearchOptions, SearchPattern,
  deanonymise, merge_and_dedup, redact_text, sanitize_entities,
};

const PROPERTY_CASES: u32 = 128;

fn byte_len(text: &str) -> u32 {
  u32::try_from(text.len()).unwrap_or(u32::MAX)
}

fn text_char() -> impl Strategy<Value = char> {
  sample::select(vec![
    'a', 'b', 'Z', '0', '9', ' ', '-', '.', ',', ':', '\u{00a0}', 'á', 'ř',
    '界', '🦀', '\u{0301}',
  ])
}

fn search_char() -> impl Strategy<Value = char> {
  sample::select(vec!['a', 'b', 'Z', '0', '9', 'á', 'ř', '界', '🦀'])
}

fn text_fragment(max_len: usize) -> impl Strategy<Value = String> {
  collection::vec(text_char(), 0..max_len)
    .prop_map(|chars| chars.into_iter().collect())
}

fn entity_text() -> impl Strategy<Value = String> {
  collection::vec(search_char(), 1..8)
    .prop_map(|chars| chars.into_iter().collect())
}

fn trim_text() -> impl Strategy<Value = String> {
  collection::vec(
    sample::select(vec![
      ' ', '\t', '\n', ',', ';', ':', '"', '\'', '“', '”', '‘', '’', '«', '»',
      '!', '?',
    ]),
    0..6,
  )
  .prop_map(|chars| chars.into_iter().collect())
}

fn source_strategy() -> impl Strategy<Value = DetectionSource> {
  sample::select(vec![
    DetectionSource::Trigger,
    DetectionSource::Regex,
    DetectionSource::DenyList,
    DetectionSource::LegalForm,
    DetectionSource::Gazetteer,
    DetectionSource::Country,
    DetectionSource::Ner,
    DetectionSource::Coreference,
  ])
}

fn label_strategy() -> impl Strategy<Value = &'static str> {
  sample::select(vec![
    "person",
    "organization",
    "address",
    "date",
    "registration number",
  ])
}

fn redaction_case() -> impl Strategy<Value = (String, Vec<Entity>)> {
  collection::vec((text_fragment(8), entity_text()), 1..8).prop_map(
    |segments| {
      let mut text = String::new();
      let mut entities = Vec::new();

      for (index, (prefix, value)) in segments.into_iter().enumerate() {
        text.push_str(&prefix);
        let start = byte_len(&text);
        text.push_str(&value);
        let end = byte_len(&text);
        entities.push(Entity::detected(
          start,
          end,
          format!("generated label {index}"),
          value,
        ));
      }
      text.push_str(" tail");

      (text, entities)
    },
  )
}

fn pipeline_entity_strategy() -> impl Strategy<Value = PipelineEntity> {
  (
    0_u32..80,
    1_u32..24,
    label_strategy(),
    source_strategy(),
    0.0_f64..1.0,
  )
    .prop_map(|(start, len, label, source, score)| {
      let end = start.saturating_add(len);
      PipelineEntity::detected(
        start,
        end,
        label,
        "x".repeat(usize::try_from(len).unwrap_or(0)),
        score,
        source,
      )
    })
}

proptest! {
  #![proptest_config(ProptestConfig {
    cases: PROPERTY_CASES,
    ..ProptestConfig::default()
  })]

  #[test]
  fn generated_redactions_round_trip_on_utf8_boundaries(
    (text, entities) in redaction_case(),
  ) {
    let result = redact_text(&text, &entities, &OperatorConfig::default())
      .unwrap();

    prop_assert_eq!(result.entity_count, entities.len());
    let restored = deanonymise(&result.redacted_text, &result.redaction_map);
    prop_assert_eq!(restored.as_str(), text.as_str());
    for entry in &result.redaction_map {
      prop_assert!(!text.contains(&entry.placeholder));
    }
  }

  #[test]
  fn invalid_interior_utf8_offsets_are_rejected(
    ch in any::<char>().prop_filter(
      "multi-byte scalar",
      |candidate| candidate.len_utf8() > 1,
    ),
  ) {
    let text = format!("a{ch}z");
    let end = 1_u32.saturating_add(
      u32::try_from(ch.len_utf8()).unwrap_or(u32::MAX),
    );
    let entities = vec![Entity::detected(2, end, "person", ch.to_string())];

    let error = redact_text(&text, &entities, &OperatorConfig::default())
      .unwrap_err();

    prop_assert_eq!(error, Error::ByteOffsetInsideCodepoint { offset: 2 });
  }

  #[test]
  fn merge_and_dedup_never_leaves_partial_overlaps(
    entities in collection::vec(pipeline_entity_strategy(), 0..32),
  ) {
    let result = merge_and_dedup(&entities);

    for entity in &result {
      prop_assert!(entity.start < entity.end);
    }

    for pair in result.windows(2) {
      let left = &pair[0];
      let right = &pair[1];
      prop_assert!(left.start <= right.start);
    }

    for (index, left) in result.iter().enumerate() {
      for right in result.iter().skip(index.saturating_add(1)) {
        let overlaps = left.end > right.start && left.start < right.end;
        let same_span = left.start == right.start && left.end == right.end;
        prop_assert!(
          !overlaps || same_span,
          "partial overlap survived: {left:?} / {right:?}",
        );
      }
    }
  }

  #[test]
  fn sanitize_entities_keeps_trimmed_spans_inside_original_span(
    leading in trim_text(),
    core in entity_text(),
    trailing in trim_text(),
    label in label_strategy(),
    base_start in 0_u32..20,
  ) {
    let raw = format!("{leading}{core}{trailing}");
    let original = PipelineEntity::detected(
      base_start,
      base_start.saturating_add(byte_len(&raw)),
      label,
      raw,
      0.5,
      DetectionSource::Ner,
    );

    let result = sanitize_entities(std::slice::from_ref(&original));

    for entity in &result {
      prop_assert!(entity.start >= original.start);
      prop_assert!(entity.end <= original.end);
      prop_assert!(entity.start < entity.end);
      prop_assert!(entity.text.chars().any(char::is_alphanumeric));
      prop_assert_eq!(entity.text.trim(), entity.text.as_str());
    }
  }

  #[test]
  fn literal_search_matches_are_valid_utf8_slices(
    prefix in text_fragment(12),
    needle in entity_text(),
    suffix in text_fragment(12),
  ) {
    let haystack = format!("{prefix}{needle}{suffix}");
    let expected_start = byte_len(&prefix);
    let expected_end = expected_start.saturating_add(byte_len(&needle));
    let index = SearchIndex::new(
      vec![SearchPattern::Literal(needle.clone())],
      SearchOptions {
        literal: LiteralSearchOptions {
          case_insensitive: false,
          whole_words: false,
        },
        ..SearchOptions::default()
      },
    )
    .unwrap();

    let matches = index.find_iter(&haystack).unwrap();

    let includes_expected = matches.iter().any(|found| matches!(
      found,
      SearchMatch::Literal { pattern: 0, start, end }
        if *start == expected_start && *end == expected_end
    ));
    prop_assert!(includes_expected);
    for found in matches {
      let SearchMatch::Literal { start, end, .. } = found else {
        continue;
      };
      let start = usize::try_from(start).unwrap();
      let end = usize::try_from(end).unwrap();
      let Some(slice) = haystack.get(start..end) else {
        prop_assert!(false, "literal match was not a valid UTF-8 slice");
        continue;
      };
      prop_assert_eq!(slice, needle.as_str());
    }
  }
}
