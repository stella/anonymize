#![allow(
  clippy::arithmetic_side_effects,
  clippy::expect_used,
  clippy::indexing_slicing,
  clippy::panic,
  clippy::unwrap_used
)]

//! Gazetteer contracts exercised through the bindings' assembler and real engine.
//! Czech/Slovak morphology is deliberately scoped to synthetic declension
//! fixtures; English short-name probes cover the ordinary-word fuzzy boundary.

#[path = "."]
mod properties {
  #[path = "support/gazetteer.rs"]
  mod gazetteer;
  #[path = "support/gazetteer_fuzz.rs"]
  mod gazetteer_fuzz;
  #[path = "support/gazetteer_policy.rs"]
  mod gazetteer_policy;
  #[path = "support/gazetteer_reference.rs"]
  mod gazetteer_reference;

  use std::collections::{BTreeMap, BTreeSet};
  use std::fmt::Write;
  use std::ops::Range;

  use proptest::prelude::*;
  use proptest::sample;
  use proptest::test_runner::{
    FileFailurePersistence, RngSeed, TestCaseResult, TestRunner,
  };
  use serde::Deserialize;
  use stella_anonymize_core::{OperatorConfig, PreparedEngine};
  use unicode_segmentation::UnicodeSegmentation;

  const PROPERTY_CASES: u32 = 128;

  const SINGLE_ENTRIES: [&str; 6] =
    ["Zy", "Dab", "Luma", "Velomír", "Žilora", "Ľunora"];
  const COMPOUND_NAMES: [&str; 3] = ["Luma", "Bex", "Mivo"];
  const COMPOUND_SUFFIXES: [&str; 5] =
    ["Labs", "s.r.o.", "a.s.", "GmbH", "Ltd"];
  const LEGAL_NAMES: [&str; 2] = ["Luma", "Mivo"];
  const LEGAL_SUFFIXES: [&str; 6] =
    ["s.r.o.", "s. r. o.", "a.s.", "a. s.", "GmbH", "Ltd"];
  const SHORT_ENTRY_COUNT: usize =
    SINGLE_ENTRIES.len() + COMPOUND_NAMES.len() * COMPOUND_SUFFIXES.len();
  const BOUNDARY_SEPARATORS: [&str; 5] = [" ", ", ", "\n", "\u{a0}", "🦀"];

  fn short_entries() -> Vec<String> {
    let mut entries = SINGLE_ENTRIES
      .into_iter()
      .map(str::to_owned)
      .collect::<Vec<_>>();
    for name in COMPOUND_NAMES {
      for suffix in COMPOUND_SUFFIXES {
        entries.push(format!("{name} {suffix}"));
      }
    }
    assert_eq!(
      entries.len(),
      SHORT_ENTRY_COUNT,
      "all declared short entries must expand"
    );
    entries
  }

  fn boundaries(text: &str) -> BTreeSet<usize> {
    let mut boundaries = BTreeSet::from([0, text.len()]);
    for (start, segment) in text.split_word_bound_indices() {
      boundaries.insert(start);
      boundaries.insert(start + segment.len());
    }
    boundaries
  }

  fn spans(engine: &PreparedEngine, text: &str) -> Vec<Range<usize>> {
    engine
      .redact_static_entities(text, &OperatorConfig::default())
      .unwrap()
      .resolved_entities
      .into_iter()
      .map(|entity| {
        usize::try_from(entity.start).unwrap()
          ..usize::try_from(entity.end).unwrap()
      })
      .collect()
  }

  fn detected_spans(engine: &PreparedEngine, text: &str) -> Vec<Range<usize>> {
    engine
      .detect_static_entities(text)
      .unwrap()
      .entities
      .all_entities()
      .into_iter()
      .map(|entity| {
        usize::try_from(entity.start).unwrap()
          ..usize::try_from(entity.end).unwrap()
      })
      .collect()
  }

  const fn disjoint(a: &Range<usize>, b: &Range<usize>) -> bool {
    a.end <= b.start || b.end <= a.start
  }

