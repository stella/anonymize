import { describe, expect, test } from "bun:test";

import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative, redactNative } from "./native-detect";

const CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: false,
  enableRegex: true,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "deterministic-identifier-gaps-test",
};

const detect = async (fullText: string): Promise<NativePipelineEntity[]> =>
  detectNative(CONFIG, fullText);

describe("deterministic identifier gap regexes", () => {
  test("crypto wallet addresses are detected as crypto identifiers", async () => {
    const entities = await detect(
      [
        "ETH wallet 0x742d35Cc6634C0532925a3b844Bc454e4438f44e.",
        "BTC wallet 1BoatSLRHtKNngkdXEeobR76b53LETtpyT.",
        "Bitcoin address 1BoatSLRHtKNngkdXEeobR76b53LETtpyT was copied.",
        "Bitcoin address BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4.",
      ].join("\n"),
    );

    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "crypto",
          text: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        }),
        expect.objectContaining({
          label: "crypto",
          text: "BTC wallet 1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
        }),
        expect.objectContaining({
          label: "crypto",
          text: "Bitcoin address 1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
        }),
        expect.objectContaining({
          label: "crypto",
          text: "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",
        }),
      ]),
    );
  });

  test("contextual passport numbers cover US, UK, and generic letter forms", async () => {
    const entities = await detect(
      [
        "US passport number X12345678 was inspected.",
        "UK passport no 123456789 was copied.",
        "Passport No. A1234567 was listed on the form.",
        "French passport number 12AB34567 was checked.",
      ].join("\n"),
    );

    const passportTexts = entities
      .filter((entity) => entity.label === "passport number")
      .map((entity) => entity.text);
    expect(passportTexts).toEqual(
      expect.arrayContaining([
        "US passport number X12345678",
        "UK passport no 123456789",
        "Passport No. A1234567",
        "French passport number 12AB34567",
      ]),
    );
  });

  test("UK NHS numbers require context and a valid checksum", async () => {
    const entities = await detect(
      [
        "NHS number 401 023 2137 was present.",
        "NHS No. 401 023 2137 was also present.",
        "National Health Service No. 401 023 2137 was repeated.",
        "National Health Service # 401 023 2137 was repeated again.",
        "NHS number 401 023 2138 was a typo.",
      ].join("\n"),
    );

    expect(entities).toContainEqual(
      expect.objectContaining({
        label: "national identification number",
        text: "NHS number 401 023 2137",
      }),
    );
    expect(entities).toContainEqual(
      expect.objectContaining({
        label: "national identification number",
        text: "NHS No. 401 023 2137",
      }),
    );
    expect(entities).toContainEqual(
      expect.objectContaining({
        label: "national identification number",
        text: "National Health Service No. 401 023 2137",
      }),
    );
    expect(entities).toContainEqual(
      expect.objectContaining({
        label: "national identification number",
        text: "National Health Service # 401 023 2137",
      }),
    );
    expect(
      entities.some((entity) => entity.text.includes("401 023 2138")),
    ).toBe(false);
  });

  test("contextual ID and registration gaps are detected", async () => {
    const entities = await detect(
      [
        "CNI: 12AB34567 was attached.",
        "CNI nº 12AB34567 was attached.",
        "Carte Nationale D’Identité n° 12AB34567 was attached.",
        "Cyprus TIC: 12345678X was recorded.",
        "Cypriot ID card no 123456 was copied.",
        "UK driving licence MORGA657054SM9IJ was verified.",
        "UK driving licence LEE99706030J99AB was verified.",
        "CA driver license no D1234567 was scanned.",
        "CA driver’s license no D1234567 was scanned.",
        "GMC number: 1234567 was checked.",
        "NMC PIN 12A3456B was checked.",
      ].join("\n"),
    );

    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "identity card number",
          text: "CNI: 12AB34567",
        }),
        expect.objectContaining({
          label: "identity card number",
          text: "CNI nº 12AB34567",
        }),
        expect.objectContaining({
          label: "identity card number",
          text: "Carte Nationale D’Identité n° 12AB34567",
        }),
        expect.objectContaining({
          label: "tax identification number",
          text: "Cyprus TIC: 12345678X",
        }),
        expect.objectContaining({
          label: "identity card number",
          text: "Cypriot ID card no 123456",
        }),
        expect.objectContaining({
          label: "identity card number",
          text: "UK driving licence MORGA657054SM9IJ",
        }),
        expect.objectContaining({
          label: "identity card number",
          text: "UK driving licence LEE99706030J99AB",
        }),
        expect.objectContaining({
          label: "identity card number",
          text: "CA driver license no D1234567",
        }),
        expect.objectContaining({
          label: "identity card number",
          text: "CA driver’s license no D1234567",
        }),
        expect.objectContaining({
          label: "registration number",
          text: "GMC number: 1234567",
        }),
        expect.objectContaining({
          label: "registration number",
          text: "NMC PIN 12A3456B",
        }),
      ]),
    );
  });

  test("equivalent crypto spellings share placeholders", async () => {
    const fullText = [
      "ETH wallet 0x742d35Cc6634C0532925a3b844Bc454e4438f44e.",
      "ETH wallet 0x742d35cc6634c0532925a3b844bc454e4438f44e.",
      "BTC wallet BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4.",
      "BTC wallet bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4.",
      "BTC wallet 1BoatSLRHtKNngkdXEeobR76b53LETtpyT.",
      "BTC wallet 1BoatSLRHtKNngkdXEeobR76b53LETtpyt.",
    ].join("\n");

    const {
      redaction: { redactedText, redactionMap },
    } = await redactNative(CONFIG, fullText);

    expect(redactedText).toContain(
      "ETH wallet [CRYPTO_1].\nETH wallet [CRYPTO_1].",
    );
    expect(redactedText).toContain(
      "BTC wallet [CRYPTO_2].\nBTC wallet [CRYPTO_2].",
    );
    expect(redactedText).toContain(
      "[CRYPTO_3].\nBTC wallet 1BoatSLRHtKNngkdXEeobR76b53LETtpyt.",
    );
    expect(redactionMap.size).toBe(3);
  });

  test("equivalent NHS cues share placeholders", async () => {
    const fullText = [
      "NHS number 401 023 2137 was present.",
      "NHS No. 401 023 2137 was also present.",
      "National Health Service No. 401 023 2137 was repeated.",
      "National Health Service # 401 023 2137 was repeated again.",
    ].join("\n");

    const {
      redaction: { redactedText, redactionMap },
    } = await redactNative(CONFIG, fullText);

    expect(redactedText).toContain(
      "[NATIONAL_IDENTIFICATION_NUMBER_1] was present.",
    );
    expect(redactedText).toContain(
      "[NATIONAL_IDENTIFICATION_NUMBER_1] was also present.",
    );
    expect(redactedText).toContain(
      "[NATIONAL_IDENTIFICATION_NUMBER_1] was repeated.",
    );
    expect(redactedText).toContain(
      "[NATIONAL_IDENTIFICATION_NUMBER_1] was repeated again.",
    );
    expect(redactionMap.size).toBe(1);
  });

  test("equivalent passport cues share placeholders", async () => {
    const fullText = [
      "US passport number X12345678 was inspected.",
      "Passport No. X12345678 was listed on the form.",
    ].join("\n");

    const {
      redaction: { redactedText, redactionMap },
    } = await redactNative(CONFIG, fullText);

    expect(redactedText).toContain("[PASSPORT_NUMBER_1] was inspected.");
    expect(redactedText).toContain(
      "[PASSPORT_NUMBER_1] was listed on the form.",
    );
    expect(redactionMap.size).toBe(1);
  });

  test("contextual letter identifiers accept lowercase values", async () => {
    const entities = await detect(
      [
        "Passport No. a1234567 was listed on the form.",
        "French national identity card no ab1234567 was copied.",
        "Cyprus TIC: 12345678x was recorded.",
        "UK driving licence morga657054sm9ij was verified.",
        "ca driver license no d1234567 was scanned.",
        "In driver license no D1234567 was scanned.",
        "Or driver license no D1234567 was scanned.",
        "GMC number: abc12345 was checked.",
      ].join("\n"),
    );

    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "passport number",
          text: "Passport No. a1234567",
        }),
        expect.objectContaining({
          label: "identity card number",
          text: "French national identity card no ab1234567",
        }),
        expect.objectContaining({
          label: "tax identification number",
          text: "Cyprus TIC: 12345678x",
        }),
        expect.objectContaining({
          label: "identity card number",
          text: "UK driving licence morga657054sm9ij",
        }),
        expect.objectContaining({
          label: "identity card number",
          text: "ca driver license no d1234567",
        }),
        expect.objectContaining({
          label: "identity card number",
          text: "In driver license no D1234567",
        }),
        expect.objectContaining({
          label: "identity card number",
          text: "Or driver license no D1234567",
        }),
        expect.objectContaining({
          label: "registration number",
          text: "GMC number: abc12345",
        }),
      ]),
    );
  });

  test("broad shapes do not fire without required context", async () => {
    const entities = await detect(
      [
        "The release tag was A12345678 and ticket 123456789.",
        "The license agreement number 1234567 remains public.",
        "CNI application and driver license renewal are generic nouns.",
        "The doctor 123456 note and nurse 202406 rota remain public.",
        "Reference 3KMUV89zYwKQ8Z7gkP5p2nR4sA is not a wallet.",
        "Transaction hash " +
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.",
      ].join("\n"),
    );

    expect(
      entities.some((entity) =>
        [
          "passport number",
          "crypto",
          "identity card number",
          "registration number",
        ].includes(entity.label),
      ),
    ).toBe(false);
  });

  test("ambiguous lowercase state words are not swallowed as prefixes", async () => {
    const entities = await detect(
      [
        "submitted in driver license no D1234567 keeps the preposition.",
        "renewed or driver license no D1234567 keeps the conjunction.",
      ].join("\n"),
    );

    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "identity card number",
          text: "driver license no D1234567",
        }),
      ]),
    );
    expect(
      entities.some(
        (entity) =>
          entity.text === "in driver license no D1234567" ||
          entity.text === "or driver license no D1234567",
      ),
    ).toBe(false);
  });
});
