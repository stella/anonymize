#![allow(
  clippy::arithmetic_side_effects,
  clippy::expect_used,
  clippy::indexing_slicing,
  clippy::unwrap_used
)]

//! A resolved span never leaves its entity: in scripts written without
//! spaces it stays on the matched characters, every edge sits on a grapheme
//! cluster boundary, and the delimiters around a name survive redaction.
//! A name no entry lists stays whole across name joiners, iteration marks
//! and script changes inside delimiters; exact outputs, known gaps included,
//! are pinned. Exercised through the bindings' assembler and the real engine.

use std::collections::BTreeSet;
use std::ops::Range;

use proptest::prelude::*;
use proptest::test_runner::{RngSeed, TestCaseError, TestRunner};
use stella_anonymize_adapter_contract::{
  assemble_static_search_config, prepared_search_config_from_binding,
};
use stella_anonymize_core::assemble::{GazetteerEntry, PipelineConfig};
use stella_anonymize_core::{Operator, OperatorConfig, PreparedEngine};
use unicode_segmentation::UnicodeSegmentation;

/// The engine's own joiner policy, so the cases cover every joiner it reads.
#[allow(dead_code, clippy::redundant_pub_crate)]
#[path = "../src/name_joiners.rs"]
mod name_joiners;

use name_joiners::NAME_JOINERS;

const ORGANIZATION: &str = "organization";
const PERSON: &str = "person";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Script {
  /// Words separated by spaces.
  Spaced,
  /// Written without spaces between words.
  Unspaced,
}

/// Caller entries in the scripts and forms the cases exercise; all names
/// are fictional.
const ENTRIES: [(&str, &str, Script); 14] = [
  ("紫苑工房", ORGANIZATION, Script::Unspaced),
  ("山田花子", PERSON, Script::Unspaced),
  // Iteration marks repeat the character before them (々, ゞ).
  ("佐々木花子", PERSON, Script::Unspaced),
  ("いすゞ工房", ORGANIZATION, Script::Unspaced),
  ("青石科技", ORGANIZATION, Script::Unspaced),
  ("王小明", PERSON, Script::Unspaced),
  ("한빛상사", ORGANIZATION, Script::Unspaced),
  ("김민수", PERSON, Script::Unspaced),
  ("กมลวรรณ ศรีสุข", PERSON, Script::Unspaced),
  ("ทองคำพัฒนา", ORGANIZATION, Script::Unspaced),
  ("Beta Trading s.r.o.", ORGANIZATION, Script::Spaced),
  ("Velmora", ORGANIZATION, Script::Spaced),
  ("Wintermute", PERSON, Script::Spaced),
  ("Zuzana Kováčová", PERSON, Script::Spaced),
];

fn all_entries() -> Vec<(&'static str, &'static str)> {
  ENTRIES
    .iter()
    .map(|(name, label, _)| (*name, *label))
    .collect()
}

/// The chat pipeline's detectors, gazetteer included, at the request
/// threshold.
fn engine(entries: &[(&str, &str)]) -> PreparedEngine {
  let config: PipelineConfig = serde_json::from_value(serde_json::json!({
    "threshold": 0.4,
    "enableTriggerPhrases": true,
    "enableRegex": true,
    "enableNameCorpus": true,
    "enableDenyList": true,
    "denyListCountries": [],
    "enableGazetteer": true,
    "enableConfidenceBoost": false,
    "enableCoreference": true,
    "enableLegalForms": true,
    "labels": [PERSON, ORGANIZATION, "location", "registration number"],
    "workspaceId": "span-boundaries"
  }))
  .unwrap();
  let entries = entries
    .iter()
    .enumerate()
    .map(|(index, (canonical, label))| {
      serde_json::from_value::<GazetteerEntry>(serde_json::json!({
        "id": format!("entry-{index}"),
        "canonical": canonical,
        "label": label,
        "variants": [],
        "workspaceId": "span-boundaries",
        "createdAt": 0,
        "source": "manual"
      }))
      .unwrap()
    })
    .collect::<Vec<_>>();
  let binding = assemble_static_search_config(&config, None, &entries).unwrap();
  PreparedEngine::new(prepared_search_config_from_binding(binding).unwrap())
    .unwrap()
}

fn redact(engine: &PreparedEngine, text: &str) -> String {
  engine
    .redact_static_entities(text, &OperatorConfig::default())
    .unwrap()
    .redaction
    .redacted_text
}

fn assert_redactions(engine: &PreparedEngine, cases: &[(&str, &str)]) {
  for (text, expected) in cases {
    assert_eq!(redact(engine, text), *expected, "{text}");
  }
}

