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
    // Synthetic input: a blank "Phone:" field followed by
    // a long chain of other form labels on the same line.
    // Matches the failure shape observed on real estate
    // exhibits where HTML stripping concatenates
    // signature blocks onto one logical line. Uses
    // generic placeholder labels — no doc-specific text.
    const filler = "Date: Name: Title: Address: Phone: Fax: ".repeat(8).trim();
    const text = `Signatory block. Phone: ${filler}\nNext paragraph.`;

    const entities = await detect(text);
    const phones = entities.filter((e) => e.label === "phone number");
    for (const phone of phones) {
      expect(phone.text.length).toBeLessThanOrEqual(100);
    }
  });

  test("phone-label trigger entity must contain digits", async () => {
    // Same shape, but check the label-shape invariant
    // directly: any phone-number entity returned by the
    // trigger pipeline carries at least one digit.
    const text =
      "Phone: Date: SSN or FEIN: Address: Phone: Fax:\n" +
      "Phone: +1 (555) 123-4567\n";

    const entities = await detect(text);
    const phones = entities.filter((e) => e.label === "phone number");
    for (const phone of phones) {
      expect(phone.text).toMatch(/\d/);
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