  fn exact_hit(actual: &[Range<usize>], expected: &Range<usize>) -> bool {
    actual.contains(expected)
      && actual
        .iter()
        .all(|span| disjoint(span, expected) || span == expected)
  }

  fn boundary_fixture(
    entries: &[String],
    separator: &str,
  ) -> (String, Vec<Range<usize>>) {
    let mut text = String::new();
    let mut expected = Vec::new();
    for entry in entries {
      if !text.is_empty() {
        text.push_str(separator);
      }
      write!(text, "archived{separator}").unwrap();
      let start = text.len();
      text.push_str(entry);
      expected.push(start..text.len());
      write!(
        text,
        "{separator}reviewed x{entry}y e\u{301} Ελληνικά Кирилица 界"
      )
      .unwrap();
    }
    (text, expected)
  }

  fn require_boundary_hits(
    actual: &[Range<usize>],
    expected: &[Range<usize>],
  ) -> TestCaseResult {
    for span in expected {
      prop_assert!(
        actual.contains(span),
        "missing exact standalone span: {:?}; actual spans: {:?}",
        span,
        actual
      );
    }
    Ok(())
  }

  // Each envelope contains the entry verbatim; digit substitution also exercises
  // a one-edit near match. UUID/hash probes retain their production-shaped lengths.
  fn opaque_tokens(entry: &str, hex: &str) -> Vec<String> {
    let folded = entry.to_lowercase();
    let mut tokens = vec![
      format!("{hex}{hex}{hex}{hex}"),
      format!(
        "{}-{}-4{}-a{}-{}{}{}",
        hex.get(..8).unwrap(),
        hex.get(..4).unwrap(),
        hex.get(..3).unwrap(),
        hex.get(..3).unwrap(),
        hex.get(..4).unwrap(),
        hex.get(..4).unwrap(),
        hex.get(..4).unwrap()
      ),
      format!("{hex}{hex}{hex}{hex}{hex}{hex}{hex}{hex}"),
      format!("ID{entry}72"),
      format!("ID{}072", entry.chars().skip(1).collect::<String>()),
      format!("https://example.invalid/{hex}-{folded}-{hex}"),
      format!("{hex}-{folded}-{hex}@example.invalid"),
      format!("[record_{hex}_{entry}_{hex}]"),
      format!("⟦record-{entry}-72⟧"),
      format!("record_{hex}_{entry}_{hex}_total"),
    ];
    if folded
      .chars()
      .all(|character| character.is_ascii_hexdigit())
    {
      tokens.push(format!("{hex}{folded}{hex}"));
    }
    tokens
  }

  #[derive(Clone, Debug, Deserialize)]
  struct Inflection {
    canonical: String,
    forms: Vec<String>,
  }

  fn without_diacritics(value: &str) -> String {
    value
      .replace('í', "i")
      .replace('Ž', "Z")
      .replace('ř', "r")
      .replace('Ľ', "L")
  }

  struct RecallCases {
    cases: Vec<(&'static str, String, String)>,
    declared_count: usize,
  }

  fn recall_cases() -> RecallCases {
    let mut cases = Vec::new();
    let mut declared_count = 0;
    for (language, fixture) in [
      ("cs", include_str!("fixtures/gazetteer/cs.json")),
      ("sk", include_str!("fixtures/gazetteer/sk.json")),
    ] {
      let entries = serde_json::from_str::<Vec<Inflection>>(fixture).unwrap();
      declared_count +=
        entries.iter().map(|entry| entry.forms.len()).sum::<usize>() * 3;
      for entry in entries {
        for form in entry.forms {
          cases.push((language, entry.canonical.clone(), form.clone()));
          cases.push((
            language,
            entry.canonical.clone(),
            without_diacritics(&form),
          ));
          cases.push((language, without_diacritics(&entry.canonical), form));
        }
      }
    }
    RecallCases {
      cases,
      declared_count,
    }
  }