#[test]
fn japanese_names_stay_within_their_characters() {
  assert_redactions(
    &engine(&all_entries()),
    &[
      (
        "本契約は紫苑工房と締結された。",
        "本契約は[ORGANIZATION_1]と締結された。",
      ),
      (
        "紫苑工房株式会社は本契約に署名した。",
        "[ORGANIZATION_1]株式会社は本契約に署名した。",
      ),
      ("契約当事者：紫苑工房", "契約当事者：[ORGANIZATION_1]"),
      (
        "売主山田花子は、買主紫苑工房に対し目的物を引き渡す。",
        "売主[PERSON_1]は、買主[ORGANIZATION_1]に対し目的物を引き渡す。",
      ),
      (
        "山田花子が代表取締役に就任した。",
        "[PERSON_1]が代表取締役に就任した。",
      ),
    ],
  );
}

#[test]
fn chinese_names_stay_within_their_characters() {
  assert_redactions(
    &engine(&all_entries()),
    &[
      ("本合同由青石科技签署。", "本合同由[ORGANIZATION_1]签署。"),
      (
        "甲方青石科技有限公司同意以下条款。",
        "甲方[ORGANIZATION_1]有限公司同意以下条款。",
      ),
      ("乙方：王小明", "乙方：[PERSON_1]"),
      (
        "王小明与青石科技于二〇二五年签订本协议。",
        "[PERSON_1]与[ORGANIZATION_1]于二〇二五年签订本协议。",
      ),
    ],
  );
}

#[test]
fn korean_names_keep_their_particles_visible() {
  assert_redactions(
    &engine(&all_entries()),
    &[
      (
        "매도인 김민수는 다음과 같이 합의한다.",
        "매도인 [PERSON_1]는 다음과 같이 합의한다.",
      ),
      (
        "본 계약은 한빛상사와 체결한다.",
        "본 계약은 [ORGANIZATION_1]와 체결한다.",
      ),
      ("계약 당사자: 김민수", "계약 당사자: [PERSON_1]"),
      (
        "한빛상사주식회사가 대금을 지급한다.",
        "[ORGANIZATION_1]주식회사가 대금을 지급한다.",
      ),
    ],
  );
}

#[test]
fn thai_names_stay_within_their_grapheme_clusters() {
  assert_redactions(
    &engine(&all_entries()),
    &[
      ("ผู้ซื้อคือกมลวรรณ ศรีสุขตามสัญญานี้", "ผู้ซื้อคือ[PERSON_1]ตามสัญญานี้"),
      ("ผู้ซื้อคือ กมลวรรณ ศรีสุข ตามสัญญานี้", "ผู้ซื้อคือ [PERSON_1] ตามสัญญานี้"),
      ("กมลวรรณ ศรีสุขเป็นผู้ซื้อที่ดินแปลงนี้", "[PERSON_1]เป็นผู้ซื้อที่ดินแปลงนี้"),
      ("ลงนามโดยกมลวรรณ ศรีสุข", "ลงนามโดย[PERSON_1]"),
      (
        "บริษัททองคำพัฒนาจำกัดเป็นผู้ขาย",
        "บริษัท[ORGANIZATION_1]จำกัดเป็นผู้ขาย",
      ),
    ],
  );
}

#[test]
fn closing_delimiters_survive_redaction() {
  let engine = engine(&all_entries());
  assert_redactions(
    &engine,
    &[
      (
        "Šablona <<Beta Trading s.r.o.>> je hotová.",
        "Šablona <<[ORGANIZATION_1]>> je hotová.",
      ),
      (
        "Smluvní strana «Beta Trading s.r.o.» souhlasí.",
        "Smluvní strana «[ORGANIZATION_1]» souhlasí.",
      ),
      (
        "Společnost „Beta Trading s.r.o.“ podepsala dodatek.",
        "Společnost „[ORGANIZATION_1]“ podepsala dodatek.",
      ),
      (
        "Zmluvu podpísala spoločnosť (Beta Trading s.r.o.), ktorá ju vypracovala.",
        "Zmluvu podpísala spoločnosť ([ORGANIZATION_1]), ktorá ju vypracovala.",
      ),
      (
        "The supplier [Beta Trading s.r.o.] agrees to the terms.",
        "The supplier [[ORGANIZATION_1]] agrees to the terms.",
      ),
      (
        "Template field {{Wintermute}} is filled.",
        "Template field {{[PERSON_1]}} is filled.",
      ),
      (
        "Signed by <<Zuzana Kováčová>> today.",
        "Signed by <<[PERSON_1]>> today.",
      ),
      (
        "Vendor «Velmora GmbH» confirmed.",
        "Vendor «[ORGANIZATION_1]» confirmed.",
      ),
      (
        "会社名「紫苑工房」に変更する。",
        "会社名「[ORGANIZATION_1]」に変更する。",
      ),
      (
        "旧商号『紫苑工房株式会社』を廃止する。",
        "旧商号『[ORGANIZATION_1]株式会社』を廃止する。",
      ),
      (
        "当事者（紫苑工房）は合意した。",
        "当事者（[ORGANIZATION_1]）は合意した。",
      ),
      (
        "签约方《青石科技》确认。",
        "签约方《[ORGANIZATION_1]》确认。",
      ),
    ],
  );
}

