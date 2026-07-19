// Declined Czech/Slovak person names must be detected
// across the full case paradigm (genitive, dative,
// accusative, vocative, locative, instrumental) for
// masculine and feminine first-name + surname pairs.
// Regression: "Smlouva s Janem Novákem." (instrumental)
// previously yielded zero person entities because the
// deny-list AC patterns carried only nominative forms.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { Dictionaries, PipelineConfig } from "../types";
import { detectNative } from "./native-detect";
import { loadTestDictionaries } from "./load-dictionaries";

setDefaultTimeout(15_000);

const CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: true,
  enableDenyList: true,
  enableGazetteer: false,
  enableConfidenceBoost: true,
  enableCoreference: true,
  enableHotwordRules: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "cs-declension-test",
};

let cachedDictionaries: Dictionaries | undefined;
const detect = async (text: string) => {
  cachedDictionaries ??= await loadTestDictionaries();
  return detectNative({ ...CONFIG, dictionaries: cachedDictionaries }, text);
};

/**
 * Invariant: some person entity span covers the declined
 * full name (first name + surname) inside the sentence.
 */
const expectPersonCovering = async (text: string, name: string) => {
  const entities = await detect(text);
  const start = text.indexOf(name);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = start + name.length;
  const covering = entities.filter(
    (e) => e.label === "person" && e.start <= start && e.end >= end,
  );
  expect(covering.length).toBeGreaterThan(0);
};

describe("Czech masculine declension (Jan Novák)", () => {
  test("genitive: bez Jana Nováka", () =>
    expectPersonCovering(
      "Smlouva byla uzavřena bez účasti Jana Nováka.",
      "Jana Nováka",
    ));

  test("dative: Janu Novákovi", () =>
    expectPersonCovering(
      "Rozsudek byl doručen Janu Novákovi.",
      "Janu Novákovi",
    ));

  test("accusative: pro Jana Nováka", () =>
    expectPersonCovering("Zmocněnec zastupuje Jana Nováka.", "Jana Nováka"));

  test("vocative: pane Jane Nováku", () =>
    expectPersonCovering("Vážený pane Jane Nováku, sdělujeme", "Jane Nováku"));

  test("locative: o Janovi Novákovi", () =>
    expectPersonCovering(
      "Strany jednaly o Janovi Novákovi.",
      "Janovi Novákovi",
    ));

  test("instrumental: s Janem Novákem (exact regression)", () =>
    expectPersonCovering("Smlouva s Janem Novákem.", "Janem Novákem"));

  test("instrumental: ł-final first name (s Pawełem Novákem)", () =>
    expectPersonCovering("Jednání s Pawełem Novákem.", "Pawełem Novákem"));
});

describe("Czech feminine declension (Jana Nováková)", () => {
  test("uppercase short surname from prepared package", () =>
    expectPersonCovering("Smlouvu podepsala Anna NOVÁ.", "Anna NOVÁ"));

  test("genitive: podpis Jany Novákové", () =>
    expectPersonCovering(
      "Listina obsahuje podpis Jany Novákové.",
      "Jany Novákové",
    ));

  test("dative: Janě Novákové", () =>
    expectPersonCovering(
      "Výpověď byla doručena Janě Novákové.",
      "Janě Novákové",
    ));

  test("accusative: pro Janu Novákovou", () =>
    expectPersonCovering(
      "Advokát zastupuje Janu Novákovou.",
      "Janu Novákovou",
    ));

  test("vocative: paní Jano Nováková", () =>
    expectPersonCovering(
      "Vážená paní Jano Nováková, sdělujeme",
      "Jano Nováková",
    ));

  test("locative: o Janě Novákové", () =>
    expectPersonCovering("Soud rozhodl o Janě Novákové.", "Janě Novákové"));

  test("instrumental: s Janou Novákovou", () =>
    expectPersonCovering(
      "Dohoda byla podepsána s Janou Novákovou.",
      "Janou Novákovou",
    ));
});

describe("Slovak masculine declension (Ján Kováč)", () => {
  test("genitive: od Jána Kováča", () =>
    expectPersonCovering("Zmluva bola prijatá od Jána Kováča.", "Jána Kováča"));

  test("dative: Jánovi Kováčovi", () =>
    expectPersonCovering(
      "Rozsudok bol doručený Jánovi Kováčovi.",
      "Jánovi Kováčovi",
    ));

  test("accusative: pre Jána Kováča", () =>
    expectPersonCovering("Advokát zastupuje Jána Kováča.", "Jána Kováča"));

  test("locative: o Jánovi Kováčovi", () =>
    expectPersonCovering(
      "Strany rokovali o Jánovi Kováčovi.",
      "Jánovi Kováčovi",
    ));

  test("instrumental: s Jánom Kováčom", () =>
    expectPersonCovering("Zmluva s Jánom Kováčom.", "Jánom Kováčom"));
});

describe("Slovak feminine declension (Jana Kováčová)", () => {
  test("genitive: od Jany Kováčovej", () =>
    expectPersonCovering(
      "Zmluva bola prijatá od Jany Kováčovej.",
      "Jany Kováčovej",
    ));

  test("dative: Jane Kováčovej", () =>
    expectPersonCovering(
      "Rozsudok bol doručený Jane Kováčovej.",
      "Jane Kováčovej",
    ));

  test("accusative: pre Janu Kováčovú", () =>
    expectPersonCovering("Advokát zastupuje Janu Kováčovú.", "Janu Kováčovú"));

  test("locative: o Jane Kováčovej", () =>
    expectPersonCovering("Súd rozhodol o Jane Kováčovej.", "Jane Kováčovej"));

  test("instrumental: s Janou Kováčovou", () =>
    expectPersonCovering("Zmluva s Janou Kováčovou.", "Janou Kováčovou"));
});

describe("adjectival and fleeting-e surnames", () => {
  test("masculine -ý instrumental: s Petrem Veselým", () =>
    expectPersonCovering(
      "Dodatek byl sjednán s Petrem Veselým.",
      "Petrem Veselým",
    ));

  test("masculine -ý genitive: bez Petra Veselého", () =>
    expectPersonCovering(
      "Jednání proběhlo bez Petra Veselého.",
      "Petra Veselého",
    ));

  test("fleeting -ek instrumental: s Markem Novákem", () =>
    expectPersonCovering(
      "Zápis byl pořízen s Markem Novákem.",
      "Markem Novákem",
    ));

  test("soft stem genitive: od Tomáše Němce", () =>
    expectPersonCovering("Plná moc od Tomáše Němce.", "Tomáše Němce"));
});