  #[derive(Deserialize)]
  struct OrdinaryWords {
    canonical: String,
    words: Vec<String>,
  }

  struct NonMatchCases {
    cases: Vec<(String, String)>,
    declared_count: usize,
  }

  fn non_match_cases() -> NonMatchCases {
    let entries: Vec<OrdinaryWords> =
      serde_json::from_str(include_str!("fixtures/gazetteer/en.json")).unwrap();
    let declared_count = entries.iter().map(|entry| entry.words.len()).sum();
    let cases = entries
      .into_iter()
      .flat_map(|entry| {
        entry
          .words
          .into_iter()
          .map(move |word| (entry.canonical.clone(), word))
      })
      .collect::<Vec<_>>();
    assert_eq!(
      cases.len(),
      declared_count,
      "all declared ordinary-word rows must expand"
    );
    NonMatchCases {
      cases,
      declared_count,
    }
  }

  fn property_runner() -> TestRunner {
    TestRunner::new(ProptestConfig {
      cases: PROPERTY_CASES,
      rng_seed: RngSeed::Fixed(0x6761_7a65_7474_6565),
      source_file: Some(file!()),
      failure_persistence: Some(Box::new(FileFailurePersistence::WithSource(
        "proptest-regressions",
      ))),
      ..ProptestConfig::default()
    })
  }

  #[test]
  fn p1_opaque_tokens_are_preserved() {
    let entries = SINGLE_ENTRIES.map(str::to_owned);
    let prepared = entries
      .iter()
      .map(|entry| {
        (
          entry,
          gazetteer::engine(std::slice::from_ref(entry), "cs").unwrap(),
        )
      })
      .collect::<Vec<_>>();
    property_runner()
      .run(&"a1[a-f0-9]{6}", |hex| {
        let mut exercised = 0;
        for (entry, engine) in &prepared {
          let mut text = format!("{entry} archived ");
          let mut protected = Vec::new();
          for token in opaque_tokens(entry, &hex) {
            let start = text.len();
            text.push_str(&token);
            protected.push(start..text.len());
            write!(text, " reviewed {entry} archived ").unwrap();
          }
          let actual = spans(engine, &text);
          prop_assert!(
            actual.contains(&(0..entry.len())),
            "real hit must exist"
          );
          for span in actual {
            prop_assert!(
              protected.iter().all(|token| disjoint(&span, token)),
              "span overlaps opaque token"
            );
          }
          exercised += 1;
        }
        prop_assert_eq!(exercised, SINGLE_ENTRIES.len());
        Ok(())
      })
      .unwrap();
  }

  // These Latin-name hosts use UAX word boundaries. Numeric glue, underscores,
  // and substring matches in unspaced scripts follow the wider edge contract
  // exercised by the shared fuzz driver and its accepted-neighbour smoke cases.
  #[test]
  fn p2_spaced_latin_names_follow_unicode_word_boundaries() {
    let entries = short_entries();
    let engine = gazetteer::engine(&entries, "cs").unwrap();
    property_runner()
      .run(&sample::select(BOUNDARY_SEPARATORS.to_vec()), |separator| {
        let (text, expected) = boundary_fixture(&entries, separator);
        prop_assert_eq!(expected.len(), SHORT_ENTRY_COUNT);
        let boundaries = boundaries(&text);
        // Detection must recall every standalone entry exactly; resolution
        // separately guarantees that its spans end on Unicode word boundaries.
        require_boundary_hits(&detected_spans(&engine, &text), &expected)?;
        let actual = spans(&engine, &text);
        for span in actual {
          prop_assert!(text.get(span.clone()).is_some());
          prop_assert!(
            boundaries.contains(&span.start) && boundaries.contains(&span.end)
          );
        }
        Ok(())
      })
      .unwrap();
  }