#[test]
fn legal_form_organizations_keep_their_delimiters_without_entries() {
  assert_redactions(
    &engine(&[]),
    &[
      (
        "Šablona <<Beta Trading s.r.o.>> je hotová.",
        "Šablona <<[ORGANIZATION_1]>> je hotová.",
      ),
      (
        "Smluvní strana «Beta Trading s.r.o.» souhlasí.",
        "Smluvní strana «[ORGANIZATION_1]» souhlasí.",
      ),
      (
        "Společnost „Beta Trading s.r.o.“ podepsala dodatek.",
        "Společnost „[ORGANIZATION_1]“ podepsala dodatek.",
      ),
      (
        "Vendor {{Velmora GmbH}} confirmed.",
        "Vendor {{[ORGANIZATION_1]}} confirmed.",
      ),
      (
        "Smlouvu uzavřela 'Orvela Holding s.r.o.' dne 1. 5. 2025.",
        "Smlouvu uzavřela '[ORGANIZATION_1]' dne 1. 5. 2025.",
      ),
    ],
  );
}

#[test]
fn names_keep_inner_joiners_and_stop_at_closing_delimiters() {
  assert_redactions(
    &engine(&[]),
    &[
      (
        "Smlouvu podepsala <<Zuzana Kováčová-Nováková>> dnes.",
        "Smlouvu podepsala <<[PERSON_1]>> dnes.",
      ),
      ("Kupující: Zuzana Kováčová」", "Kupující: [PERSON_1]」"),
      (
        "Prodávající Jana Nováková, bytem Praha.",
        "Prodávající [PERSON_1], bytem Praha.",
      ),
      (
        "The lender is Investors' Bank Ltd. today.",
        "The lender is [ORGANIZATION_1] today.",
      ),
    ],
  );
}

#[test]
fn legal_form_organizations_stop_at_unspaced_script_text() {
  assert_redactions(
    &engine(&[]),
    &[
      (
        "本契約はVelmora s.r.o.、東京で締結した。",
        "本契約は[ORGANIZATION_1]、東京で締結した。",
      ),
      ("매도인Velmora GmbH, 서울", "매도인[ORGANIZATION_1], 서울"),
      ("ผู้ซื้อคือVelmora GmbH.", "ผู้ซื้อคือ[ORGANIZATION_1]."),
      (
        "甲方Orvela Holding Ltd，签署本合同。",
        "甲方[ORGANIZATION_1]，签署本合同。",
      ),
      (
        "本契約は'Orvela Holding s.r.o.'株式会社",
        "本契約は'[ORGANIZATION_1]'株式会社",
      ),
    ],
  );
}

/// What the full profile resolves a pinned case to.
#[derive(Clone, Copy, Debug)]
enum Pin {
  /// The identity is redacted in full and every other byte survives.
  Exact,
  /// A known gap: the engine returns `actual` instead of the expected output
  /// until the `target` release. Any change fails, including a fix, so the
  /// pin moves deliberately.
  KnownGap {
    actual: &'static str,
    target: &'static str,
  },
}

struct PinnedCase {
  id: &'static str,
  text: &'static str,
  expected: &'static str,
  pin: Pin,
}

/// Redacts every label the engine resolves, so the output shows exactly
/// which bytes each resolved entity covers.
fn redact_every_label(engine: &PreparedEngine, text: &str) -> String {
  let labels = engine
    .redact_static_entities(text, &OperatorConfig::default())
    .unwrap()
    .resolved_entities
    .into_iter()
    .map(|entity| entity.label);
  let operators = OperatorConfig {
    operators: labels
      .chain([PERSON, ORGANIZATION].map(str::to_owned))
      .map(|label| (label, Operator::Redact))
      .collect(),
    ..OperatorConfig::default()
  };
  engine
    .redact_static_entities(text, &operators)
    .unwrap()
    .redaction
    .redacted_text
}

