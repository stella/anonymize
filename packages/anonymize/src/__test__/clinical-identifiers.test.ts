import { describe, expect, test } from "bun:test";

import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";

const SUPPORTED_LANGUAGES = [
  "cs",
  "de",
  "en",
  "es",
  "fr",
  "hu",
  "it",
  "pl",
  "pt-br",
  "ro",
  "sk",
  "sv",
] as const;

const CLINICAL_IDENTIFIER_FAMILIES = [
  "medical-record-number",
  "patient-number",
  "health-card-number",
] as const;

type TriggerEntry = {
  id?: unknown;
  label?: unknown;
  strategy?: { type?: unknown };
  triggers?: unknown;
  validations?: Array<{ type?: unknown }>;
};

const loadLanguageTriggers = async (
  language: (typeof SUPPORTED_LANGUAGES)[number],
): Promise<TriggerEntry[]> => {
  const value: unknown = await Bun.file(
    new URL(
      `../../../../packages/data/config/triggers.${language}.json`,
      import.meta.url,
    ),
  ).json();
  if (!Array.isArray(value)) {
    throw new TypeError(`triggers.${language}.json must contain an array`);
  }
  return value as TriggerEntry[];
};

const BASE_CONFIG: PipelineConfig = {
  threshold: 0.5,
  enableTriggerPhrases: true,
  enableRegex: false,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["registration number"],
  workspaceId: "clinical-identifiers-test",
};

const detect = (
  language: string,
  fullText: string,
): Promise<NativePipelineEntity[]> =>
  detectNative({ ...BASE_CONFIG, languages: [language] }, fullText);

const POSITIVE_FIXTURES = [
  [
    "cs",
    "Číslo zdravotnické dokumentace: 482731. Číslo pacienta: 639204. Číslo průkazu pojištěnce: 770315.",
  ],
  [
    "de",
    "Krankenaktennummer: 482731. Patientennummer: 639204. Krankenversichertennummer: 770315.",
  ],
  [
    "en",
    "Medical record number: 482731. Patient number: 639204. Health insurance card number: 770315.",
  ],
  [
    "es",
    "Número de historia clínica: 482731. Número de paciente: 639204. Número de tarjeta sanitaria: 770315.",
  ],
  [
    "fr",
    "Numéro de dossier médical : 482731. Numéro de patient : 639204. Numéro de carte d’assurance maladie : 770315.",
  ],
  ["hu", "Kórlapszám: 482731. Betegazonosító szám: 639204. TAJ-szám: 770315."],
  [
    "it",
    "Numero di cartella clinica: 482731. Numero paziente: 639204. Numero della tessera sanitaria: 770315.",
  ],
  [
    "pl",
    "Numer dokumentacji medycznej: 482731. Numer pacjenta: 639204. Numer karty ubezpieczenia zdrowotnego: 770315.",
  ],
  [
    "pt-br",
    "Número do prontuário médico: 482731. Número do paciente: 639204. Número do Cartão Nacional de Saúde: 770315.",
  ],
  [
    "ro",
    "Numărul dosarului medical: 482731. Număr pacient: 639204. Numărul cardului național de sănătate: 770315.",
  ],
  [
    "sk",
    "Číslo zdravotnej dokumentácie: 482731. Číslo pacienta: 639204. Číslo preukazu poistenca: 770315.",
  ],
  [
    "sv",
    "Journalnummer: 482731. Patientnummer: 639204. Sjukförsäkringskortets nummer: 770315.",
  ],
] as const;

const NEGATIVE_FIXTURES = [
  ["cs", "Číslo pacienta: neuvedeno."],
  ["de", "Krankenaktennummer: unbekannt."],
  ["en", "Health insurance card number: unavailable."],
  ["es", "Número de paciente: desconocido."],
  ["fr", "Numéro de dossier médical : inconnu."],
  ["hu", "Betegazonosító szám: ismeretlen."],
  ["it", "Numero paziente: sconosciuto."],
  ["pl", "Numer pacjenta: nieznany."],
  ["pt-br", "Número do paciente: indisponível."],
  ["ro", "Număr pacient: necunoscut."],
  ["sk", "Číslo pacienta: neuvedené."],
  ["sv", "Patientnummer: okänt."],
] as const;

