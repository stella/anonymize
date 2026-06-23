import { describe, expect, test } from "bun:test";
import {
  filterFalsePositives,
  initAddressComponents,
} from "../false-positives";
import type { DetectedEntity, Entity } from "../../types";

const person = (text: string): Entity => ({
  start: 0,
  end: text.length,
  label: "person",
  text,
  score: 0.9,
  source: "ner",
});

const triggerAddress = (text: string): Entity => ({
  start: 0,
  end: text.length,
  label: "address",
  text,
  score: 0.9,
  source: "trigger",
});

const triggerAddressAt = (
  text: string,
  start: number,
  rawLength: number,
): Entity => ({
  start,
  end: start + rawLength,
  label: "address",
  text,
  score: 0.9,
  source: "trigger",
});

describe("person entities containing digits", () => {
  test("rejects person with digits", () => {
    const result = filterFalsePositives([person("Solution Pack ABL90 Flex")]);
    expect(result).toHaveLength(0);
  });

  test("rejects person with trailing number", () => {
    const result = filterFalsePositives([person("Model X7")]);
    expect(result).toHaveLength(0);
  });

  test("keeps person without digits", () => {
    const result = filterFalsePositives([person("Jan Novák")]);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("Jan Novák");
  });
});

describe("street-type fallback for direct callers", () => {
  test("keeps digitless trigger-sourced address after warm-up", async () => {
    await initAddressComponents();
    const result = filterFalsePositives([triggerAddress("Via Roma")]);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("Via Roma");
  });
});

describe("raw-span address normalization", () => {
  test("trims collapsed role prefixes and trailing prose with raw offsets", () => {
    const fullText =
      "Sídlo objednatele\n  č.p. 12. This sentence is not part of the address.";
    const rawStart = fullText.indexOf("objednatele");
    const rawEnd = fullText.length;
    const addressStart = fullText.indexOf("č.p. 12");
    const addressEnd = addressStart + "č.p. 12".length;

    const result = filterFalsePositives(
      [
        triggerAddressAt(
          "objednatele č.p. 12. This sentence is not part of the address.",
          rawStart,
          rawEnd - rawStart,
        ),
      ],
      undefined,
      fullText,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      start: addressStart,
      end: addressEnd,
      text: "č.p. 12",
    });
  });
});

const orgAt = (
  text: string,
  start: number,
  source: DetectedEntity["source"] = "trigger",
): Entity => ({
  start,
  end: start + text.length,
  label: "organization",
  text,
  score: 0.9,
  source,
});

describe("organization candidates inside all-caps boilerplate", () => {
  // SAFE-style securities legend: a long, uppercase
  // disclosure block with no real party names. Detectors
  // anchored to caps tokens used to emit jargon bigrams
  // ("SECURITIES ACT", "REGISTRATION STATEMENT") as
  // organisation spans; the all-caps-line guard rejects
  // them.
  const SAFE_LEGEND =
    `THIS INSTRUMENT AND ANY SECURITIES ISSUABLE PURSUANT HERETO HAVE NOT ` +
    `BEEN REGISTERED UNDER THE SECURITIES ACT OF 1933, AS AMENDED (THE ` +
    `"SECURITIES ACT"), OR UNDER THE SECURITIES LAWS OF CERTAIN STATES.  ` +
    `THESE SECURITIES MAY NOT BE OFFERED, SOLD OR OTHERWISE TRANSFERRED, ` +
    `PLEDGED OR HYPOTHECATED EXCEPT AS PERMITTED IN THIS SAFE AND UNDER ` +
    `THE ACT AND APPLICABLE STATE SECURITIES LAWS PURSUANT TO AN EFFECTIVE ` +
    `REGISTRATION STATEMENT OR AN EXEMPTION THEREFROM.`;

  test.each([
    ["SECURITIES ACT"],
    ["REGISTRATION STATEMENT"],
    ["EFFECTIVE REGISTRATION STATEMENT"],
  ])("rejects %s emitted from inside the SEC legend", (jargon: string) => {
    const start = SAFE_LEGEND.indexOf(jargon);
    expect(start).toBeGreaterThanOrEqual(0);
    const result = filterFalsePositives(
      [orgAt(jargon, start)],
      undefined,
      SAFE_LEGEND,
    );
    expect(result).toHaveLength(0);
  });

  test("keeps a real all-caps org name when its surrounding line is mixed-case", () => {
    const text = `The agreement was signed by ACME LIMITED in Prague.`;
    const start = text.indexOf("ACME LIMITED");
    const result = filterFalsePositives(
      [orgAt("ACME LIMITED", start)],
      undefined,
      text,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("ACME LIMITED");
  });
});

describe("organization word-count guardrail", () => {
  test("rejects an open-ended trigger capture exceeding the org word cap", () => {
    const text =
      "Acme Holdings International Group of Subsidiary Partners and Affiliates";
    const result = filterFalsePositives([orgAt(text, 0)]);
    expect(result).toHaveLength(0);
  });

  test("keeps a typical multi-word firm name well under the cap", () => {
    const result = filterFalsePositives([
      orgAt("European Bank for Reconstruction and Development", 0),
    ]);
    expect(result).toHaveLength(1);
  });

  test("legal-form-anchored entities are exempt from the word cap", () => {
    const text =
      "Acme Holdings International Group of Subsidiary Partners and Affiliates LLC";
    const result = filterFalsePositives([orgAt(text, 0, "legal-form")]);
    expect(result).toHaveLength(1);
  });

  const longOrgSources: DetectedEntity["source"][] = [
    "gazetteer",
    "ner",
    "regex",
  ];
  test.each(longOrgSources)(
    "keeps a long %s-detected org name beyond the word cap",
    (source: DetectedEntity["source"]) => {
      const text = "The University of Texas Health Science Center at Houston";
      const result = filterFalsePositives([orgAt(text, 0, source)]);
      expect(result).toHaveLength(1);
    },
  );
});
