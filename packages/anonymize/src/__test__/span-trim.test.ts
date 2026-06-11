import { describe, expect, test } from "bun:test";
import { sanitizeEntities } from "../pipeline";
import type { DetectedEntity, Entity } from "../types";

const make = (
  text: string,
  label = "organization",
  source: DetectedEntity["source"] = "ner",
): Entity => ({
  start: 0,
  end: text.length,
  label,
  text,
  score: 0.9,
  source,
});

const trim = (text: string, label?: string): string => {
  const [out] = sanitizeEntities([make(text, label)]);
  return out?.text ?? "";
};

describe("sanitizeEntities — trailing typographic punctuation", () => {
  test("strips ASCII double quote", () => {
    expect(trim(`Bond Hedge Documentation"`)).toBe("Bond Hedge Documentation");
  });

  test("strips curly double quotes (open and close)", () => {
    expect(trim(`Bond Hedge Transactions”`)).toBe("Bond Hedge Transactions");
    expect(trim(`Tesla Shares“`)).toBe("Tesla Shares");
  });

  test("strips ASCII and curly single quotes", () => {
    expect(trim(`Acme'`)).toBe("Acme");
    expect(trim(`Acme’`)).toBe("Acme");
    expect(trim(`Acme‘`)).toBe("Acme");
  });

  test("strips trailing guillemet", () => {
    expect(trim(`SAS Foo»`)).toBe("SAS Foo");
  });

  test("strips trailing sentence terminators", () => {
    expect(trim(`State of Delaware.`, "location")).toBe("State of Delaware");
    expect(trim(`Foo Corp!`)).toBe("Foo Corp");
    expect(trim(`Foo Corp?`)).toBe("Foo Corp");
  });

  test("strips combinations of period, quote, semicolon", () => {
    expect(trim(`Foo.”`, "location")).toBe("Foo");
    expect(trim(`Foo";`)).toBe("Foo");
  });

  test("preserves trailing closing parenthesis (structural in monetary extensions)", () => {
    expect(trim(`100 Kč (slovy: sto)`, "monetary amount")).toBe(
      "100 Kč (slovy: sto)",
    );
  });

  test("adjusts start/end so source slice remains valid", () => {
    const e: Entity = {
      start: 10,
      end: 10 + `"Tesla Shares"`.length,
      label: "organization",
      text: `"Tesla Shares"`,
      score: 0.9,
      source: "ner",
    };
    const [out] = sanitizeEntities([e]);
    expect(out?.text).toBe("Tesla Shares");
    expect(out?.start).toBe(11);
    expect(out?.end).toBe(11 + "Tesla Shares".length);
  });

  test("strips leading typographic punctuation", () => {
    expect(trim(`"Foo Corp`)).toBe("Foo Corp");
    expect(trim(`“Foo Corp`)).toBe("Foo Corp");
    expect(trim(`«Foo Corp`)).toBe("Foo Corp");
  });

  test("preserves internal apostrophes and quotes", () => {
    expect(trim(`O'Brien & Sons`)).toBe("O'Brien & Sons");
  });

  test("keeps legal-form trailing period", () => {
    // `Inc.` is a known legal-form suffix; the period
    // should survive.
    expect(trim(`Acme Inc.`)).toBe("Acme Inc.");
  });

  test("preserves address abbreviation period", () => {
    expect(trim("123 Main St.", "address")).toBe("123 Main St.");
  });

  test("preserves location abbreviation period", () => {
    expect(trim("Washington, D.C.", "location")).toBe("Washington, D.C.");
  });

  test("strips non-abbreviation periods from address spans", () => {
    expect(
      trim("Kodaňská 1441/46, Vršovice, 101 00 Praha 10.", "address"),
    ).toBe("Kodaňská 1441/46, Vršovice, 101 00 Praha 10");
    expect(trim("State of Delaware.", "address")).toBe("State of Delaware");
    expect(trim("Brno.", "address")).toBe("Brno");
  });

  test("preserves literal dictionary punctuation", () => {
    const literals = [
      make("Hello bank!", "organization", "deny-list"),
      make(`"Juez y parte"`, "organization", "deny-list"),
      make("'Bank van lening'", "organization", "deny-list"),
      make("Vista!", "organization", "gazetteer"),
    ];
    expect(sanitizeEntities(literals).map((e) => e.text)).toEqual([
      "Hello bank!",
      `"Juez y parte"`,
      "'Bank van lening'",
      "Vista!",
    ]);
  });

  test("still trims generated spans from literal-backed sources", () => {
    const [name] = sanitizeEntities([
      make("John Smith:", "person", "deny-list"),
    ]);
    expect(name?.text).toBe("John Smith");

    const [extendedGazetteer] = sanitizeEntities([
      make("Acme Inc.,", "organization", "gazetteer"),
    ]);
    expect(extendedGazetteer?.text).toBe("Acme Inc.");

    const [punctuatedGazetteerExtension] = sanitizeEntities([
      {
        ...make("Acme GmbH!", "organization", "gazetteer"),
        sourceDetail: "gazetteer-extension",
      },
    ]);
    expect(punctuatedGazetteerExtension?.text).toBe("Acme GmbH");
  });

  test("drops entity that becomes empty after trim", () => {
    expect(sanitizeEntities([make(`".,;!`)])).toHaveLength(0);
  });
});