fn assert_pinned(cases: &[PinnedCase]) {
  let engine = engine(&[]);
  let drifted = cases
    .iter()
    .filter_map(|case| {
      let actual = redact_every_label(&engine, case.text);
      let (holds, pinned) = match case.pin {
        Pin::Exact => (actual == case.expected, String::new()),
        Pin::KnownGap {
          actual: pinned,
          target,
        } => (
          actual == pinned && pinned != case.expected,
          format!(" (known gap until {target}: {pinned:?})"),
        ),
      };
      (!holds)
        .then(|| format!("{}: {:?} -> {actual:?}{pinned}", case.id, case.text))
    })
    .collect::<Vec<_>>();
  assert!(
    drifted.is_empty(),
    "pinned cases drifted:\n{}",
    drifted.join("\n")
  );
}

/// Compound surnames, initials and delimiters around a person no entry
/// lists. `Tarsk` in P11 and P12 is a heading outside the quotation.
const UNLISTED_PERSONS: &[PinnedCase] = &[
  PinnedCase {
    id: "P01",
    text: "Kupující: Zuzana Tarsk\u{2011}Velmor.",
    expected: "Kupující: [REDACTED].",
    pin: Pin::Exact,
  },
  PinnedCase {
    id: "P02",
    text: "Kupující: Zuzana Tarsk\u{2013}Velmor.",
    expected: "Kupující: [REDACTED].",
    pin: Pin::Exact,
  },
  // The trigger phrase reads the sentence's full stop into its value.
  PinnedCase {
    id: "P01-ascii",
    text: "Kupující: Zuzana Tarsk-Velmor.",
    expected: "Kupující: [REDACTED].",
    pin: Pin::KnownGap {
      actual: "Kupující: [REDACTED]",
      target: "3.0.7",
    },
  },
  PinnedCase {
    id: "P01-ascii-mid-sentence",
    text: "Kupující: Zuzana Tarsk-Velmor, bytem Brno.",
    expected: "Kupující: [REDACTED], bytem Brno.",
    pin: Pin::Exact,
  },
  PinnedCase {
    id: "P01-hyphen",
    text: "Kupující: Zuzana Tarsk\u{2010}Velmor.",
    expected: "Kupující: [REDACTED].",
    pin: Pin::Exact,
  },
  PinnedCase {
    id: "P02-spaced-dash",
    text: "Kupující: Zuzana Tarsk\u{2011}Velmor \u{2013} viz příloha.",
    expected: "Kupující: [REDACTED] \u{2013} viz příloha.",
    pin: Pin::Exact,
  },
  // P03-P10 and P13: a first name followed only by an initial is not
  // read as a person, whatever delimits it.
  PinnedCase {
    id: "P03",
    text: "Kupující: (Zuzana A.)",
    expected: "Kupující: ([REDACTED])",
    pin: Pin::KnownGap {
      actual: "Kupující: (Zuzana A.)",
      target: "3.0.7",
    },
  },
  PinnedCase {
    id: "P04",
    text: "Kupující: [Zuzana A.]",
    expected: "Kupující: [[REDACTED]]",
    pin: Pin::KnownGap {
      actual: "Kupující: [Zuzana A.]",
      target: "3.0.7",
    },
  },
  PinnedCase {
    id: "P05",
    text: "Kupující: <<Zuzana A.>>",
    expected: "Kupující: <<[REDACTED]>>",
    pin: Pin::KnownGap {
      actual: "Kupující: <<Zuzana A.>>",
      target: "3.0.7",
    },
  },
  PinnedCase {
    id: "P06",
    text: "Kupující: {{Zuzana A.}}",
    expected: "Kupující: {{[REDACTED]}}",
    pin: Pin::KnownGap {
      actual: "Kupující: {{Zuzana A.}}",
      target: "3.0.7",
    },
  },
  PinnedCase {
    id: "P07",
    text: "Kupující: 「Zuzana A.」",
    expected: "Kupující: 「[REDACTED]」",
    pin: Pin::KnownGap {
      actual: "Kupující: 「Zuzana A.」",
      target: "3.0.7",
    },
  },
  PinnedCase {
    id: "P08",
    text: "Kupující: 『Zuzana A.』",
    expected: "Kupující: 『[REDACTED]』",
    pin: Pin::KnownGap {
      actual: "Kupující: 『Zuzana A.』",
      target: "3.0.7",
    },
  },
  PinnedCase {
    id: "P09",
    text: "Kupující: （Zuzana A.）",
    expected: "Kupující: （[REDACTED]）",
    pin: Pin::KnownGap {
      actual: "Kupující: （Zuzana A.）",
      target: "3.0.7",
    },
  },
  PinnedCase {
    id: "P10",
    text: "Kupující: 《Zuzana A.》",
    expected: "Kupující: 《[REDACTED]》",
    pin: Pin::KnownGap {
      actual: "Kupující: 《Zuzana A.》",
      target: "3.0.7",
    },
  },
  // P11 and P12: the initial's closing quote is read as part of the
  // initial, so the name runs on into the heading after it.
  PinnedCase {
    id: "P11",
    text: "Kupující: \u{201c}Zuzana A.\u{201d} Tarsk",
    expected: "Kupující: \u{201c}[REDACTED]\u{201d} Tarsk",
    pin: Pin::KnownGap {
      actual: "Kupující: \u{201c}[REDACTED]",
      target: "3.0.7",
    },
  },
  PinnedCase {
    id: "P12",
    text: "Kupující: 'Zuzana A.' Tarsk",
    expected: "Kupující: '[REDACTED]' Tarsk",
    pin: Pin::KnownGap {
      actual: "Kupující: '[REDACTED]",
      target: "3.0.7",
    },
  },
  PinnedCase {
    id: "P13",
    text: "Kupující: «Zuzana A.»",
    expected: "Kupující: «[REDACTED]»",
    pin: Pin::KnownGap {
      actual: "Kupující: «Zuzana A.»",
      target: "3.0.7",
    },
  },
  PinnedCase {
    id: "P14",
    text: "Kupující: Zuzana Q",
    expected: "Kupující: [REDACTED]",
    pin: Pin::Exact,
  },
];

