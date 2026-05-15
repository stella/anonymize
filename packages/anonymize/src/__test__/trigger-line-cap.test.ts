import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  runPipeline,
  DEFAULT_ENTITY_LABELS,
  createPipelineContext,
} from "../index";
import type { PipelineContext } from "../context";
import type { PipelineConfig } from "../types";

setDefaultTimeout(15_000);

const CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "test",
};

let sharedCtx: PipelineContext | undefined;
const getCtx = (): PipelineContext => {
  if (!sharedCtx) sharedCtx = createPipelineContext();
  return sharedCtx;
};

const detect = async (text: string) =>
  runPipeline({
    fullText: text,
    config: CONFIG,
    gazetteerEntries: [],
    context: getCtx(),
  });

// Regression coverage for trigger value runaway on
// HTML-flattened or signature-block inputs where the
// natural line delimiter (newline) is missing and a
// single logical line stretches for hundreds of chars.
describe("trigger value length cap", () => {
  test("to-end-of-line trigger does not consume a multi-field signature block", async () => {
    // Synthetic input: a bank-account field followed by
    // a long chain of other form labels on the same line.
    // Matches the failure shape observed on real estate
    // exhibits where HTML stripping concatenates
    // signature blocks onto one logical line.
    const account = "CZ6508000000192000145399";
    const filler = "Date: Name: Title: Address: Phone: Fax: ".repeat(8).trim();
    const text = `Signatory block. Bankovní spojení: ${account} ${filler}`;

    const entities = await detect(text);
    const bankAccounts = entities.filter(
      (e) => e.label === "bank account number",
    );
    expect(bankAccounts.length).toBeGreaterThan(0);
    for (const bankAccount of bankAccounts) {
      expect(bankAccount.text.length).toBeLessThanOrEqual(100);
    }
  });

  test("newline-terminated trigger value longer than cap is preserved", async () => {
    const account =
      "CZ6508000000192000145399 " +
      "payment instructions ".repeat(6) +
      "variable symbol 123456";
    expect(account.length).toBeGreaterThan(100);

    const text = `Bankovní spojení: ${account}\nNext paragraph.`;
    const entities = await detect(text);
    const bankAccount = entities.find(
      (e) => e.label === "bank account number" && e.text.includes("123456"),
    );
    expect(bankAccount).toBeDefined();
    expect(bankAccount!.text).toBe(account.trim());
  });

  test("phone-label trigger entity must contain digits", async () => {
    // Same shape, but check the label-shape invariant:
    // a blank phone label followed by other digit-bearing
    // fields must not create a long high-priority phone
    // entity that overlaps and suppresses the later real
    // phone value.
    const text =
      "Phone: Date: 2026-05-15 SSN or FEIN: 12-3456789 Address: " +
      "Phone: +1 (555) 123-4567\n";

    const entities = await detect(text);
    const phones = entities.filter((e) => e.label === "phone number");
    expect(phones.length).toBeGreaterThan(0);
    expect(phones.some((e) => e.text.includes("555"))).toBe(true);
    for (const phone of phones) {
      expect(phone.text).not.toContain("Date:");
      expect(phone.text.trimStart()).toMatch(/^[+(\d]/);
    }
  });

  test("phone-label trigger rejects inline non-phone fields before later phone", async () => {
    const text =
      "Phone: 2026-05-15 SSN or FEIN: 12-3456789 Address: " +
      "123 Long Form Signature Field Phone: +1 (555) 123-4567\n";

    const entities = await detect(text);
    const phones = entities.filter((e) => e.label === "phone number");
    expect(phones.some((e) => e.text.includes("(555) 123-4567"))).toBe(true);
    for (const phone of phones) {
      expect(phone.text).not.toContain("SSN");
      expect(phone.text).not.toContain("Address:");
    }
  });

  test("legitimate end-of-line value below the cap is preserved verbatim", async () => {
    // A short, well-formed value on its own line is
    // captured in full — the cap should never truncate
    // legitimate inputs. We rely on the HU "PHONE:"
    // trigger that fires case-insensitively across
    // languages; replace with any in-vocab trigger for
    // brittleness-free coverage.
    const text = "Phone: +1 (555) 123-4567\nNext line.";
    const entities = await detect(text);
    const phone = entities.find((e) => e.label === "phone number");
    expect(phone).toBeDefined();
    expect(phone!.text).toContain("555");
  });
});