const LANGUAGE_ISOLATION_FIXTURES = POSITIVE_FIXTURES.map(
  ([language], index) => {
    const foreign = POSITIVE_FIXTURES[(index + 1) % POSITIVE_FIXTURES.length];
    if (!foreign) {
      throw new TypeError("clinical language-isolation fixture is missing");
    }
    return [language, foreign[1]] as const;
  },
);

const EXACT_LIMIT_IDENTIFIER = Array.from({ length: 43 }, () => "12").join(" ");
const NEAR_LIMIT_IDENTIFIER = Array.from({ length: 42 }, () => "12").join(" ");

const ALPHANUMERIC_FIXTURES = [
  ["en", `Patient number: ${EXACT_LIMIT_IDENTIFIER}`, EXACT_LIMIT_IDENTIFIER],
  [
    "en",
    `Patient number: ${EXACT_LIMIT_IDENTIFIER}, next`,
    EXACT_LIMIT_IDENTIFIER,
  ],
  [
    "en",
    `Patient number: ${EXACT_LIMIT_IDENTIFIER} confirmed`,
    EXACT_LIMIT_IDENTIFIER,
  ],
  [
    "en",
    `Patient number: ${EXACT_LIMIT_IDENTIFIER} follow-up`,
    EXACT_LIMIT_IDENTIFIER,
  ],
  [
    "en",
    `Patient number: ${NEAR_LIMIT_IDENTIFIER}   confirmed`,
    NEAR_LIMIT_IDENTIFIER,
  ],
  ["en", "Medical record number: ABCD-12345.", "ABCD-12345"],
  ["de", "Patientennummer: 12345-ABCD.", "12345-ABCD"],
  ["cs", "Číslo průkazu pojištěnce: AB12/345.XY.", "AB12/345.XY"],
  ["en", "Patient number: ABCD123 CD456“", "ABCD123 CD456"],
  ["en", "Patient number: ABCD123 CD-456.", "ABCD123 CD-456"],
  ["en", "Patient number: ABCD123 456.", "ABCD123 456"],
  ["en", "Patient number: ABCD123 456 789.", "ABCD123 456 789"],
  ["en", "Patient number: ABCD123 67.", "ABCD123 67"],
  ["en", "Patient number: ABCD123 678.", "ABCD123 678"],
  ["en", "Patient number: ABCD123 6789.", "ABCD123 6789"],
  ["en", "Patient number: ABCD123 2025.", "ABCD123 2025"],
  ["en", "Patient number: ABCD123 67890.", "ABCD123 67890"],
  ["en", "Patient number: ABCD123 456A.", "ABCD123 456A"],
  ["en", "Patient number: ABCD123 456ABCD.", "ABCD123 456ABCD"],
  ["en", "Patient number: ABCD123 ABCD456.", "ABCD123 ABCD456"],
  ["en", "Patient number: ABCD123 456ABCDEFGHIJKL.", "ABCD123 456ABCDEFGHIJKL"],
  ["en", "Patient number: ABCD123 ABCDEFGHIJKL456.", "ABCD123 ABCDEFGHIJKL456"],
  ["en", "Patient number: ABCD123 ABCD-456.", "ABCD123 ABCD-456"],
  ["en", "Patient number: 123-45 67.", "123-45 67"],
  ["en", "Patient number: 123-45 678.", "123-45 678"],
  ["en", "Patient number: 123-45 6789.", "123-45 6789"],
  ["en", "Patient number: 123-45 2025.", "123-45 2025"],
  ["en", "Patient number: 123-45 67890.", "123-45 67890"],
  ["en", "Patient number: 123-45 456A.", "123-45 456A"],
  ["en", "Patient number: 123-45 456ABCD.", "123-45 456ABCD"],
  ["en", "Patient number: 123-45 ABCD456.", "123-45 ABCD456"],
  ["en", "Patient number: 123-45 ABCD-456.", "123-45 ABCD-456"],
  ["en", "Patient number: 123-45 456-A.", "123-45 456-A"],
  ["en", "Patient number: 197-38 269.", "197-38 269"],
  ["en", "Patient number: 123/45 6789.", "123/45 6789"],
  ["en", "Patient number: 123.45 6789.", "123.45 6789"],
  ["en", "Patient number: ABCDEFGHIJKL123 456.", "ABCDEFGHIJKL123 456"],
  ["en", "Patient number: ABCD123 456-789.", "ABCD123 456-789"],
  ["en", "Patient number: 12345 67/89.", "12345 67/89"],
  ["en", "Patient number: ABCD123 123-45-6789.", "ABCD123 123-45-6789"],
  ["en", "Patient number: ABCD123 2025-07/23.", "ABCD123 2025-07/23"],
  ["en", "Patient number: ABCD123 23.07/2025.", "ABCD123 23.07/2025"],
  ["en", "Patient number: ABCD123 2025-0007-00023.", "ABCD123 2025-0007-00023"],
  ["en", "Patient number: ABCD123 0001-0002-0003.", "ABCD123 0001-0002-0003"],
  ["en", "Patient number: ABCD123 2025-07-23Tfoo.", "ABCD123 2025-07-23Tfoo"],
  [
    "en",
    "Patient number: ABCD123 2025-07-23T12T34.",
    "ABCD123 2025-07-23T12T34",
  ],
  ["en", "Patient number: ABCD123 2025-07-23T1.", "ABCD123 2025-07-23T1"],
  ["en", "Patient number: ABCD123 2025-07-23T123.", "ABCD123 2025-07-23T123"],
  [
    "en",
    "Patient number: ABCD123 2025-07-23T12345.",
    "ABCD123 2025-07-23T12345",
  ],
  [
    "en",
    "Patient number: ABCD123 2025-07-23T1234567.",
    "ABCD123 2025-07-23T1234567",
  ],
  [
    "en",
    "Patient number: ABCD123 2025-07-23T123456789.",
    "ABCD123 2025-07-23T123456789",
  ],
  ["en", "Patient number: AB12 345.", "AB12 345"],
  ["en", "Patient number: AB12 345 8901.", "AB12 345 8901"],
  ["en", "Patient number: AB-12 345.", "AB-12 345"],
  ["en", "Patient number: FR A1 123 456.", "FR A1 123 456"],
  ["en", "Patient number: FR A1 123 456 8901.", "FR A1 123 456 8901"],
  ["en", "Patient number: 197 38 269.", "197 38 269"],
  ["en", "Patient number: 78 123 456 789.", "78 123 456 789"],
  ["en", "Patient number: 197\t38\t269.", "197\t38\t269"],
  ["en", "Patient number: 482 731.", "482 731"],
  ["en", "Patient number: 78 123.", "78 123"],
] as const;

