#![allow(
  clippy::arithmetic_side_effects,
  clippy::expect_used,
  clippy::indexing_slicing,
  clippy::unwrap_used
)]

//! A resolved span never leaves its entity: in scripts written without
//! spaces it stays on the matched characters, every edge sits on a grapheme
//! cluster boundary, and the delimiters around a name survive redaction.
//! Exercised through the bindings' assembler and the real engine.

use std::collections::BTreeSet;
use std::ops::Range;

use proptest::prelude::*;
use proptest::test_runner::{RngSeed, TestCaseError, TestRunner};
use stella_anonymize_adapter_contract::{
  assemble_static_search_config, prepared_search_config_from_binding,
};
use stella_anonymize_core::assemble::{GazetteerEntry, PipelineConfig};
use stella_anonymize_core::{OperatorConfig, PreparedEngine};
use unicode_segmentation::UnicodeSegmentation;

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
const ENTRIES: [(&str, &str, Script); 12] = [
  ("紫苑工房", ORGANIZATION, Script::Unspaced),
  ("山田花子", PERSON, Script::Unspaced),
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