  #[test]
  fn p2_boundary_contract_rejects_dropped_compound_hits() {
    let entries = short_entries();
    let engine = gazetteer::engine(&entries, "cs").unwrap();
    for separator in BOUNDARY_SEPARATORS {
      let (text, expected) = boundary_fixture(&entries, separator);
      let actual = detected_spans(&engine, &text);
      require_boundary_hits(&actual, &expected).unwrap();
      let dropped = actual
        .into_iter()
        .filter(|span| {
          !expected
            .iter()
            .skip(SINGLE_ENTRIES.len())
            .any(|compound| !disjoint(span, compound))
        })
        .collect::<Vec<_>>();
      let boundaries = boundaries(&text);
      assert!(!dropped.is_empty());
      assert!(dropped.iter().all(|span| {
        boundaries.contains(&span.start) && boundaries.contains(&span.end)
      }));
      assert!(require_boundary_hits(&dropped, &expected).is_err());
    }
  }

  #[test]
  fn p3_hits_do_not_swallow_adjacent_words() {
    let entries = short_entries();
    let prepared = entries
      .iter()
      .map(|entry| {
        (
          entry,
          gazetteer::engine(std::slice::from_ref(entry), "cs").unwrap(),
        )
      })
      .collect::<Vec<_>>();
    property_runner()
      .run(
        &(
          sample::select(vec!["archived", "reviewed", "completed"]),
          sample::select(vec!["documents", "yesterday", "carefully"]),
        ),
        |(prefix, next)| {
          let mut exercised = 0;
          for (entry, engine) in &prepared {
            let text = format!("{prefix} {entry} {next} tomorrow");
            let start = prefix.len() + 1;
            prop_assert!(exact_hit(
              &spans(engine, &text),
              &(start..start + entry.len())
            ));
            exercised += 1;
          }
          prop_assert_eq!(exercised, SHORT_ENTRY_COUNT);
          Ok(())
        },
      )
      .unwrap();
  }

  #[test]
  fn p3_only_legal_suffixes_extend_a_hit() {
    let prepared = LEGAL_NAMES
      .into_iter()
      .map(|entry| {
        let canonical = format!("{entry} s.r.o.");
        (entry, gazetteer::engine(&[canonical], "cs").unwrap())
      })
      .collect::<Vec<_>>();
    property_runner()
      .run(
        &sample::select(vec!["documents", "yesterday", "carefully"]),
        |next| {
          let mut exercised = 0;
          for (entry, engine) in &prepared {
            for suffix in LEGAL_SUFFIXES {
              let surface = format!("{entry} {suffix}");
              let text = format!("archived {surface} {next} tomorrow");
              let actual = spans(engine, &text);
              prop_assert!(
                exact_hit(&actual, &(9..9 + surface.len())),
                "actual spans: {:?}",
                actual
              );
              exercised += 1;
            }
          }
          prop_assert_eq!(exercised, LEGAL_NAMES.len() * LEGAL_SUFFIXES.len());
          Ok(())
        },
      )
      .unwrap();
  }

  // Short names have insufficient evidence for unconstrained fuzzy matches.
  // Longer names may accept typos: this property intentionally does not ban them.
  #[test]
  fn p4_short_names_do_not_match_ordinary_neighbours() {
    let matrix = non_match_cases();
    let mut engines = BTreeMap::new();
    for (entry, _) in &matrix.cases {
      engines.entry(entry.clone()).or_insert_with(|| {
        gazetteer::engine(std::slice::from_ref(entry), "en").unwrap()
      });
    }
    let prepared = matrix
      .cases
      .iter()
      .map(|(entry, word)| (entry, word, engines.get(entry).unwrap()))
      .collect::<Vec<_>>();
    property_runner()
      .run(&(0usize..4), |padding| {
        let mut exercised = 0;
        for (entry, word, engine) in &prepared {
          for surface in [(*word).clone(), word.to_uppercase()] {
            let text = format!(
              "{} {surface} {}",
              "archived ".repeat(padding),
              "reviewed ".repeat(padding)
            );
            prop_assert!(
              spans(engine, &text).is_empty(),
              "ordinary-word fixture: {entry}/{surface}"
            );
            exercised += 1;
          }
        }
        prop_assert_eq!(exercised, matrix.declared_count * 2);
        Ok(())
      })
      .unwrap();
  }

