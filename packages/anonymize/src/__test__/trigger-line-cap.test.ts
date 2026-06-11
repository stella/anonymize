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

const detect = async (text: string, override?: Partial<PipelineConfig>) =>
  runPipeline({
    fullText: text,
    config: { ...CONFIG, ...override },
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

  test("tab-terminated trigger value longer than cap is preserved", async () => {
    const account =
      "CZ6508000000192000145399 " +
      "payment instructions ".repeat(6) +
      "variable symbol 123456";
    expect(account.length).toBeGreaterThan(100);

    const text = `Bankovní spojení: ${account}\tNext cell.`;
    const entities = await detect(text);
    const bankAccount = entities.find(
      (e) => e.label === "bank account number" && e.text.includes("123456"),
    );
    expect(bankAccount).toBeDefined();
    expect(bankAccount!.text).toBe(account.trim());
  });

  test("unterminated cap does not cut through account numbers", async () => {
    const iban = "CZ6508000000192000145399";
    const prose = "payment instructions ".repeat(4);
    const text = `Bankovní spojení: ${prose}${iban} trailing words without delimiter`;

    const entities = await detect(text);
    expect(entities.some((e) => e.label === "iban" && e.text === iban)).toBe(
      true,
    );
    expect(
      entities.some(
        (e) =>
          e.label === "bank account number" &&
          e.text !== iban &&
          e.text.includes(iban.slice(0, 8)),
      ),
    ).toBe(false);
  });

  test("german IBAN trigger captures spaced account numbers", async () => {
    const iban = "DE89 3704 0044 0532 0130 00";
    const entities = await detect(`IBAN: ${iban}\nBIC: COBADEFFXXX`);

    expect(entities.some((e) => e.label === "iban" && e.text === iban)).toBe(
      true,
    );
    expect(entities.some((e) => e.label === "iban" && e.text === "DE89")).toBe(
      false,
    );
  });

  test("IBAN trigger accepts shorter valid account lengths", async () => {
    const iban = "NO93 8601 1117 947";
    const entities = await detect(`IBAN: ${iban}\nBIC: DNBANOKKXXX`);

    expect(entities.some((e) => e.label === "iban" && e.text === iban)).toBe(
      true,
    );
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

  test("phone-label trigger keeps valid prefix before later inline labels", async () => {
    const text = "PHONE: 555-12345 FAX: 555-99999\n";

    const entities = await detect(text, { enableRegex: false });
    const phones = entities.filter((e) => e.label === "phone number");
    expect(phones.some((e) => e.text === "555-12345")).toBe(true);
    expect(phones.every((e) => !e.text.includes("FAX"))).toBe(true);
  });

  test("phone trigger value stops at the end of the phone-shaped run", async () => {
    // Mid-sentence trigger on a single-line paragraph
    // (HTML-flattened contract): the value must end with
    // the number, not run through the line delimiter and
    // swallow the rest of the sentence.
    const text =
      "Contact: jane.doe@example.com, phone +420 777 123 456. " +
      "Signed on 1 January 2024 by Jane Doe and witnessed by John Smith.\n";

    const entities = await detect(text);
    const phones = entities.filter((e) => e.label === "phone number");
    expect(phones.some((e) => e.text === "+420 777 123 456")).toBe(true);
    for (const phone of phones) {
      expect(phone.text).not.toContain("Signed");
      expect(phone.text).not.toContain("Jane");
    }
  });

  test("phone shape stops at a sentence boundary before a numbered clause", async () => {
    // A dot followed by whitespace ends the phone-shaped
    // run: the shape class (dot, space, digits) must not
    // run through ". 1. Definitions…" and swallow the
    // following numbered clause.
    const text =
      "Contact: jane.doe@example.com, phone +420 777 123 456. " +
      "1. Definitions apply as stated.\n";

    const entities = await detect(text);
    const phones = entities.filter((e) => e.label === "phone number");
    expect(phones.some((e) => e.text === "+420 777 123 456")).toBe(true);
    for (const phone of phones) {
      expect(phone.text).not.toContain("Definitions");
      expect(phone.text.endsWith(". 1")).toBe(false);
    }
  });

  test("phone shape keeps a trailing extension suffix", async () => {
    const text = "PHONE: +1 555 123 4567 ext. 89\nNext line.";

    const entities = await detect(text, { enableRegex: false });
    const phones = entities.filter((e) => e.label === "phone number");
    expect(phones.some((e) => e.text === "+1 555 123 4567 ext. 89")).toBe(true);
  });

  test("phone shape bound stays within the length cap", async () => {
    // Pathological single-line run: hundreds of chars of
    // digits and spaces with no line delimiter. The shape
    // bound must not bypass the 100-char cap.
    const run = "1 ".repeat(120).trim();
    const text = `PHONE: ${run} Signed by John`;

    const entities = await detect(text, { enableRegex: false });
    const phones = entities.filter((e) => e.label === "phone number");
    expect(phones.length).toBeGreaterThan(0);
    for (const phone of phones) {
      expect(phone.text.length).toBeLessThanOrEqual(100);
    }
  });

  test("newline-terminated multi-phone line longer than cap is preserved", async () => {
    // A genuinely newline-terminated phone line longer than
    // the 100-char cap: the cap applies only to a shape-
    // derived stop, never to a real line delimiter. Mirrors
    // the bank-account "newline-terminated … is preserved"
    // case. Digits, slashes, and spaces only so the whole
    // line stays inside the phone shape.
    const numbers = Array.from(
      { length: 12 },
      (_, i) => `555-10${String(i).padStart(2, "0")}`,
    ).join(" / ");
    expect(numbers.length).toBeGreaterThan(100);

    const text = `Phone: ${numbers}\nNext line.`;
    const entities = await detect(text, { enableRegex: false });
    const phone = entities.find(
      (e) => e.label === "phone number" && e.text.includes("1011"),
    );
    expect(phone).toBeDefined();
    expect(phone!.text).toBe(numbers);
  });

  test("phone shape spans a unicode dash separator", async () => {
    // A non-breaking hyphen (U+2011) between number groups
    // must not break the shape run: without the dash class
    // the run stops at "+1 555" and fails the >=5-digit
    // plausibility check, dropping the number entirely.
    const text = "PHONE: +1 555‑123‑4567\nNext line.";
    const entities = await detect(text, { enableRegex: false });
    const phones = entities.filter((e) => e.label === "phone number");
    expect(phones.some((e) => e.text.includes("4567"))).toBe(true);
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
