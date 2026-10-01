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

  use std::collections::BTreeSet;
  use std::fmt::Write;
  use std::ops::Range;

  use proptest::prelude::*;
  use proptest::test_runner::{FileFailurePersistence, RngSeed};
  use proptest::{collection, sample};
  use serde::Deserialize;
  use stella_anonymize_core::{OperatorConfig, PreparedEngine};
  use unicode_segmentation::UnicodeSegmentation;

  const PROPERTY_CASES: u32 = 128;

  fn short_entry() -> impl Strategy<Value = String> {
    prop_oneof![
      sample::select(vec!["Zy", "Dab", "Luma", "Velomír", "Žilora", "Ľunora"])
        .prop_map(str::to_owned),
      (
        sample::select(vec!["Luma", "Bex", "Mivo"]),
        sample::select(vec!["Labs", "s.r.o.", "a.s.", "GmbH", "Ltd"])
      )
        .prop_map(|(name, suffix)| format!("{name} {suffix}")),
    ]
  }

  fn single_entry() -> impl Strategy<Value = String> {
    sample::select(vec!["Zy", "Dab", "Luma", "Velomír", "Žilora", "Ľunora"])
      .prop_map(str::to_owned)
  }

  fn deny_list() -> impl Strategy<Value = Vec<String>> {
    collection::btree_set(short_entry(), 1..5)
      .prop_map(|entries| entries.into_iter().collect())
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

  fn recall_case() -> impl Strategy<Value = (&'static str, String, String)> {
    let mut cases = Vec::new();
    for (language, fixture) in [
      ("cs", include_str!("fixtures/gazetteer/cs.json")),
      ("sk", include_str!("fixtures/gazetteer/sk.json")),
    ] {
      for entry in serde_json::from_str::<Vec<Inflection>>(fixture).unwrap() {
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
    sample::select(cases)
  }

  #[derive(Deserialize)]
  struct OrdinaryWords {
    canonical: String,
    words: Vec<String>,
  }

  fn non_match_case() -> impl Strategy<Value = (String, String)> {
    let entries: Vec<OrdinaryWords> =
      serde_json::from_str(include_str!("fixtures/gazetteer/en.json")).unwrap();
    let pairs = entries
      .into_iter()
      .flat_map(|entry| {
        entry
          .words
          .into_iter()
          .map(move |word| (entry.canonical.clone(), word))
      })
      .collect::<Vec<_>>();
    (sample::select(pairs), any::<bool>()).prop_map(|((entry, word), upper)| {
      (entry, if upper { word.to_uppercase() } else { word })
    })
  }

  proptest! {
    #![proptest_config(ProptestConfig {
      cases: PROPERTY_CASES,
      rng_seed: RngSeed::Fixed(0x6761_7a65_7474_6565),
      failure_persistence: Some(Box::new(FileFailurePersistence::WithSource("proptest-regressions"))),
      ..ProptestConfig::default()
    })]

    #[test]
    fn p1_opaque_tokens_are_preserved(entry in single_entry(), hex in "a1[a-f0-9]{6}") {
      let engine = gazetteer::engine(std::slice::from_ref(&entry), "cs").unwrap();
      let mut text = format!("{entry} archived ");
      let mut protected = Vec::new();
      for token in opaque_tokens(&entry, &hex) {
        let start = text.len();
        text.push_str(&token);
        protected.push(start..text.len());
        write!(text, " reviewed {entry} archived ").unwrap();
      }
      let actual = spans(&engine, &text);
      prop_assert!(actual.contains(&(0..entry.len())), "real hit must exist");
      for span in actual {
        prop_assert!(protected.iter().all(|token| disjoint(&span, token)), "span overlaps opaque token");
      }
    }

    // These Latin-name hosts use UAX word boundaries. Numeric glue, underscores,
    // and substring matches in unspaced scripts follow the wider edge contract
    // exercised by the shared fuzz driver and its accepted-neighbour smoke cases.
    #[test]
    fn p2_spaced_latin_names_follow_unicode_word_boundaries(entries in deny_list(), separator in sample::select(vec![" ", ", ", "\n", "\u{a0}", "🦀"])) {
      let engine = gazetteer::engine(&entries, "cs").unwrap();
      let text = entries.iter().map(|entry| format!("archived{separator}{entry}{separator}reviewed x{entry}y e\u{301} Ελληνικά Кирилица 界"))
        .collect::<Vec<_>>().join(separator);
      let boundaries = boundaries(&text);
      let actual = spans(&engine, &text);
      prop_assert!(!actual.is_empty(), "real hits must exist");
      for span in actual {
        prop_assert!(text.get(span.clone()).is_some());
        prop_assert!(boundaries.contains(&span.start) && boundaries.contains(&span.end));
      }
    }

    #[test]
    fn p3_hits_do_not_swallow_adjacent_words(entry in short_entry(), prefix in sample::select(vec!["archived", "reviewed", "completed"]), next in sample::select(vec!["documents", "yesterday", "carefully"])) {
      let engine = gazetteer::engine(std::slice::from_ref(&entry), "cs").unwrap();
      let text = format!("{prefix} {entry} {next} tomorrow");
      let start = prefix.len() + 1;
      prop_assert!(exact_hit(&spans(&engine, &text), &(start..start + entry.len())));
    }

    #[test]
    fn p3_only_legal_suffixes_extend_a_hit(
      entry in sample::select(vec!["Luma", "Mivo"]),
      suffix in sample::select(vec!["s.r.o.", "s. r. o.", "a.s.", "a. s.", "GmbH", "Ltd"]),
      next in sample::select(vec!["documents", "yesterday", "carefully"]),
    ) {
      let canonical = format!("{entry} s.r.o.");
      let engine = gazetteer::engine(&[canonical], "cs").unwrap();
      let surface = format!("{entry} {suffix}");
      let text = format!("archived {surface} {next} tomorrow");
      let actual = spans(&engine, &text);
      prop_assert!(exact_hit(&actual, &(9..9 + surface.len())), "actual spans: {:?}", actual);
    }

    // Short names have insufficient evidence for unconstrained fuzzy matches.
    // Longer names may accept typos: this property intentionally does not ban them.
    #[test]
    fn p4_short_names_do_not_match_ordinary_neighbours((entry, word) in non_match_case(), padding in 0usize..4) {
      let engine = gazetteer::engine(&[entry], "en").unwrap();
      let text = format!("{} {word} {}", "archived ".repeat(padding), "reviewed ".repeat(padding));
      prop_assert!(spans(&engine, &text).is_empty());
    }

    #[test]
    fn p5_czech_slovak_declensions_and_diacritics_are_exact((language, entry, form) in recall_case(), left in sample::select(vec!["", "archived ", "🦀 "])) {
      let engine = gazetteer::engine(&[entry], language).unwrap();
      let text = format!("{left}{form} reviewed");
      prop_assert!(exact_hit(&spans(&engine, &text), &(left.len()..left.len() + form.len())));
    }

    #[test]
    fn p6_redaction_is_stable_and_entry_order_independent(entries in deny_list()) {
      let text = format!("[ORGANIZATION_72] {} [ORGANIZATION_73]", entries.join(" reviewed "));
      let engine = gazetteer::engine(&entries, "cs").unwrap();
      let first = engine.redact_static_entities(&text, &OperatorConfig::default()).unwrap();
      prop_assert!(!first.resolved_entities.is_empty(), "real hits must exist");
      let second = engine.redact_static_entities(&first.redaction.redacted_text, &OperatorConfig::default()).unwrap();
      prop_assert_eq!(&first.redaction.redacted_text, &second.redaction.redacted_text);
      prop_assert!(second.resolved_entities.is_empty(), "placeholders must not be detected");
      let mut reversed = entries;
      reversed.reverse();
      let reordered = gazetteer::engine(&reversed, "cs").unwrap()
        .redact_static_entities(&text, &OperatorConfig::default()).unwrap();
      prop_assert_eq!(first.redaction, reordered.redaction);
    }
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