  #[test]
  fn p6_redaction_is_stable_and_entry_order_independent() {
    let entries = short_entries();
    let engine = gazetteer::engine(&entries, "cs").unwrap();
    let mut reversed = entries.clone();
    reversed.reverse();
    let reordered_engine = gazetteer::engine(&reversed, "cs").unwrap();
    property_runner()
      .run(
        &sample::select(vec![" reviewed ", " archived ", "\n"]),
        |separator| {
          let mut exercised = 0;
          let mut text = "[ORGANIZATION_72] ".to_owned();
          for entry in &entries {
            write!(text, "{entry}{separator}").unwrap();
            exercised += 1;
          }
          text.push_str("[ORGANIZATION_73]");
          prop_assert_eq!(exercised, SHORT_ENTRY_COUNT);
          let first = engine
            .redact_static_entities(&text, &OperatorConfig::default())
            .unwrap();
          prop_assert!(
            !first.resolved_entities.is_empty(),
            "real hits must exist"
          );
          let second = engine
            .redact_static_entities(
              &first.redaction.redacted_text,
              &OperatorConfig::default(),
            )
            .unwrap();
          prop_assert_eq!(
            &first.redaction.redacted_text,
            &second.redaction.redacted_text
          );
          prop_assert!(
            second.resolved_entities.is_empty(),
            "placeholders must not be detected"
          );
          let reordered = reordered_engine
            .redact_static_entities(&text, &OperatorConfig::default())
            .unwrap();
          prop_assert_eq!(first.redaction, reordered.redaction);
          Ok(())
        },
      )
      .unwrap();
  }

  #[test]
  fn p5_czech_slovak_declensions_and_diacritics_are_exact() {
    let matrix = recall_cases();
    assert_eq!(matrix.cases.len(), matrix.declared_count);
    let mut engines = BTreeMap::new();
    for (language, entry, _) in &matrix.cases {
      engines
        .entry((*language, entry.clone()))
        .or_insert_with(|| {
          gazetteer::engine(std::slice::from_ref(entry), language).unwrap()
        });
    }
    let prepared_cases = matrix
      .cases
      .iter()
      .map(|(language, entry, form)| {
        (form, engines.get(&(*language, entry.clone())).unwrap())
      })
      .collect::<Vec<_>>();
    let mut runner = property_runner();
    runner
      .run(&sample::select(vec!["", "archived ", "🦀 "]), |left| {
        let mut exercised = 0;
        for (form, engine) in &prepared_cases {
          let text = format!("{left}{form} reviewed");
          prop_assert!(exact_hit(
            &spans(engine, &text),
            &(left.len()..left.len() + form.len())
          ));
          exercised += 1;
        }
        prop_assert_eq!(exercised, matrix.declared_count);
        Ok(())
      })
      .unwrap();
  }

  // Independent wrong implementations are witnesses, never the production matcher.
  fn substring_matcher(text: &str, entry: &str) -> Vec<Range<usize>> {
    text
      .match_indices(entry)
      .map(|(start, value)| start..start + value.len())
      .collect()
  }

  fn edit_distance(left: &str, right: &str) -> usize {
    let right_chars = right.chars().collect::<Vec<_>>();
    let mut previous = (0..=right_chars.len()).collect::<Vec<_>>();
    for (row, left_char) in left.chars().enumerate() {
      let mut current = vec![row + 1];
      for (column, right_char) in right_chars.iter().enumerate() {
        current.push(
          (previous[column + 1] + 1)
            .min(current[column] + 1)
            .min(previous[column] + usize::from(left_char != *right_char)),
        );
      }
      previous = current;
    }
    *previous.last().unwrap()
  }

