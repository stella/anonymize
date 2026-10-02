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

  use std::collections::{BTreeMap, BTreeSet};
  use std::fmt::Write;
  use std::ops::Range;

  use proptest::prelude::*;
  use proptest::sample;
  use proptest::test_runner::{FileFailurePersistence, RngSeed, TestRunner};
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

  const fn disjoint(a: &Range<usize>, b: &Range<usize>) -> bool {
    a.end <= b.start || b.end <= a.start
  }

  fn exact_hit(actual: &[Range<usize>], expected: &Range<usize>) -> bool {
    actual.contains(expected)
      && actual
        .iter()
        .all(|span| disjoint(span, expected) || span == expected)
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
    property_runner_with(PROPERTY_CASES)
  }

  fn property_runner_with(cases: u32) -> TestRunner {
    TestRunner::new(ProptestConfig {
      cases,
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
    property_runner().run(&sample::select(vec![" ", ", ", "\n", "\u{a0}", "🦀"]), |separator| {
      let mut exercised = 0;
      let text = entries.iter().map(|entry| {
        exercised += 1;
        format!("archived{separator}{entry}{separator}reviewed x{entry}y e\u{301} Ελληνικά Кирилица 界")
      })
        .collect::<Vec<_>>().join(separator);
      prop_assert_eq!(exercised, SHORT_ENTRY_COUNT);
      let boundaries = boundaries(&text);
      let actual = spans(&engine, &text);
      prop_assert!(!actual.is_empty(), "real hits must exist");
      for span in actual {
        prop_assert!(text.get(span.clone()).is_some());
        prop_assert!(boundaries.contains(&span.start) && boundaries.contains(&span.end));
      }
      Ok(())
    }).unwrap();
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

  // Spellings repeat under different labels on purpose: a later entry for a
  // spelling must never take coverage away under a label filter.
  const COVERAGE_POOL: [(&str, &str); 17] = [
    ("Luma", "organization"),
    ("Luma", "person"),
    ("LUMA", "location"),
    ("Žilóra", "person"),
    ("Luma Labs", "organization"),
    ("Luma s.r.o.", "organization"),
    ("Mivo", "person"),
    ("Novák", "person"),
    ("Novák", "organization"),
    ("Jan Novák", "person"),
    ("Jan Novák", "organization"),
    ("Velomír", "person"),
    ("Wintermute", "person"),
    ("Orbis", "organization"),
    ("Žilora", "location"),
    ("Bex GmbH", "organization"),
    ("Zy", "person"),
  ];
  const COVERAGE_LABELS: [&[&str]; 4] = [
    &[],
    &["organization"],
    &["person"],
    &["person", "organization"],
  ];
  const COVERAGE_TEXT: &str = "Luma Labs a Luma s.r.o. podepsaly. Jan Novák, \
    Novákovi a Nováka zastoupil Velomír. Wintermte a Orbys, Orbis Ltd. \
    Bex GmbH 2024 a Zy. Podpis: Novák, Jan. Žilory archived ⟦record-Luma-01⟧ id 9b1d0c3e-luma-4c1b.";
  /// Chains a pull request runs; the release-mode variant runs many more.
  const COVERAGE_CHAINS: u32 = 2;
  const COVERAGE_CHAINS_RELEASE: u32 = 24;

  /// Resolved `(start, end, label)` spans of the pool rows in `rows`.
  fn labelled_spans(
    rows: &[usize],
    labels: &[&str],
  ) -> BTreeSet<(usize, usize, String)> {
    if rows.is_empty() {
      return BTreeSet::new();
    }
    let entries = rows
      .iter()
      .map(|row| {
        let (canonical, label) = COVERAGE_POOL[*row];
        (canonical.to_owned(), label.to_owned())
      })
      .collect::<Vec<_>>();
    let labels = labels
      .iter()
      .map(|label| (*label).to_owned())
      .collect::<Vec<_>>();
    let engine = gazetteer::labelled_engine(gazetteer::LabelledEngine {
      entries: &entries,
      language: "cs",
      labels: &labels,
    })
    .unwrap();
    engine
      .redact_static_entities(COVERAGE_TEXT, &OperatorConfig::default())
      .unwrap()
      .resolved_entities
      .into_iter()
      .map(|entity| {
        (
          usize::try_from(entity.start).unwrap(),
          usize::try_from(entity.end).unwrap(),
          entity.label,
        )
      })
      .collect()
  }

  /// Byte offsets of the letters and digits the spans cover. Separators are
  /// left out: merging two adjacent names may cover the `, ` between them,
  /// and a longer entry may resolve the same names without it.
  fn covered(spans: &BTreeSet<(usize, usize, String)>) -> BTreeSet<usize> {
    spans
      .iter()
      .flat_map(|(start, end, _)| {
        COVERAGE_TEXT
          .get(*start..*end)
          .unwrap()
          .char_indices()
          .filter(|(_, character)| character.is_alphanumeric())
          .map(move |(offset, _)| start + offset)
      })
      .collect()
  }

  /// Adds the pool rows one at a time in a random order, under every label
  /// filter: no step may uncover a letter or digit, and the full pool resolves
  /// the same whatever the order. One engine per step keeps a chain cheap.
  fn assert_coverage_grows(chains: u32) {
    let everything = (0..COVERAGE_POOL.len()).collect::<Vec<_>>();
    let references = COVERAGE_LABELS
      .iter()
      .map(|labels| labelled_spans(&everything, labels))
      .collect::<Vec<_>>();
    assert!(
      references.iter().all(|spans| !spans.is_empty()),
      "real hits must exist"
    );
    property_runner_with(chains)
      .run(&Just(everything).prop_shuffle(), |order| {
        let mut exercised = 0;
        for (labels, reference) in COVERAGE_LABELS.iter().zip(&references) {
          let mut previous = BTreeSet::new();
          for added in 1..=order.len() {
            let spans = labelled_spans(&order[..added], labels);
            let now = covered(&spans);
            prop_assert!(
              previous.is_subset(&now),
              "adding {:?} under {labels:?} uncovered bytes {:?}",
              COVERAGE_POOL[order[added - 1]],
              previous.difference(&now).collect::<Vec<_>>()
            );
            if added == order.len() {
              prop_assert_eq!(&spans, reference);
            }
            previous = now;
          }
          exercised += 1;
        }
        prop_assert_eq!(exercised, COVERAGE_LABELS.len());
        Ok(())
      })
      .unwrap();
  }

  #[test]
  fn p7_adding_entries_never_reduces_coverage() {
    assert_coverage_grows(COVERAGE_CHAINS);
  }

  #[test]
  #[ignore = "release-mode coverage monotonicity over many entry orders"]
  fn p7_adding_entries_never_reduces_coverage_in_many_orders() {
    assert_coverage_grows(COVERAGE_CHAINS_RELEASE);
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