const PARTIAL_REDACTION_FIXTURES = [
  ["en", `Patient number: ${EXACT_LIMIT_IDENTIFIER}3.`],
  ["en", `Patient number: ${EXACT_LIMIT_IDENTIFIER}A2.`],
  ["en", `Patient number: ${EXACT_LIMIT_IDENTIFIER} 34.`],
  ["en", `Patient number: ${EXACT_LIMIT_IDENTIFIER} page2.`],
  ["en", `Patient number: ${EXACT_LIMIT_IDENTIFIER}_tail.`],
  ["en", `Patient number: ${EXACT_LIMIT_IDENTIFIER} -tail.`],
  ["en", `Patient number: ${EXACT_LIMIT_IDENTIFIER} (v2).`],
  ["en", `Patient number: ${NEAR_LIMIT_IDENTIFIER}   34.`],
  [
    "en",
    `Patient number: ${Array.from({ length: 44 }, () => "12").join(" ")}.`,
  ],
  ["en", "Patient number: ABCD-12345_tail."],
  ["de", "Krankenaktennummer: 12345-."],
  ["sv", `Journalnummer: AB-${"1".repeat(129)}.`],
  ["en", "Patient number: ABCD123 CD456_tail."],
  ["en", "Patient number: ABCD123 CD-."],
  ["en", "Patient number: ABCD123 CD_456."],
  ["en", "Patient number: ABCD123 _CD456."],
  ["en", "Patient number: 197 38 269_tail."],
  ["en", "Patient number: 197 38 269-."],
  ["en", "Patient number: 197 38 269_."],
  ["en", "Patient number: 1 2025 12."],
  ["en", "Patient number: 1 1234 12."],
  ["en", "Patient number: 12345 67 8."],
  ["en", "Patient number: 12345 67 8901."],
  ["en", "Patient number: 12345 67 89_tail."],
  ["en", "Patient number: 482 731 8."],
  ["en", "Patient number: AB12 345 8."],
  ["en", "Patient number: ABCD123 456 8."],
  ["en", "Patient number: ABCD123 456 789_tail."],
  ["en", "Patient number: ABCD123 4567 8."],
  ["en", "Patient number: ABCD123 8."],
  ["en", "Patient number: 123-45 8."],
  ["en", "Patient number: 123-45 6789 8."],
  ["en", "Patient number: ABCD123 456A 8."],
  ["en", "Patient number: 123-45 ABCD456 _678."],
  ["en", "Patient number: ABCD123 456_A."],
  ["en", "Patient number: ABCD123 456ABCDEFGHIJKLM."],
  ["en", "Patient number: 123-45 ABCDEFGHIJKLM456."],
  ["en", "Patient number: ABCD123 ABCDEFGHIJKLM-456."],
  ["en", "Patient number: 123-45 67_tail."],
  ["en", "Patient number: 123-45 _678."],
  ["en", `Patient number: 123-45 ${"1".repeat(129)}.`],
  ["en", "Patient number: FR A1 123 456 8."],
  ["en", "Patient number: 197 38 269 8."],
  ["en", "Patient number: 197 38 269 8901."],
  ["en", "Patient number: 197 38 269 1000."],
  ["en", "Patient number: 197 38 269 1899."],
  ["en", "Patient number: 197 38 269 2100."],
  ["en", "Patient number: 197 38 269 2999."],
  ["en", "Patient number: ABCD123\u2013456."],
  ["en", "Patient number: ABCD123\u2013É456."],
  ["en", "Patient number: ABCD123\u2011٦."],
  ["en", "Patient number: 197\u201138\u2011269."],
  ["en", "Patient number: ABCD123(6)."],
  ["en", "Patient number: ABCD123(٦)."],
  ["en", "Patient number: ABCD123(É456)."],
  ["en", "Patient number: ABCD123(v2)."],
  ["en", "Patient number: ABCD123(a2)."],
  ["en", "Patient number: ABCD123[v2]."],
  ["en", "Patient number: ABCD123{a2}."],
  ["en", "Patient number: ABCD123[6]."],
  ["en", "Patient number: ABCD123{6}."],
  ["en", "Patient number: ABCD123\u2014É456."],
  ["en", "Patient number: ABCD123\u2014456."],
  ["en", "Patient number: ABCD123\u2014v2."],
  ["en", "Patient number: ABCD123\u2013confirmed."],
  ["en", 'Patient number: ABCD123"456.'],
  ["en", "Patient number: ABCD123“456."],
  ["en", "Patient number: ABCD123“É٤56."],
  ["en", "Patient number: ABCD123'v2."],
] as const;

