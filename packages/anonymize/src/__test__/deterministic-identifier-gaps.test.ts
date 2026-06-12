import { describe, expect, test } from "bun:test";

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { Entity, PipelineConfig } from "../types";

const CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: false,
  enableRegex: true,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "deterministic-identifier-gaps-test",
};

let sharedCtx: ReturnType<typeof createPipelineContext> | undefined;

const getCtx = () => {
  if (!sharedCtx) sharedCtx = createPipelineContext();
  return sharedCtx;
};

const detect = async (fullText: string): Promise<Entity[]> =>
  runPipeline({
    fullText,
    config: CONFIG,
    gazetteerEntries: [],
    context: getCtx(),
  });

describe("deterministic identifier gap regexes", () => {
  test("crypto wallet addresses are detected as crypto identifiers", async () => {
    const entities = await detect(
      [
        "ETH wallet 0x742d35Cc6634C0532925a3b844Bc454e4438f44e.",
        "BTC wallet 1BoatSLRHtKNngkdXEeobR76b53LETtpyT.",
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
          text: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
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
      ]),
    );
  });

  test("UK NHS numbers require context and a valid checksum", async () => {
    const entities = await detect(
      [
        "NHS number 401 023 2137 was present.",
        "NHS number 401 023 2138 was a typo.",
      ].join("\n"),
    );

    expect(entities).toContainEqual(
      expect.objectContaining({
        label: "national identification number",
        text: "NHS number 401 023 2137",
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
        "Cyprus TIC: 12345678X was recorded.",
        "Cypriot ID card no 123456 was copied.",
        "UK driving licence MORGA657054SM9IJ was verified.",
        "CA driver license no D1234567 was scanned.",
        "GMC number: 1234567 was checked.",
      ].join("\n"),
    );

    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "identity card number",
          text: "CNI: 12AB34567",
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
          text: "CA driver license no D1234567",
        }),
        expect.objectContaining({
          label: "registration number",
          text: "GMC number: 1234567",
        }),
      ]),
    );
  });

  test("contextual letter identifiers accept lowercase values", async () => {
    const entities = await detect(
      [
        "Passport No. a1234567 was listed on the form.",
        "French national identity card no ab1234567 was copied.",
        "Cyprus TIC: 12345678x was recorded.",
        "UK driving licence morga657054sm9ij was verified.",
        "ca driver license no d1234567 was scanned.",
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
});
