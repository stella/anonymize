import { describe, expect, test } from "bun:test";

import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";

const config = (language = "en"): PipelineConfig => ({
  threshold: 0.3,
  enableTriggerPhrases: false,
  enableRegex: true,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["email address", "phone number"],
  language,
  workspaceId: `contact-recall-${language}`,
});

const contactEntities = async (
  text: string,
  language = "en",
): Promise<NativePipelineEntity[]> =>
  (await detectNative(config(language), text)).filter(
    ({ label }) => label === "email address" || label === "phone number",
  );

describe("contact recall", () => {
  test.each([
    "legal!notices@example.test",
    "claims/emea=urgent@xn--bcher-kva.example",
    "counsel@büro.example",
    "counsel@bu\u0308ro.example",
    "bu\u0308ro@example.test",
    "x\u0308-legal@example.test",
  ])("detects RFC-ish and internationalized email %s", async (email) => {
    expect(await contactEntities(`Send notice to ${email}.`)).toContainEqual(
      expect.objectContaining({ label: "email address", text: email }),
    );
  });

  test("detects a conservatively written English email", async () => {
    for (const email of [
      "legal.notices at example dot test",
      "Legal.Notices AT Example DOT Test",
      "legal at bu\u0308ro dot example",
    ]) {
      expect(await contactEntities(`Send notice to ${email}.`)).toContainEqual(
        expect.objectContaining({ label: "email address", text: email }),
      );
    }
  });

  test("does not leak English obfuscation vocabulary into Czech scope", async () => {
    expect(
      await contactEntities(
        "Reference legal.notices at example dot test remains prose.",
        "cs",
      ),
    ).toEqual([]);
  });

  test.each([
    "0044 20 7946 0958",
    "00 49 30 1234567",
    "+44 (20) 7946 0958",
    "+1 415 555 0132",
    "+420 212 345 678",
    "+49 30 12345678",
  ])("detects international access prefix %s", async (phone) => {
    expect(await contactEntities(`Call ${phone}.`)).toContainEqual(
      expect.objectContaining({ label: "phone number", text: phone }),
    );
  });

  test.each(["(212) 555-0142", "1-415-555-0132", "415.555.0132"])(
    "detects structurally valid NANP number %s",
    async (phone) => {
      expect(await contactEntities(`Call ${phone}.`)).toContainEqual(
        expect.objectContaining({ label: "phone number", text: phone }),
      );
    },
  );

  test.each([
    "012-555-0142",
    "212-111-0142",
    "Section 202-111-2026 applies",
    "+44 (20 7946 0958",
    "+44 20) 7946 0958",
    "Adjustment +2024-01-01 applies.",
    "Date key +20240721 applies.",
    "Date key +2024-0721 applies.",
    "Case No. +44-2024-01-01.",
    "Law No. +420 2024 01 01.",
    "Case No. +4420240101.",
    "Law No. +42020240721.",
    "Variance +1.234.567 was recorded.",
    "Increment +123-45-67 applies.",
    "Reference +12-345-6789.",
    "Clause +12.34.56.78 applies",
    "Reference +1234567.",
  ])("rejects invalid NANP-like text %s", async (text) => {
    expect(await contactEntities(text)).toEqual([]);
  });

  test.each([
    ".legal@example.test",
    "legal..notices@example.test",
    "legal@example-.test",
    "legal@example",
    "a@example.test_suffix",
    "a@büro.example_suffix",
    "a@example.test\u0308_suffix",
    "\u0301alice@example.test",
    "alice.\u0301bob@example.test",
    "a@example.test@evil.example",
  ])("rejects unsafe email shape %s", async (text) => {
    expect(await contactEntities(`Reference ${text} only.`)).toEqual([]);
  });
});