const IMMEDIATE_BOUNDARY_FIXTURES = [
  ["(active)"],
  ["[active]"],
  ["{active}"],
  ["\u2010 "],
  ["\u2011,"],
  ["\u2012."],
  ["\u2013 "],
  ["\u2014confirmed"],
  ["\u2015confirmed"],
  ["\u2026prose"],
  ["“confirmed"],
  ["“, next"],
] as const;

const INVALID_IMMEDIATE_BOUNDARY_FIXTURES = [
  ["_"],
  ["-"],
  ["/"],
  ["é"],
  ["Ж"],
] as const;

const STOP_BEFORE_PROSE_FIXTURES = [
  ["Patient number: 12345 2.", "12345"],
  ["Patient number: 12345 67.", "12345"],
  ["Patient number: 12345 456.", "12345"],
  ["Patient number: 12345 6789.", "12345"],
  ["Patient number: 12345 2025.", "12345"],
  ["Patient number: 12345 67890.", "12345"],
  ["Patient number: 197 38 269 2025.", "197 38 269"],
  ["Patient number: 197 38 269 1900.", "197 38 269"],
  ["Patient number: 197 38 269 2099.", "197 38 269"],
  ["Patient number: ABCD123 page2.", "ABCD123"],
  ["Patient number: 123-45 page2.", "123-45"],
  ["Patient number: 12345 2025-07-23.", "12345"],
  ["Patient number: 12345 2025-07-23T12:00.", "12345"],
  ["Patient number: 12345 23/07/2025T9:30.", "12345"],
  ["Patient number: 12345 2025-07-23t123456.", "12345"],
  ["Patient number: 12345 2025-07-23T12.", "12345"],
  ["Patient number: 12345 2025-07-23T1234.", "12345"],
  ["Patient number: 12345 2025-07-23T123456Z.", "12345"],
  ["Patient number: 12345 2025-07-23T123456z.", "12345"],
  ["Patient number: 12345 2025-07-23T123456.789Z.", "12345"],
  ["Patient number: 12345 2025-07-23T123456-05:00.", "12345"],
  ["Patient number: 12345 2025-07-23T123456-0500.", "12345"],
  ["Patient number: 12345 2025-07-23T123456.789-05:00.", "12345"],
  ["Patient number: 12345 2025-07-23T123456.789-0500.", "12345"],
  ["Patient number: 12345 23/07/2025.", "12345"],
  ["Patient number: 12345 07/23/2025.", "12345"],
  ["Patient number: 12345 23/07/25.", "12345"],
  ["Patient number: 12345 07/23/25.", "12345"],
  ["Patient number: 12345 2023-02-29.", "12345"],
  ["Patient number: 12345 2025-04-31.", "12345"],
  ["Patient number: 12345 2025-13-01.", "12345"],
  ["Patient number: 12345 1900-02-29.", "12345"],
  ["Patient number: ABCD123 2nd.", "ABCD123"],
  ["Patient number: 12345 e.g. above.", "12345"],
  ["Patient number: 12345 ref-code.", "12345"],
  ["Patient number: 12345 next-field.", "12345"],
  ["Patient number: 12345 field_name.", "12345"],
  ["Patient number: ABCD123 _section.", "ABCD123"],
  ["Patient number: AB123 CD/EF.", "AB123"],
] as const;