#[test]
fn unlisted_person_names_are_pinned() {
  assert_pinned(UNLISTED_PERSONS);
}

/// Legal-form organizations no entry lists, around script changes,
/// iteration marks, delimiters, possessives and combining marks.
const UNLISTED_ORGANIZATIONS: &[PinnedCase] = &[
  PinnedCase {
    id: "L01",
    text: "<<佐々木 GmbH>>",
    expected: "<<[REDACTED]>>",
    pin: Pin::Exact,
  },
  PinnedCase {
    id: "L01-vertical",
    text: "<<佐〻木 GmbH>>",
    expected: "<<[REDACTED]>>",
    pin: Pin::Exact,
  },
  PinnedCase {
    id: "L02",
    text: "<<Tarsk紫苑 GmbH>>",
    expected: "<<[REDACTED]>>",
    pin: Pin::Exact,
  },
  PinnedCase {
    id: "L02-in-sentence",
    text: "本契約は「Tarsk紫苑 GmbH」に変更する。",
    expected: "本契約は「[REDACTED]」に変更する。",
    pin: Pin::Exact,
  },
  PinnedCase {
    id: "L03",
    text: "Referenced 'Tarsks' Velmora GmbH.",
    expected: "Referenced 'Tarsks' [REDACTED].",
    pin: Pin::Exact,
  },
  PinnedCase {
    id: "L04",
    text: "<<Tarsk\u{301} GmbH>>",
    expected: "<<[REDACTED]>>",
    pin: Pin::Exact,
  },
  PinnedCase {
    id: "L05",
    text: "<<Velmora GmbH>>签署",
    expected: "<<[REDACTED]>>签署",
    pin: Pin::Exact,
  },
  PinnedCase {
    id: "L01-kana",
    text: "<<いすゞ GmbH>>",
    expected: "<<[REDACTED]>>",
    pin: Pin::Exact,
  },
  PinnedCase {
    id: "L01-in-sentence",
    text: "甲方「佐々木 GmbH」签署。",
    expected: "甲方「[REDACTED]」签署。",
    pin: Pin::Exact,
  },
  PinnedCase {
    id: "L02-quoted",
    text: "本契約は'Tarsk紫苑 GmbH'に変更",
    expected: "本契約は'[REDACTED]'に変更",
    pin: Pin::Exact,
  },
  PinnedCase {
    id: "L02-parenthesis",
    text: "Dodavatel (Tarsk紫苑 GmbH) souhlasí.",
    expected: "Dodavatel ([REDACTED]) souhlasí.",
    pin: Pin::Exact,
  },
  PinnedCase {
    id: "L02-inner-apostrophe",
    text: "'O'Neil紫苑 GmbH'",
    expected: "'[REDACTED]'",
    pin: Pin::Exact,
  },
  PinnedCase {
    id: "L03-possessive",
    text: "The lender is <<Investors' Bank Ltd.>> today.",
    expected: "The lender is <<[REDACTED]>> today.",
    pin: Pin::Exact,
  },
];

#[test]
fn unlisted_legal_form_organizations_are_pinned() {
  assert_pinned(UNLISTED_ORGANIZATIONS);
}

