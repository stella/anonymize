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

const ALPHANUMERIC_FIXTURES = [
  ["en", "Medical record number: ABCD-12345.", "ABCD-12345"],
  ["de", "Patientennummer: 12345-ABCD.", "12345-ABCD"],
  ["cs", "Číslo průkazu pojištěnce: AB12/345.XY.", "AB12/345.XY"],
] as const;

const PARTIAL_REDACTION_FIXTURES = [
  ["en", "Patient number: ABCD-12345_tail."],
  ["de", "Krankenaktennummer: 12345-."],
  ["sv", `Journalnummer: AB-${"1".repeat(129)}.`],
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

  test.each(PARTIAL_REDACTION_FIXTURES)(
    "%s rejects a partial clinical identifier",
    async (language, text) => {
      expect(await detect(language, text)).toEqual([]);
    },
  );
});