  #[test]
  fn property_oracles_reject_wrong_matchers() {
    // P1/P2: substring matching cuts a production-shaped identifier.
    let identifier_text = "IDLuma72";
    let identifier_spans = substring_matcher(identifier_text, "Luma");
    assert!(!identifier_spans.is_empty());
    assert!(
      !identifier_spans
        .iter()
        .all(|span| disjoint(span, &(0..identifier_text.len())))
    );
    assert!(!identifier_spans.iter().all(|span| {
      let boundaries = boundaries(identifier_text);
      boundaries.contains(&span.start) && boundaries.contains(&span.end)
    }));

    // P3: a matcher growing through the next word fails exact span recall.
    let adjacent_text = "archived Luma documents";
    let adjacent_spans = substring_matcher(adjacent_text, "Luma")
      .into_iter()
      .map(|span| span.start..adjacent_text.len())
      .collect::<Vec<_>>();
    assert!(!exact_hit(&adjacent_spans, &(9..13)));

    // P4: unconstrained edit matching must reject the actual ordinary vocabulary.
    let vocabulary: Vec<OrdinaryWords> =
      serde_json::from_str(include_str!("fixtures/gazetteer/en.json")).unwrap();
    for entry in vocabulary {
      for word in entry.words {
        let distance = edit_distance(&entry.canonical.to_lowercase(), &word);
        assert!(
          (1..=2).contains(&distance),
          "probe must be a real near match"
        );
        let fuzzy_spans = if distance <= 2 {
          std::iter::once(0..word.len()).collect::<Vec<_>>()
        } else {
          vec![]
        };
        assert!(
          !fuzzy_spans.is_empty(),
          "the no-hit oracle rejects unbounded fuzzy matching"
        );
      }
    }

    // P5: exact-only matching fails synthetic inflection recall.
    let inflected_text = "Velomírovi";
    let exact_only_spans = substring_matcher(inflected_text, "Velomír");
    assert!(!exact_hit(&exact_only_spans, &(0..inflected_text.len())));

    // P6: repeated substring redaction corrupts its own placeholder.
    let wrong_redact = |source: &str| source.replace("Luma", "[Luma_1]");
    let first = wrong_redact("Luma");
    assert_ne!(first, wrong_redact(&first));
    let ordered_redact = |entries: &[&str]| {
      entries
        .iter()
        .fold("Luma Labs".to_owned(), |redacted, entry| {
          redacted.replace(entry, "[ORGANIZATION_1]")
        })
    };
    assert_ne!(
      ordered_redact(&["Luma", "Luma Labs"]),
      ordered_redact(&["Luma Labs", "Luma"])
    );
  }

  #[test]
  fn fuzz_oracle_handles_marker_fragment_entries_and_numeric_glue() {
    gazetteer_fuzz::exercise("⟦dead\na\nb\nc\n⟦dead⟧".as_bytes());
    gazetteer_fuzz::exercise(b"a\nb\nc\nd\ndead1234-a1b2 a1b2-1234dead");
  }

  #[test]
  fn fuzz_oracle_accepts_normalized_full_identifier_matches() {
    for canonical in ["A1B2-dead-c3d4", "A1B2‐dead‐c3d4"] {
      let entries =
        [canonical, "a", "b", "c", "dead", "NeutralFixture"].map(str::to_owned);
      let engine = gazetteer::engine(&entries, "cs").unwrap();
      let text = "a1b2-dead-c3d4";
      let detected = engine.detect_static_entities(text).unwrap();
      assert!(
        detected.entities.all_entities().iter().any(|entity| {
          entity.start == 0
            && usize::try_from(entity.end).unwrap() == text.len()
        }),
        "normalized full identifier must retain exact detection recall"
      );
    }
    gazetteer_fuzz::exercise(b"A1B2-dead-c3d4\na\nb\nc\n");
    gazetteer_fuzz::exercise("A1B2‐dead‐c3d4\na\nb\nc\n".as_bytes());
  }