describe("multilingual clinical identifiers", () => {
  test("covers every clinical identifier family in every supported language", async () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const entries = await loadLanguageTriggers(language);
      const entriesById = new Map(entries.map((entry) => [entry.id, entry]));

      for (const family of CLINICAL_IDENTIFIER_FAMILIES) {
        const id = `${language}-clinical-${family}`;
        const entry = entriesById.get(id);
        expect(entry, `${id} is missing`).toBeDefined();
        expect(entry?.label).toBe("registration number");
        expect(entry?.strategy?.type).toBe("company-id-value");
        expect(entry?.triggers).toBeArray();
        expect((entry?.triggers as unknown[])?.length).toBeGreaterThan(0);
        expect(entry?.validations).toContainEqual({ type: "has-digits" });
      }
    }
  });

  test.each(POSITIVE_FIXTURES)(
    "%s detects invented record, patient, and health-card identifiers",
    async (language, text) => {
      const entities = await detect(language, text);
      const values = entities
        .filter((entity) => entity.label === "registration number")
        .map((entity) => entity.text);

      expect(values).toEqual(
        expect.arrayContaining(["482731", "639204", "770315"]),
      );
    },
  );

  test.each(NEGATIVE_FIXTURES)(
    "%s rejects a clinical identifier without digits",
    async (language, text) => {
      expect(await detect(language, text)).toEqual([]);
    },
  );

  test.each(LANGUAGE_ISOLATION_FIXTURES)(
    "%s excludes another language's clinical triggers",
    async (language, foreignText) => {
      expect(await detect(language, foreignText)).toEqual([]);
    },
  );

  test.each(ALPHANUMERIC_FIXTURES)(
    "%s consumes a complete alphanumeric clinical identifier",
    async (language, text, expected) => {
      const values = (await detect(language, text))
        .filter((entity) => entity.label === "registration number")
        .map((entity) => entity.text);

      expect(values).toContain(expected);
    },
  );

  test("preserves structured identifier state across later numeric groups", async () => {
    for (const prefix of ["123-45", "123/45", "123.45", "ABCD123"]) {
      for (const finalGroup of ["67", "678", "6789", "67890"]) {
        const value = `${prefix} 111 222 ${finalGroup}`;
        const values = (await detect("en", `Patient number: ${value}, next`))
          .filter((entity) => entity.label === "registration number")
          .map((entity) => entity.text);

        expect(values).toEqual([value]);
      }

      const yearValue = `${prefix} 111 222 2025`;
      const yearValues = (
        await detect("en", `Patient number: ${yearValue}, next`)
      )
        .filter((entity) => entity.label === "registration number")
        .map((entity) => entity.text);
      expect(yearValues).toEqual([yearValue]);

      for (const malformedTail of [
        "111 222 67 8",
        "111 222 67 _89",
        "111 222 67_tail",
        `111 222 67 ${"1".repeat(129)}`,
      ]) {
        expect(
          await detect("en", `Patient number: ${prefix} ${malformedTail}`),
        ).toEqual([]);
      }
    }

    for (const value of ["123-45 678 901", "197-38 269 123"]) {
      const values = (await detect("en", `Patient number: ${value}.`))
        .filter((entity) => entity.label === "registration number")
        .map((entity) => entity.text);
      expect(values).toEqual([value]);
    }
  });

  test.each(PARTIAL_REDACTION_FIXTURES)(
    "%s rejects a partial clinical identifier",
    async (language, text) => {
      expect(await detect(language, text)).toEqual([]);
    },
  );

  test.each(IMMEDIATE_BOUNDARY_FIXTURES)(
    "accepts an identifier before the immediate %s prose boundary",
    async (suffix) => {
      const values = (await detect("en", `Patient number: ABCD123${suffix}`))
        .filter((entity) => entity.label === "registration number")
        .map((entity) => entity.text);

      expect(values).toEqual(["ABCD123"]);
    },
  );

  test.each(INVALID_IMMEDIATE_BOUNDARY_FIXTURES)(
    "rejects an identifier before the immediate %s identifier boundary",
    async (boundary) => {
      expect(await detect("en", `Patient number: ABCD123${boundary}`)).toEqual(
        [],
      );
    },
  );

  test.each(STOP_BEFORE_PROSE_FIXTURES)(
    "stops %s at the complete identifier %s",
    async (text, expected) => {
      const values = (await detect("en", text))
        .filter((entity) => entity.label === "registration number")
        .map((entity) => entity.text);

      expect(values).toEqual([expected]);
    },
  );

  test("bounds grouped numeric identifier scanning", async () => {
    const overlongProse = "a".repeat(129);
    const stopped = (
      await detect("en", `Patient number: 12345 ${overlongProse}`)
    )
      .filter((entity) => entity.label === "registration number")
      .map((entity) => entity.text);
    expect(stopped).toEqual(["12345"]);

    for (const continuation of [
      "1".repeat(129),
      `${"a".repeat(64)}1${"a".repeat(64)}`,
      `${"a".repeat(64)}-${"a".repeat(64)}`,
    ]) {
      expect(
        await detect("en", `Patient number: 12345 ${continuation}`),
      ).toEqual([]);
    }

    const exactLimit = Array.from({ length: 43 }, () => "12").join(" ");
    expect(exactLimit).toHaveLength(128);
    const accepted = (await detect("en", `Patient number: ${exactLimit}`))
      .filter((entity) => entity.label === "registration number")
      .map((entity) => entity.text);
    expect(accepted).toEqual([exactLimit]);

    for (const value of [
      Array.from({ length: 44 }, () => "12").join(" "),
      Array.from({ length: 10_000 }, () => "12").join(" "),
    ]) {
      expect(await detect("en", `Patient number: ${value}`)).toEqual([]);
    }
  });
});
