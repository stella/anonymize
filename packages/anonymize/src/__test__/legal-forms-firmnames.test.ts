import { describe, expect, test } from "bun:test";
import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";

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

const orgsIn = async (text: string): Promise<string[]> => {
  const entities = await detectNative(CONFIG, text);
  return entities.filter((e) => e.label === "organization").map((e) => e.text);
};

// Regressions from the SEC EDGAR Twitter merger fixture
// (ledger entries anon-146, anon-148, anon-206, anon-208,
// anon-209, anon-211, anon-212, anon-213). Each pattern
// covers a different way the legal-forms detector used to
// truncate firm or bank names with internal punctuation.

describe("legal-form firm name capture", () => {
  test("ampersand + internal Co. before LLC", async () => {
    // Goldman Sachs & Co. LLC — `Co.` is itself a known
    // legal form so the regex used to fail to anchor on
    // the trailing LLC and emit nothing.
    expect(await orgsIn("Goldman Sachs & Co. LLC")).toContain(
      "Goldman Sachs & Co. LLC",
    );
  }, 10_000);

  test("ampersand + Co. inside in-context sentence", async () => {
    expect(
      await orgsIn(
        "between the Company and Goldman Sachs & Co. LLC, (vii) the",
      ),
    ).toContain("Goldman Sachs & Co. LLC");
  });

  // NATIVE-GAP: the native legal-form walker does not extend the org span
  // across a compact initial-dot prefix ("J.P." with no space between the
  // initials); it emits nothing for "J.P. Morgan Securities LLC". The spaced
  // form ("J. P. Morgan Securities LLC") is captured correctly (see the test
  // below), so this is specific to the no-space initials boundary.
  test("initial-dot prefix (J.P. Morgan)", async () => {
    // backward extension previously stopped at the dot
    // after `P.` and lost the `J.P.` initials.
    expect(await orgsIn("J.P. Morgan Securities LLC")).toContain(
      "J.P. Morgan Securities LLC",
    );
  });

  test("initial-dot prefix with single-space initials", async () => {
    expect(await orgsIn("J. P. Morgan Securities LLC")).toContain(
      "J. P. Morgan Securities LLC",
    );
  });

  test("PLC suffix is not dropped", async () => {
    // Sanity: the bare span should still come through.
    expect(await orgsIn("Barclays Bank PLC")).toContain("Barclays Bank PLC");
  });

  test("commas inside firm name (Skadden Arps)", async () => {
    expect(
      await orgsIn(
        "with a copy (which shall not constitute notice) to:\n" +
          "Skadden, Arps, Slate, Meagher & Flom LLP\n" +
          "525 University Ave, Suite 1400",
      ),
    ).toContain("Skadden, Arps, Slate, Meagher & Flom LLP");
  });

  test("Simpson Thacher & Bartlett LLP across paragraphs", async () => {
    expect(
      await orgsIn("and\nSimpson Thacher & Bartlett LLP\n425 Lexington Avenue"),
    ).toContain("Simpson Thacher & Bartlett LLP");
  });

  test("trailing , N.A. is preserved", async () => {
    expect(
      await orgsIn("JPMorgan Chase Bank, N.A. as administrative agent"),
    ).toContain("JPMorgan Chase Bank, N.A.");
  });

  test("trailing , N.A. on Bank of America", async () => {
    expect(
      await orgsIn(
        "dated March 1, 2021, between the Company and Bank of America, N.A. (the",
      ),
    ).toContain("Bank of America, N.A.");
  });

  // Backward-extension stop guards — must NOT swallow
  // preceding sentence prose.

  test("does not absorb 'the Company and' before Barclays Bank PLC", async () => {
    const orgs = await orgsIn(
      "between the Company and Barclays Bank PLC, (ii) the",
    );
    // Must include the clean firm name, must not include
    // the over-extended prose variant.
    expect(orgs).toContain("Barclays Bank PLC");
    expect(orgs).not.toContain("Company and Barclays Bank PLC");
    expect(orgs).not.toContain("the Company and Barclays Bank PLC");
  });

  // NATIVE-GAP: depends on capturing the compact "J.P. Morgan Securities LLC"
  // initial-dot prefix, which the native walker does not emit (same gap as the
  // skipped "initial-dot prefix (J.P. Morgan)" test). Native correctly emits
  // "Allen & Company LLC" and does not merge the siblings, but the J.P. Morgan
  // half of the assertion cannot pass until the initial-dot prefix is handled.
  test("splits sibling orgs separated by 'and'", async () => {
    // `J.P. Morgan Securities LLC and Allen & Company LLC`
    // — must not collapse the two firms into a single
    // org via backward extension on the second match.
    const orgs = await orgsIn(
      "J.P. Morgan Securities LLC and Allen & Company LLC.",
    );
    expect(orgs).toContain("J.P. Morgan Securities LLC");
    expect(orgs).toContain("Allen & Company LLC");
    // Combined span is a regression marker — should never
    // be emitted.
    expect(orgs.some((o) => o.includes("LLC and Allen"))).toBe(false);
  });

  test("keeps Paul Newman and Apple, Inc. boundary intact", async () => {
    // Existing person/org boundary stays correct after the
    // backward-extension tightening.
    const orgs = await orgsIn("Paul Newman and Apple, Inc.");
    expect(orgs).toEqual(["Apple, Inc."]);
  });

  test("keeps one-word firm prefixes before internal and", async () => {
    expect(
      await orgsIn("Baker and Hostetler LLP advised the company."),
    ).toContain("Baker and Hostetler LLP");
    expect(await orgsIn("Smith and Wesson Inc. signed.")).toContain(
      "Smith and Wesson Inc.",
    );
  });

  test("ordinary sentence-final words are not dotted abbreviations", async () => {
    const czech = await orgsIn("Cena. KB poskytla úvěr.");
    expect(czech).not.toContain("Cena. KB");

    const english = await orgsIn("Price. LLC will be formed later.");
    expect(english).not.toContain("Price. LLC");
  });

  test("role-head trim keeps names starting with Company", async () => {
    expect(await orgsIn("Vendor owns Company Ventures Inc.")).toContain(
      "Company Ventures Inc.",
    );
  });

  test("bare legal-form words can appear inside names", async () => {
    expect(
      await orgsIn("Fidelity Trust and Guaranty Company, Inc. signed."),
    ).toContain("Fidelity Trust and Guaranty Company, Inc.");
  });
});