  #[test]
  fn fuzz_oracle_accepts_non_joined_identifier_segment_matches() {
    let entries =
      ["a1b2", "b", "c", "d", "dead", "NeutralFixture"].map(str::to_owned);
    let engine = gazetteer::engine(&entries, "cs").unwrap();
    for text in [
      "a1b2-dead-c3d4",
      "https://example.test/path/a1b2-dead-c3d4/end",
      "neutral+a1b2-dead-c3d4@example.test",
      "prefix_a1b2-dead-c3d4_suffix",
      "[a1b2-dead-c3d4]",
    ] {
      let start = text.find("a1b2").unwrap();
      let detected = engine.detect_static_entities(text).unwrap();
      assert!(
        detected.entities.all_entities().iter().any(|entity| {
          usize::try_from(entity.start).unwrap() == start
            && usize::try_from(entity.end).unwrap() == start + "a1b2".len()
        }),
        "non-joined identifier segment must retain exact detection recall"
      );
    }
    assert!(
      engine
        .detect_static_entities("⟦a1b2-dead-c3d4⟧")
        .unwrap()
        .entities
        .all_entities()
        .is_empty()
    );
    gazetteer_fuzz::exercise(b"a1b2\nb\nc\nd\n");
  }

  #[test]
  fn fuzz_oracle_accepts_unclosed_outer_marker() {
    let engine = gazetteer::engine(&["dead".to_owned()], "cs").unwrap();
    let detected = engine.detect_static_entities("⟦⟦dead⟧").unwrap();
    assert!(
      detected
        .entities
        .all_entities()
        .iter()
        .any(|entity| { entity.start == 6 && entity.end == 10 })
    );
    gazetteer_fuzz::exercise("a\nb\nc\nd\n⟦⟦dead⟧".as_bytes());
  }

  #[test]
  fn fuzz_oracle_accepts_arabic_end_of_ayah_boundary() {
    let engine = gazetteer::engine(&["a".to_owned()], "cs").unwrap();
    let detected = engine.detect_static_entities("a\u{06dd}").unwrap();
    assert!(
      detected
        .entities
        .all_entities()
        .iter()
        .any(|entity| { entity.start == 0 && entity.end == 1 })
    );
    gazetteer_fuzz::exercise("a\nb\nc\nd\na\u{06dd}".as_bytes());
  }