/// Every joiner the engine reads joins an unlisted compound surname in
/// running text, inside delimiters and after a middle initial.
#[test]
fn compound_surnames_stay_whole_with_every_joiner() {
  let engine = engine(&[]);
  let contexts = [
    ("Smlouvu podepsala ", "Zuzana ", " dne 1. 5."),
    ("Smlouvu podepsala <<", "Zuzana ", ">> dnes."),
    ("Smlouvu podepsala „", "Zuzana ", "“ dnes."),
    ("Smlouvu podepsala ", "Zuzana A. ", " dne 1. 5."),
    ("Kupující: ", "Zuzana ", ", bytem Brno."),
    ("Signed by ", "Jana ", " today."),
  ];
  let drifted = NAME_JOINERS
    .iter()
    .flat_map(|(joiner, _)| {
      contexts.iter().map(move |(before, given, after)| {
        let text = format!("{before}{given}Tarsk{joiner}Velmor{after}");
        let expected = format!("{before}[REDACTED]{after}");
        (text, expected)
      })
    })
    .filter_map(|(text, expected)| {
      let actual = redact_every_label(&engine, &text);
      (actual != expected).then(|| format!("{text:?} -> {actual:?}"))
    })
    .collect::<Vec<_>>();
  assert!(
    drifted.is_empty(),
    "compound surnames split:\n{}",
    drifted.join("\n")
  );
}

/// Unspaced-script context pieces: Japanese, Chinese, Korean and Thai, the
/// Thai ones with tone and vowel marks that combine with the previous base.
const UNSPACED_CONTEXT: [&str; 12] = [
  "本契約は",
  "と締結された",
  "株式会社",
  "甲方",
  "有限公司",
  "签署",
  "매도인",
  "는",
  "주식회사",
  "ผู้ซื้อคือ",
  "ตามสัญญานี้",
  "ที่ดิน",
];

/// Characters that combine with the base before them.
const COMBINING_MARKS: [&str; 6] = [
  "\u{e49}", "\u{e31}", "\u{e47}", "\u{301}", "\u{3099}", "\u{20dd}",
];

/// Opening and closing delimiters, including none.
const DELIMITERS: [(&str, &str); 14] = [
  ("", ""),
  ("<<", ">>"),
  ("«", "»"),
  ("„", "“"),
  ("「", "」"),
  ("『", "』"),
  ("（", "）"),
  ("(", ")"),
  ("[", "]"),
  ("{{", "}}"),
  ("\"", "\""),
  ("“", "”"),
  ("《", "》"),
  ("'", "'"),
];

/// Legal forms the gazetteer may extend a name over.
const LEGAL_FORMS: [&str; 3] = [" s.r.o.", " GmbH", ", a.s."];

/// Organization names no entry lists: only their legal form finds them.
const UNLISTED: [&str; 2] = ["Orvela Holding", "Tarsk Logistik"];

#[derive(Debug)]
struct Context {
  entry: usize,
  prefix: String,
  delimiter: usize,
  legal_form: Option<usize>,
  mark: Option<usize>,
  suffix: String,
}

fn unspaced_piece() -> impl Strategy<Value = String> {
  prop_oneof![
    prop::sample::select(UNSPACED_CONTEXT.to_vec()).prop_map(str::to_owned),
    "[ぁ-ゖ一-龥가-힣ก-ฮ]{1,4}",
  ]
}

fn spaced_piece() -> impl Strategy<Value = String> {
  prop::sample::select(vec![" dne ", " podle ", " the ", " je hotová."])
    .prop_map(str::to_owned)
}

/// Unspaced text glued to the name, spaced words beyond it. A word of a
/// caseless script set off by spaces near a legal form is left out: the
/// legal-form detector reads such words as capitalized name words
/// (`東京 Court`), a heuristic outside this boundary contract.
fn surroundings() -> impl Strategy<Value = (String, String)> {
  (
    prop::collection::vec(spaced_piece(), 0..2),
    prop::collection::vec(unspaced_piece(), 0..3),
    prop::collection::vec(unspaced_piece(), 0..3),
    prop::collection::vec(spaced_piece(), 0..2),
  )
    .prop_map(|(far_before, before, after, far_after)| {
      (
        far_before.concat() + &before.concat(),
        after.concat() + &far_after.concat(),
      )
    })
}

fn context() -> impl Strategy<Value = Context> {
  (
    0..ENTRIES.len() + UNLISTED.len(),
    surroundings(),
    0..DELIMITERS.len(),
    prop::option::of(0..LEGAL_FORMS.len()),
    prop::option::weighted(0.2, 0..COMBINING_MARKS.len()),
  )
    .prop_map(|(entry, (prefix, suffix), delimiter, legal_form, mark)| {
      Context {
        entry,
        prefix,
        delimiter,
        legal_form,
        mark,
        suffix,
      }
    })
}

fn grapheme_boundaries(text: &str) -> BTreeSet<usize> {
  text
    .grapheme_indices(true)
    .map(|(start, _)| start)
    .chain([text.len()])
    .collect()
}

