#![allow(clippy::expect_used)]

//! Labeled gazetteer matching table: every case runs through the assembled
//! pipeline with one shared gazetteer, and the gazetteer detector output is
//! scored per class. Run with `--nocapture` to print the per-class table.

use stella_anonymize_adapter_contract::{
  BindingPreparedSearchConfig, assemble_static_search_config,
  prepared_search_config_from_binding,
};
use stella_anonymize_core::assemble::{GazetteerEntry, PipelineConfig};
use stella_anonymize_core::{
  DetectionSource, OperatorConfig, PipelineEntity, PreparedEngine,
};

const PERSON: &str = "person";
const ORGANIZATION: &str = "organization";
const IDENTIFIER: &str = "registration number";
const FORCED_ID: &str = "9b1d0c3e-acfe-4c1b-9d2e-5f6a7b8c9d0e";

const ENTRIES: &[(&str, &str, &[&str])] = &[
  ("Acme A", ORGANIZATION, &[]),
  ("Acme", ORGANIZATION, &[]),
  ("Novák", PERSON, &[]),
  ("Nováková", PERSON, &[]),
  ("Svoboda", PERSON, &[]),
  ("Beta Trading s.r.o.", ORGANIZATION, &[]),
  ("Lipová Invest s.r.o.", ORGANIZATION, &[]),
  ("Orbis", ORGANIZATION, &[]),
  ("Harriet", PERSON, &[]),
  ("Marie Dvořáková", PERSON, &[]),
  ("Tomáš Kubíček", PERSON, &[]),
  ("Ľubomír Šťastný", PERSON, &[]),
  ("Zeta", ORGANIZATION, &[]),
  ("Wintermute", PERSON, &[]),
  ("Gamma Holding s. r. o.", ORGANIZATION, &[]),
  ("Omega Stav k.s.", ORGANIZATION, &[]),
  ("@álîce", PERSON, &[]),
  ("C++", ORGANIZATION, &[]),
  ("Jan Novák", PERSON, &[]),
  ("Mark", PERSON, &[]),
  ("Will", PERSON, &[]),
  ("Grant", PERSON, &[]),
  ("Augusts", PERSON, &[]),
  ("McDonald", PERSON, &[]),
  ("Jan van Dijk", PERSON, &[]),
  ("J. Dvořák", PERSON, &[]),
  ("محمد", PERSON, &[]),
  ("東京", ORGANIZATION, &[]),
  ("თბილისი", ORGANIZATION, &[]),
  (FORCED_ID, IDENTIFIER, &[]),
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Class {
  Diacritics,
  Inflection,
  LegalForm,
  CaseAndOrder,
  Typo,
  Punctuated,
  Templates,
  CommonWordNames,
  BesideNumbers,
  OrdinaryWords,
  IdShapes,
  SpanExtent,
}

impl Class {
  const ALL: [Self; 12] = [
    Self::Diacritics,
    Self::Inflection,
    Self::LegalForm,
    Self::CaseAndOrder,
    Self::Typo,
    Self::Punctuated,
    Self::Templates,
    Self::CommonWordNames,
    Self::BesideNumbers,
    Self::OrdinaryWords,
    Self::IdShapes,
    Self::SpanExtent,
  ];
}

/// What the gazetteer must report for `probe` inside the case text.
#[derive(Clone, Copy, Debug)]
enum Expect {
  /// A gazetteer entity spans exactly this text and none reaches past it.
  Exact(&'static str),
  /// No gazetteer entity overlaps the probe.
  Nothing,
}

struct Case {
  class: Class,
  text: &'static str,
  probe: &'static str,
  expect: Expect,
}

const fn hit(class: Class, text: &'static str, name: &'static str) -> Case {
  Case {
    class,
    text,
    probe: name,
    expect: Expect::Exact(name),
  }
}

const fn miss(class: Class, text: &'static str, probe: &'static str) -> Case {
  Case {
    class,
    text,
    probe,
    expect: Expect::Nothing,
  }
}

const fn spans(
  class: Class,
  text: &'static str,
  probe: &'static str,
  name: &'static str,
) -> Case {
  Case {
    class,
    text,
    probe,
    expect: Expect::Exact(name),
  }
}

#[rustfmt::skip]
const CASES: &[Case] = &[
  // Diacritics added or dropped.
  hit(Class::Diacritics, "Smlouvu podepsala Acmé dnes.", "Acmé"),
  hit(Class::Diacritics, "Smlouvu podepsala Acmé A dnes.", "Acmé A"),
  hit(Class::Diacritics, "Zastupuje Orbís v řízení.", "Orbís"),
  hit(Class::Diacritics, "Dopis pro Hárriet dorazil.", "Hárriet"),
  hit(Class::Diacritics, "Smlouvu podepsal Novak dnes.", "Novak"),
  hit(Class::Diacritics, "Smlouvu podepsal Novák dnes.", "Novák"),
  // Czech and Slovak case forms, with and without diacritics.
  hit(Class::Inflection, "Předali jsme to Novákovi včera.", "Novákovi"),
  hit(Class::Inflection, "Bez pana Nováka to nepůjde.", "Nováka"),
  hit(Class::Inflection, "Mluvili jsme s Novakem včera.", "Novakem"),
  hit(Class::Inflection, "Mluvili jsme s Novákovou včera.", "Novákovou"),
  hit(Class::Inflection, "Předali jsme to Svobodovi včera.", "Svobodovi"),
  hit(Class::Inflection, "Předali jsme to Tomášovi Kubíčkovi včera.", "Tomášovi Kubíčkovi"),
  hit(Class::Inflection, "Odovzdali sme to Ľubomírovi Šťastnému včera.", "Ľubomírovi Šťastnému"),
  hit(Class::Inflection, "Odovzdali sme to Lubomirovi Stastnemu vcera.", "Lubomirovi Stastnemu"),
  hit(Class::Inflection, "Smlouvu se společností Beta Tradingem jsme uzavřeli.", "Beta Tradingem"),
  hit(Class::Inflection, "Novákova smlouva platí.", "Novákova"),
  hit(Class::Inflection, "Dům Nováků stojí.", "Nováků"),
  hit(Class::Inflection, "Paní Svobodová přišla.", "Svobodová"),
  // Legal-form spelling variants and the bare company name.
  hit(Class::LegalForm, "Smluvní strana Beta Trading s.r.o. souhlasí.", "Beta Trading s.r.o."),
  hit(Class::LegalForm, "Smluvní strana Beta Trading, s. r. o. souhlasí.", "Beta Trading, s. r. o."),
  hit(Class::LegalForm, "Smluvní strana Beta Trading s. r. o. souhlasí.", "Beta Trading s. r. o."),
  hit(Class::LegalForm, "Smluvní strana Beta Trading spol. s r.o. souhlasí.", "Beta Trading spol. s r.o."),
  hit(Class::LegalForm, "Smluvní strana Beta Trading souhlasí.", "Beta Trading"),
  hit(Class::LegalForm, "Pronajímatel Lipová Invest s.r.o. souhlasí.", "Lipová Invest s.r.o."),
  hit(Class::LegalForm, "Pronajímatel Lipova Invest, s.r.o. souhlasí.", "Lipova Invest, s.r.o."),
  hit(Class::LegalForm, "Dodavatel ACME a.s. souhlasí.", "ACME a.s."),
  hit(Class::LegalForm, "Dodavatel Acme, a. s. souhlasí.", "Acme, a. s."),
  hit(Class::LegalForm, "Dodavateľ Gamma Holding s.r.o. súhlasí.", "Gamma Holding s.r.o."),
  hit(Class::LegalForm, "Dodavateľ Gamma Holding, spol. s r. o. súhlasí.", "Gamma Holding, spol. s r. o."),
  hit(Class::LegalForm, "Dodavateľ Omega Stav, k. s. súhlasí.", "Omega Stav, k. s."),
  hit(Class::LegalForm, "Dodavateľ Omega Stav v. o. s. súhlasí.", "Omega Stav v. o. s."),
  hit(Class::LegalForm, "Dodavateľ Omega Stav, š. p. súhlasí.", "Omega Stav, š. p."),
  hit(Class::LegalForm, "Dodavatel Omega Stav z. s. souhlasí.", "Omega Stav z. s."),
  // Letter case and surname-first order.
  hit(Class::CaseAndOrder, "Dodavatel ACME souhlasí.", "ACME"),
  hit(Class::CaseAndOrder, "Dodavatel acme souhlasí.", "acme"),
  hit(Class::CaseAndOrder, "Podpis: Dvořáková, Marie, jednatelka.", "Dvořáková, Marie"),
  hit(Class::CaseAndOrder, "Podpis: Marie Dvořáková, jednatelka.", "Marie Dvořáková"),
  // Typos in long names.
  hit(Class::Typo, "Smluvní strana Beta Tradng s.r.o. souhlasí.", "Beta Tradng s.r.o."),
  hit(Class::Typo, "The memo names Wintermite as the sender.", "Wintermite"),
  hit(Class::Typo, "Klient Orbys zaplatil.", "Orbys"),
  hit(Class::Typo, "Smlouvu podepsal pan Novác dnes.", "Novác"),
  miss(Class::Typo, "Zvolili orbys jako název.", "orbys"),
  miss(Class::Typo, "Orbit se nezměnil.", "Orbit"),
  // Entries spelled with edge punctuation, folded like any other.
  hit(Class::Punctuated, "Napište @alice dnes.", "@alice"),
  hit(Class::Punctuated, "Napište @Álîce dnes.", "@Álîce"),
  miss(Class::Punctuated, "Přišla alice dnes.", "alice"),
  hit(Class::Punctuated, "Píšeme v C++ dnes.", "C++"),
  miss(Class::Punctuated, "Plán C platí.", "C"),
  // Names inside template placeholders and wiki links.
  hit(Class::Templates, "Poznámka [[Jan Novák]] zde.", "Jan Novák"),
  hit(Class::Templates, "Šablona {{Acme}} zde.", "Acme"),
  hit(Class::Templates, "Šablona <<Novák>> zde.", "Novák"),
  hit(Class::Templates, "Odkaz [[Orbis]] zde.", "Orbis"),
  hit(Class::Templates, "Odkaz [[Zeta2024]] zde.", "Zeta"),
  hit(Class::Templates, "Šablona {{Acme2024}} zde.", "Acme"),
  miss(Class::Templates, "Šablona {{acme_01}} zde.", "acme"),
  hit(Class::Templates, "Odkaz [[McDonald2024]] zde.", "McDonald"),
  hit(Class::Templates, "Odkaz [[Jan van Dijk2024]] zde.", "Jan van Dijk"),
  hit(Class::Templates, "Odkaz [[J. Dvořák2024]] zde.", "J. Dvořák"),
  hit(Class::Templates, "Odkaz [[McDonalda2024]] zde.", "McDonalda"),
  hit(Class::Templates, "Odkaz [[Jan van Dijka2024]] zde.", "Jan van Dijka"),
  hit(Class::Templates, "Odkaz [[محمد2024]] zde.", "محمد"),
  hit(Class::Templates, "Odkaz {{東京2024}} zde.", "東京"),
  hit(Class::Templates, "Odkaz [[თბილისი2024]] zde.", "თბილისი"),
  miss(Class::Templates, "Odkaz [[mcdonald2024]] zde.", "mcdonald"),
  miss(Class::Templates, "Viz <<token:zeta9>> a {{mcdonald2024}}.", "mcdonald"),
  // Person entries that are also common words, scored on the resolved
  // (redacted) output: an exact entry is always redacted.
  hit(Class::CommonWordNames, "Hello Mark there.", "Mark"),
  hit(Class::CommonWordNames, "Ask Will now.", "Will"),
  hit(Class::CommonWordNames, "Grant signed the deal.", "Grant"),
  hit(Class::CommonWordNames, "Smlouvu podepsal Mark dnes.", "Mark"),
  // A fuzzy hit is inferred, so common-word filters still apply to it.
  miss(Class::CommonWordNames, "Ask August now.", "August"),
  // Names next to numbers, years, and words in references, emails, URLs,
  // handles, and file names.
  spans(Class::BesideNumbers, "Smlouva Acme/2024 platí.", "Acme/2024", "Acme"),
  spans(Class::BesideNumbers, "Spis Novák-1 založen.", "Novák-1", "Novák"),
  spans(Class::BesideNumbers, "Verze Acme-2 vyšla.", "Acme-2", "Acme"),
  hit(Class::BesideNumbers, "Smlouva Acme 2024/5 platí.", "Acme"),
  hit(Class::BesideNumbers, "Věc Novák 12 C 345/2024 projednána.", "Novák"),
  spans(Class::BesideNumbers, "Strana Acme s.r.o./2024 souhlasí.", "Acme s.r.o./2024", "Acme s.r.o."),
  spans(Class::BesideNumbers, "Pište na novak2@acme.cz dnes.", "novak2", "novak"),
  spans(Class::BesideNumbers, "Pište na novak2@acme.cz dnes.", "@acme.", "acme"),
  spans(Class::BesideNumbers, "Pište na j.novak@acme-2.cz dnes.", "j.novak@", "novak"),
  spans(Class::BesideNumbers, "Pište na j.novak@acme-2.cz dnes.", "@acme-2", "acme"),
  spans(Class::BesideNumbers, "Pište na acme2024@example.cz dnes.", "acme2024", "acme"),
  spans(Class::BesideNumbers, "Soubor Novak_smlouva_2024.pdf přiložen.", "Novak_smlouva", "Novak"),
  spans(Class::BesideNumbers, "Soubor Acme_v2.docx přiložen.", "Acme_v2", "Acme"),
  spans(Class::BesideNumbers, "Web https://acme.cz/kontakt uveden.", "//acme.cz", "acme"),
  spans(Class::BesideNumbers, "Web acme.cz uveden.", "acme.cz", "acme"),
  spans(Class::BesideNumbers, "Účet @acme píše.", "@acme", "acme"),
  spans(Class::BesideNumbers, "Štítek #acme platí.", "#acme", "acme"),
  spans(Class::BesideNumbers, "Štítek #Acme2024 platí.", "Acme2024", "Acme"),
  spans(Class::BesideNumbers, "Spis Nováka2024 založen.", "Nováka2024", "Nováka"),
  // Ordinary words that resemble an entry.
  miss(Class::OrdinaryWords, "The clause applies.", "clause"),
  miss(Class::OrdinaryWords, "Treat the acne first.", "acne"),
  miss(Class::OrdinaryWords, "One acre of land.", "acre"),
  miss(Class::OrdinaryWords, "Nobody came today.", "came"),
  miss(Class::OrdinaryWords, "Use a marker pen.", "marker"),
  miss(Class::OrdinaryWords, "The orbit is stable.", "orbit"),
  miss(Class::OrdinaryWords, "Vstoupil na orbitu.", "orbitu"),
  miss(Class::OrdinaryWords, "A zebra crossed.", "zebra"),
  miss(Class::OrdinaryWords, "Meta data were sent.", "Meta"),
  miss(Class::OrdinaryWords, "The data were sent.", "data"),
  miss(Class::OrdinaryWords, "Akce a slevy platí.", "Akce a"),
  miss(Class::OrdinaryWords, "Beta verze vyšla.", "Beta verze"),
  miss(Class::OrdinaryWords, "Nová smlouva platí.", "Nová"),
  miss(Class::OrdinaryWords, "Pan Nováček přišel.", "Nováček"),
  miss(Class::OrdinaryWords, "Novátor přišel.", "Novátor"),
  miss(Class::OrdinaryWords, "Žena přišla.", "Žena"),
  miss(Class::OrdinaryWords, "Bol šťastný celý deň.", "šťastný"),
  miss(Class::OrdinaryWords, "Mala šťastnú ruku.", "šťastnú"),
  miss(Class::OrdinaryWords, "Pan Kováč přišel.", "Kováč"),
  miss(Class::OrdinaryWords, "Marže je nízká.", "Marže"),
  miss(Class::OrdinaryWords, "Zaslali dopis.", "Zaslali"),
  miss(Class::OrdinaryWords, "Several acmes, Acmeco merged.", "acmes, Acmeco"),
  // Identifier-shaped tokens.
  miss(Class::IdShapes, "Hash 3f2acfeca1b0d4e5f60718293a4b5c6d uložen.", "3f2acfeca1b0d4e5f60718293a4b5c6d"),
  miss(Class::IdShapes, "Token acfe1b2c3d4e5f60 uložen.", "acfe1b2c3d4e5f60"),
  miss(Class::IdShapes, "Id 1b2c3d4e-acfe-4c1b-9d2e-0a1b2c3d4e5f uložen.", "1b2c3d4e-acfe-4c1b-9d2e-0a1b2c3d4e5f"),
  miss(Class::IdShapes, "Id acme0a1b2c3d uložen.", "acme0a1b2c3d"),
  miss(Class::IdShapes, "Sha e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 ok.", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
  miss(Class::IdShapes, "Pole ⟦field-acme-01⟧ zůstane.", "⟦field-acme-01⟧"),
  miss(Class::IdShapes, "Kód ACM3A platí.", "ACM3A"),
  miss(Class::IdShapes, "Kód zeta9f3c21 platí.", "zeta9f3c21"),
  miss(Class::IdShapes, "Kód ORB1S platí.", "ORB1S"),
  miss(Class::IdShapes, "Kód ZT4471Z platí.", "ZT4471Z"),
  miss(Class::IdShapes, "Sloupec acmeA_total platí.", "acmeA_total"),
  miss(Class::IdShapes, "Viz <<token:zeta9>> níže.", "<<token:zeta9>>"),
  miss(Class::IdShapes, "Blob QWNtZUEvb3JiaXM9WmV0YQ== platí.", "QWNtZUEvb3JiaXM9WmV0YQ=="),
  miss(Class::IdShapes, "Id 9b1d0c3e-acfe-4c1b-9d2e-5f6a7b8c9d0f uložen.", "9b1d0c3e-acfe-4c1b-9d2e-5f6a7b8c9d0f"),
  // A hit covers the name (plus legal form) and nothing more.
  spans(Class::SpanExtent, "Acme A signed the deal.", "Acme A signed", "Acme A"),
  spans(Class::SpanExtent, "Acme signed the deal.", "Acme signed", "Acme"),
  spans(Class::SpanExtent, "Novák podepsal smlouvu.", "Novák podepsal", "Novák"),
  spans(Class::SpanExtent, "Record 9b1d0c3e-acfe-4c1b-9d2e-5f6a7b8c9d0e archived today.", "9b1d0c3e-acfe-4c1b-9d2e-5f6a7b8c9d0e archived", FORCED_ID),
  spans(Class::SpanExtent, "Record 9b1d0c3e-acfe-4c1b-9d2e-5f6a7b8c9d0e closed.", "9b1d0c3e-acfe-4c1b-9d2e-5f6a7b8c9d0e closed", FORCED_ID),
];

fn engine() -> PreparedEngine {
  engine_for(Some("cs"), ENTRIES)
}

/// A gazetteer-only pipeline over `entries`, scoped to `language` (every
/// language when `None`).
fn engine_for(
  language: Option<&str>,
  entries: &[(&str, &str, &[&str])],
) -> PreparedEngine {
  let core =
    prepared_search_config_from_binding(binding_for(language, entries))
      .expect("assembled config should convert");
  PreparedEngine::new(core).expect("pipeline should prepare")
}

/// The assembled binding config of [`engine_for`].
fn binding_for(
  language: Option<&str>,
  entries: &[(&str, &str, &[&str])],
) -> BindingPreparedSearchConfig {
  let mut config = serde_json::json!({
    "threshold": 0.3,
    "enableTriggerPhrases": false,
    "enableRegex": false,
    "enableLegalForms": false,
    "enableNameCorpus": false,
    "enableDenyList": false,
    "enableGazetteer": true,
    "enableCountries": false,
    "enableConfidenceBoost": false,
    "enableCoreference": false,
    "enableZoneClassification": false,
    "labels": [],
    "workspaceId": "gazetteer-matching-test"
  });
  if let (Some(language), Some(object)) = (language, config.as_object_mut()) {
    object.insert("language".to_owned(), serde_json::json!(language));
  }
  let config: PipelineConfig =
    serde_json::from_value(config).expect("config should deserialize");
  let gazetteer: Vec<GazetteerEntry> = entries
    .iter()
    .enumerate()
    .map(|(index, (canonical, label, variants))| {
      serde_json::from_value(serde_json::json!({
        "id": format!("gaz-{index}"),
        "canonical": canonical,
        "label": label,
        "variants": variants,
        "workspaceId": "gazetteer-matching-test",
        "createdAt": 1_700_000_000_000_i64,
        "source": "manual",
      }))
      .expect("entry should deserialize")
    })
    .collect();
  assemble_static_search_config(&config, None, &gazetteer)
    .expect("config should assemble")
}

fn gazetteer_texts(engine: &PreparedEngine, text: &str) -> Vec<String> {
  gazetteer_entities(engine, text)
    .into_iter()
    .map(|entity| entity.text)
    .collect()
}

#[test]
fn configs_without_the_newer_gazetteer_fields_still_load() {
  const NOVAK: &[(&str, &str, &[&str])] = &[("Novák", PERSON, &[])];
  let mut json = serde_json::to_value(binding_for(None, NOVAK))
    .expect("binding config should serialize");
  let gazetteer = json
    .get_mut("gazetteer_data")
    .and_then(serde_json::Value::as_object_mut)
    .expect("gazetteer data should be present");
  gazetteer.remove("legal_form_suffixes");
  gazetteer.remove("inflection");
  gazetteer.remove("terms");
  let binding: BindingPreparedSearchConfig = serde_json::from_value(json)
    .expect("a config without the newer fields should deserialize");
  let engine = PreparedEngine::new(
    prepared_search_config_from_binding(binding)
      .expect("old-shape config should convert"),
  )
  .expect("old-shape config should prepare");
  assert_eq!(gazetteer_texts(&engine, "Předáno Novákovi."), ["Novákovi"]);
}

/// Resolved spans after label filtering, for `entries` under `labels`.
fn redacted_under_labels(
  labels: &[&str],
  entries: &[(&str, &str)],
  text: &str,
) -> Vec<(String, String)> {
  let config: PipelineConfig = serde_json::from_value(serde_json::json!({
    "threshold": 0.3,
    "enableTriggerPhrases": false,
    "enableRegex": false,
    "enableLegalForms": false,
    "enableNameCorpus": false,
    "enableDenyList": false,
    "enableGazetteer": true,
    "enableCountries": false,
    "enableConfidenceBoost": false,
    "enableCoreference": false,
    "enableZoneClassification": false,
    "labels": labels,
    "workspaceId": "gazetteer-matching-test"
  }))
  .expect("config should deserialize");
  let gazetteer: Vec<GazetteerEntry> = entries
    .iter()
    .enumerate()
    .map(|(index, (canonical, label))| {
      serde_json::from_value(serde_json::json!({
        "id": format!("gaz-{index}"),
        "canonical": canonical,
        "label": label,
        "variants": [],
        "workspaceId": "gazetteer-matching-test",
        "createdAt": 1_700_000_000_000_i64,
        "source": "manual",
      }))
      .expect("entry should deserialize")
    })
    .collect();
  let binding = assemble_static_search_config(&config, None, &gazetteer)
    .expect("config should assemble");
  let engine = PreparedEngine::new(
    prepared_search_config_from_binding(binding)
      .expect("assembled config should convert"),
  )
  .expect("pipeline should prepare");
  engine
    .redact_static_entities(text, &OperatorConfig::default())
    .expect("redaction should succeed")
    .resolved_entities
    .into_iter()
    .map(|entity| (entity.text, entity.label))
    .collect()
}

#[test]
fn a_spelling_under_several_labels_keeps_each_label() {
  let text = "Smlouvu podepsala Acme dnes.";
  for kept in [ORGANIZATION, PERSON] {
    for entries in [
      [("Acme", ORGANIZATION), ("Acme", PERSON)],
      [("Acme", PERSON), ("Acme", ORGANIZATION)],
    ] {
      assert_eq!(
        redacted_under_labels(&[kept], &entries, text),
        [("Acme".to_owned(), kept.to_owned())],
        "{kept} {entries:?}"
      );
    }
  }
  // Without a label filter the label is the alphabetically first, whatever
  // the entry order.
  for entries in [
    [("Acme", ORGANIZATION), ("Acme", PERSON)],
    [("Acme", PERSON), ("Acme", ORGANIZATION)],
  ] {
    assert_eq!(
      redacted_under_labels(&[], &entries, text),
      [("Acme".to_owned(), ORGANIZATION.to_owned())],
      "{entries:?}"
    );
  }
}

#[test]
fn czech_slovak_forms_follow_the_pipeline_language() {
  const ANA: &[(&str, &str, &[&str])] = &[("Ana", PERSON, &[])];
  let english = engine_for(Some("en"), ANA);
  assert!(gazetteer_texts(&english, "Is there any news?").is_empty());
  assert_eq!(gazetteer_texts(&english, "Ana arrived."), ["Ana"]);
  for language in [Some("cs"), Some("sk"), None] {
    let engine = engine_for(language, ANA);
    assert_eq!(
      gazetteer_texts(&engine, "Patří Aně."),
      ["Aně"],
      "{language:?}"
    );
    assert_eq!(
      gazetteer_texts(&engine, "Mluvil s Anou."),
      ["Anou"],
      "{language:?}"
    );
  }
}

/// Gazetteer entities a case is scored on: the detector output, or for
/// [`Class::CommonWordNames`] the resolved entities that survive into the
/// redaction.
fn case_entities(engine: &PreparedEngine, case: &Case) -> Vec<PipelineEntity> {
  if case.class != Class::CommonWordNames {
    return gazetteer_entities(engine, case.text);
  }
  engine
    .redact_static_entities(case.text, &OperatorConfig::default())
    .expect("redaction should succeed")
    .resolved_entities
    .into_iter()
    .filter(|entity| entity.source == DetectionSource::Gazetteer)
    .collect()
}

fn gazetteer_entities(
  engine: &PreparedEngine,
  text: &str,
) -> Vec<PipelineEntity> {
  engine
    .detect_static_entities(text)
    .expect("detection should succeed")
    .entities
    .all_entities()
    .into_iter()
    .filter(|entity| entity.source == DetectionSource::Gazetteer)
    .collect()
}

fn byte_range(text: &str, probe: &str) -> (u32, u32) {
  let start = text.find(probe).expect("probe should occur in case text");
  let end = start.saturating_add(probe.len());
  (
    u32::try_from(start).expect("offset fits"),
    u32::try_from(end).expect("offset fits"),
  )
}

/// Whether some gazetteer entity covers the labeled name, however far it
/// reaches past it. Informational: separates missed names from overreach.
fn case_covered(engine: &PreparedEngine, case: &Case) -> bool {
  let Expect::Exact(name) = case.expect else {
    return false;
  };
  let (name_start, name_end) = byte_range(case.text, name);
  case_entities(engine, case)
    .iter()
    .any(|entity| entity.start <= name_start && entity.end >= name_end)
}

/// Outcome of one case: `true` when the gazetteer behaved as labeled.
fn case_passes(engine: &PreparedEngine, case: &Case) -> bool {
  let entities = case_entities(engine, case);
  let (probe_start, probe_end) = byte_range(case.text, case.probe);
  let overlapping: Vec<&PipelineEntity> = entities
    .iter()
    .filter(|entity| entity.start < probe_end && entity.end > probe_start)
    .collect();
  match case.expect {
    Expect::Nothing => overlapping.is_empty(),
    Expect::Exact(name) => {
      // Overlapping entries may report a shorter sub-span that resolution
      // later merges away, but none may reach past the name.
      let (name_start, name_end) = byte_range(case.text, name);
      overlapping
        .iter()
        .any(|entity| entity.start == name_start && entity.end == name_end)
        && overlapping
          .iter()
          .all(|entity| entity.start >= name_start && entity.end <= name_end)
    }
  }
}

#[test]
fn gazetteer_matching_table() {
  let engine = engine();
  let mut report = vec![format!(
    "{:<14} {:>6} {:>8} {:>6}",
    "class", "pass", "covered", "total"
  )];
  let mut failures = Vec::new();
  for class in Class::ALL {
    let cases: Vec<&Case> =
      CASES.iter().filter(|case| case.class == class).collect();
    let mut passed = 0_usize;
    let mut covered = 0_usize;
    for case in &cases {
      if case_covered(&engine, case) {
        covered = covered.saturating_add(1);
      }
      if case_passes(&engine, case) {
        passed = passed.saturating_add(1);
      } else {
        failures.push(format!(
          "{class:?}: {:?} in {:?} -> {:?}",
          case.probe,
          case.text,
          gazetteer_entities(&engine, case.text)
            .iter()
            .map(|entity| entity.text.clone())
            .collect::<Vec<_>>()
        ));
      }
    }
    report.push(format!(
      "{:<14} {passed:>6} {covered:>8} {:>6}",
      format!("{class:?}"),
      cases.len()
    ));
  }
  assert!(
    failures.is_empty(),
    "{}\n{}",
    report.join("\n"),
    failures.join("\n")
  );
}