  proptest! {
    #![proptest_config(ProptestConfig {
      cases: PROPERTY_CASES,
      rng_seed: RngSeed::Fixed(0x532),
      ..ProptestConfig::default()
    })]

    #[test]
    fn candidate_policy_matches_independent_reference(
      chars in prop::collection::vec(
        prop_oneof![
          any::<char>(),
          sample::select(vec!['a', '1', 'B', '-', '_', '⟦', '⟧', ' ' , '\u{301}', '界']),
        ],
        0..64,
      ),
      first in any::<usize>(),
      second in any::<usize>(),
    ) {
      let text = chars.into_iter().collect::<String>();
      let mut offsets = text.char_indices().map(|(offset, _)| offset).collect::<Vec<_>>();
      offsets.push(text.len());
      let a = offsets[first % offsets.len()];
      let b = offsets[second % offsets.len()];
      let start = a.min(b);
      let end = a.max(b);
      let policy = gazetteer_policy::CandidatePolicy::new(&text);
      prop_assert_eq!(
        (policy.edges_are_free(start, end), policy.in_identifier(start, end)),
        gazetteer_reference::acceptance(&text, start..end)
      );
    }
  }

  #[test]
  fn independent_reference_covers_policy_contract_classes() {
    for text in [
      "123Luma456",
      "xLuma",
      "Luma0a1b",
      "Luma.letters",
      "a1b2-dead-c3d4",
      "a1b-dead-1234",
      "QWNtZUEvb3J1-dead",
      "QWNtZUEvb3J-dead",
      "dead_0000",
      "dead/2024",
      "dead++a1b2",
      "⟦dead⟧",
      "⟦⟦dead⟧⟧",
      "⟦⟦dead⟧",
      "⟦dead ⟧",
      "⟧dead⟦",
      "⟦a⟧⟦dead⟧",
      "e\u{301}Luma",
      "Luma\u{903}",
      "a\u{06dd}",
      "界Luma界",
      "ไทยLuma",
      "Luma🦀",
      "[[Zeta2024]]",
      "<<token:zeta9>>",
      "{{acme_01}}",
      "[[Jan Novák]]",
      "[[⟦dead⟧]]",
      "<<{{dead9}}>>",
      "[[dead9\n]]",
      "<<[[dead9>>]]",
      "[[dead9]] [[Luma]]",
    ] {
      let policy = gazetteer_policy::CandidatePolicy::new(text);
      let mut offsets = text
        .char_indices()
        .map(|(offset, _)| offset)
        .collect::<Vec<_>>();
      offsets.push(text.len());
      for &start in &offsets {
        for &end in offsets.iter().filter(|&&end| end >= start) {
          assert_eq!(
            (
              policy.edges_are_free(start, end),
              policy.in_identifier(start, end)
            ),
            gazetteer_reference::acceptance(text, start..end),
            "contract reference differs at {start}..{end}"
          );
        }
      }
    }
  }

  #[test]
  fn independent_reference_rejects_policy_mutations() {
    // Moving the left edge one byte outward admits the otherwise split word.
    let edge_text = "xLuma";
    let edge_policy = gazetteer_policy::CandidatePolicy::new(edge_text);
    let reference = gazetteer_reference::acceptance(edge_text, 1..5);
    assert_eq!(
      (
        edge_policy.edges_are_free(1, 5),
        edge_policy.in_identifier(1, 5)
      ),
      reference
    );
    assert_ne!(
      (
        edge_policy.edges_are_free(0, 5),
        edge_policy.in_identifier(1, 5)
      ),
      reference
    );

    // Omitting the identifier predicate admits an edge-valid protected seed.
    let identifier_text = "a1b2-dead-c3d4";
    let identifier_policy =
      gazetteer_policy::CandidatePolicy::new(identifier_text);
    let identifier_reference =
      gazetteer_reference::acceptance(identifier_text, 5..9);
    assert_eq!(
      (
        identifier_policy.edges_are_free(5, 9),
        identifier_policy.in_identifier(5, 9)
      ),
      identifier_reference
    );
    assert_ne!(
      (identifier_policy.edges_are_free(5, 9), false),
      identifier_reference
    );
  }

  // The stable harness compiles and exercises the same bounded driver as libFuzzer.
  #[test]
  fn fuzz_driver_exercises_identifiers_and_accepted_neighbours() {
    for input in [
    b"".as_slice(),
    b"Luma\nZy\nDab\nMivo\nhttps://luma.example Luma/2024 1234Luma5678 [record-Luma-01] record_Luma_01".as_slice(),
    "Žilora\nĽunora\nVelomír\nMivo\nŽilora Ελληνικά Кирилица 界 🦀 e\u{301} ⟦record-Žilora-72⟧".as_bytes(),
    &[0xff, 0xfe, b'\n', 0, b'\n', b'a', b'\n', b'z', b'\n', 0x80],
  ] {
    gazetteer_fuzz::exercise(input);
  }
    let engine = gazetteer::engine(&["Luma".to_owned()], "cs").unwrap();
    let text = "https://Luma.example Luma/2024 1234Luma5678 [record-Luma-01] record_Luma_01";
    let actual = engine
      .detect_static_entities(text)
      .unwrap()
      .entities
      .all_entities()
      .into_iter()
      .map(|entity| {
        usize::try_from(entity.start).unwrap()
          ..usize::try_from(entity.end).unwrap()
      })
      .collect::<Vec<_>>();
    for (start, name) in text.match_indices("Luma") {
      assert!(
        exact_hit(&actual, &(start..start + name.len())),
        "accepted neighbour must retain exact detection recall: {actual:?} at {start}"
      );
    }
  }
}