/// The grapheme boundary at or after `offset`.
fn cluster_end(boundaries: &BTreeSet<usize>, offset: usize) -> usize {
  boundaries.range(offset..).next().copied().unwrap()
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

fn check_context(
  engine: &PreparedEngine,
  context: &Context,
) -> Result<(), TestCaseError> {
  let (name, label, script, unlisted) = match ENTRIES.get(context.entry) {
    Some((name, label, script)) => (*name, *label, *script, false),
    None => (
      UNLISTED[context.entry - ENTRIES.len()],
      ORGANIZATION,
      Script::Spaced,
      true,
    ),
  };
  let (open, close) = DELIMITERS[context.delimiter];
  let spaced = script == Script::Spaced;
  // Legal forms follow Latin organization names only; unspaced-script
  // forms are context pieces the span must not take.
  let legal_form = if unlisted {
    LEGAL_FORMS[context.legal_form.unwrap_or_default()]
  } else {
    context
      .legal_form
      .filter(|_| spaced && label == ORGANIZATION && !name.ends_with('.'))
      .map_or("", |index| LEGAL_FORMS[index])
  };
  let mark = context.mark.map_or("", |index| COMBINING_MARKS[index]);
  // `hotová.Velmora` reads as one dotted token; keep the sentence apart.
  let gap = if spaced && open.is_empty() && context.prefix.ends_with('.') {
    " "
  } else {
    ""
  };
  let mut text = context.prefix.clone();
  text.push_str(gap);
  let open_start = text.len();
  text.push_str(open);
  let name_start = text.len();
  text.push_str(name);
  let name_end = text.len();
  text.push_str(legal_form);
  let form_end = text.len();
  text.push_str(mark);
  text.push_str(close);
  let close_end = text.len();
  text.push_str(&context.suffix);

  let boundaries = grapheme_boundaries(&text);
  // The entity may grow by its legal form and by marks that combine with
  // its last character, nothing more.
  let allowed = name_start..cluster_end(&boundaries, form_end);
  let found = spans(engine, &text);
  for span in &found {
    prop_assert!(
      boundaries.contains(&span.start) && boundaries.contains(&span.end),
      "{span:?} splits a grapheme cluster in {text:?}"
    );
    if span.start < close_end && open_start < span.end {
      prop_assert!(
        allowed.start <= span.start && span.end <= allowed.end,
        "{span:?} leaves {allowed:?} in {text:?}"
      );
    }
  }
  // A Latin name followed by a combining mark spells another word, and the
  // legal-form detector needs a non-letter after the form it reads.
  let glued_mark = spaced && legal_form.is_empty() && !mark.is_empty();
  let glued_form = unlisted
    && text
      .get(form_end..)
      .and_then(|rest| rest.chars().next())
      .is_some_and(char::is_alphanumeric);
  if !glued_mark && !glued_form {
    prop_assert!(
      found
        .iter()
        .any(|span| span.start <= name_start && name_end <= span.end),
      "{name:?} is not redacted in {text:?}: {found:?}"
    );
  }
  Ok(())
}

#[test]
fn resolved_spans_stay_inside_their_entity_and_on_grapheme_boundaries() {
  let engine = engine(&all_entries());
  let mut runner = TestRunner::new(ProptestConfig {
    cases: 256,
    // "spanedge"
    rng_seed: RngSeed::Fixed(0x7370_616e_6564_6765),
    failure_persistence: None,
    ..ProptestConfig::default()
  });
  runner
    .run(&context(), |context| check_context(&engine, &context))
    .unwrap();
}

/// A designated identity and the delimiters around it in `text`.
#[derive(Debug)]
struct Placed {
  text: String,
  open_start: usize,
  identity: Range<usize>,
  close_end: usize,
}

fn place(
  before: &str,
  (open, close): (&str, &str),
  identity: &str,
  after: &str,
) -> Placed {
  let mut text = before.to_owned();
  let open_start = text.len();
  text.push_str(open);
  let start = text.len();
  text.push_str(identity);
  let end = text.len();
  text.push_str(close);
  let close_end = text.len();
  text.push_str(after);
  Placed {
    text,
    open_start,
    identity: start..end,
    close_end,
  }
}

/// No identity character survives: one resolved span covers the whole
/// identity, and no span reaches past it into the delimiters.
fn check_identity(
  engine: &PreparedEngine,
  placed: &Placed,
) -> Result<(), TestCaseError> {
  let Placed {
    text,
    open_start,
    identity,
    close_end,
  } = placed;
  let boundaries = grapheme_boundaries(text);
  let allowed = identity.start..cluster_end(&boundaries, identity.end);
  let found = spans(engine, text);
  prop_assert!(
    found
      .iter()
      .any(|span| span.start <= identity.start && identity.end <= span.end),
    "{text:?} leaks part of {identity:?}: {found:?}"
  );
  for span in &found {
    if span.start < *close_end && *open_start < span.end {
      prop_assert!(
        allowed.start <= span.start && span.end <= allowed.end,
        "{span:?} leaves {allowed:?} in {text:?}"
      );
    }
  }
  Ok(())
}

fn run_property(
  seed: u64,
  strategy: &impl Strategy<Value = Placed>,
  engine: &PreparedEngine,
) {
  let mut runner = TestRunner::new(ProptestConfig {
    cases: 256,
    rng_seed: RngSeed::Fixed(seed),
    failure_persistence: None,
    ..ProptestConfig::default()
  });
  runner
    .run(strategy, |placed| check_identity(engine, &placed))
    .unwrap();
}

/// Given names the name corpus knows; the surnames are unlisted.
const GIVEN_NAMES: [&str; 2] = ["Zuzana", "Jana"];
const SURNAME_PARTS: [&str; 4] = ["Tarsk", "Velmor", "Orvel", "Kestrin"];
const PERSON_LEADS: [&str; 3] =
  ["Smlouvu podepsala ", "Kupující: ", "Signed by "];
const PERSON_TAILS: [&str; 4] = [" dne 1. 5.", ", bytem Brno.", " today.", ""];

/// An unlisted compound surname joined by any joiner of the engine's
/// policy, after a known given name and an optional initial, in any
/// delimiter.
fn compound_person() -> impl Strategy<Value = Placed> {
  (
    prop::sample::select(PERSON_LEADS.to_vec()),
    prop::sample::select(GIVEN_NAMES.to_vec()),
    prop::option::of(prop::sample::select(vec!["A. ", "R. "])),
    prop::sample::select(SURNAME_PARTS.to_vec()),
    prop::sample::select(NAME_JOINERS.map(|(joiner, _)| joiner).to_vec()),
    prop::sample::select(SURNAME_PARTS.to_vec()),
    0..DELIMITERS.len(),
    prop::sample::select(PERSON_TAILS.to_vec()),
  )
    .prop_map(
      |(lead, given, initial, head, joiner, tail, delimiter, after)| {
        let identity =
          format!("{given} {}{head}{joiner}{tail}", initial.unwrap_or(""));
        place(lead, DELIMITERS[delimiter], &identity, after)
      },
    )
}

#[test]
fn compound_surnames_are_redacted_whole_with_every_joiner() {
  // "joiners!"
  run_property(0x6a6f_696e_6572_7321, &compound_person(), &engine(&[]));
}

/// A name spelled with an iteration mark: 々 or 〻 after an ideograph, ゝ or
/// ゞ after hiragana, ヽ or ヾ after katakana.
fn iteration_mark_name() -> impl Strategy<Value = String> {
  prop_oneof![
    (
      "[一-龥]",
      prop::sample::select(vec!['々', '〻']),
      "[一-龥]{0,2}"
    )
      .prop_map(|(head, mark, tail)| format!("{head}{mark}{tail}")),
    ("[ぁ-ゖ]{1,2}", prop::sample::select(vec!['ゝ', 'ゞ']))
      .prop_map(|(head, mark)| format!("{head}{mark}")),
    ("[ァ-ヺ]{1,2}", prop::sample::select(vec!['ヽ', 'ヾ']))
      .prop_map(|(head, mark)| format!("{head}{mark}")),
  ]
}

/// Where a Latin brand sits in a mixed-script organization name.
#[derive(Clone, Copy, Debug)]
enum Brand {
  None,
  Before,
  After,
}

/// An unlisted legal-form organization spelled with an iteration mark,
/// optionally glued to a Latin brand, enclosed by a delimiter pair amid
/// unspaced text.
fn enclosed_organization() -> impl Strategy<Value = Placed> {
  (
    prop::collection::vec(unspaced_piece(), 0..3),
    prop::sample::select(vec![Brand::None, Brand::Before, Brand::After]),
    iteration_mark_name(),
    prop::sample::select(LEGAL_FORMS.to_vec()),
    1..DELIMITERS.len(),
    prop::collection::vec(unspaced_piece(), 0..3),
  )
    .prop_map(|(before, brand, name, form, delimiter, after)| {
      let name = match brand {
        Brand::None => name,
        Brand::Before => format!("Tarsk{name}"),
        Brand::After => format!("{name}Velmor"),
      };
      place(
        &before.concat(),
        DELIMITERS[delimiter],
        &format!("{name}{form}"),
        &after.concat(),
      )
    })
}

#[test]
fn enclosed_organizations_are_redacted_whole_across_scripts() {
  // "itermark"
  run_property(
    0x6974_6572_6d61_726b,
    &enclosed_organization(),
    &engine(&[]),
  );
}
