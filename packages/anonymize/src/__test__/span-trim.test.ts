import { describe, expect, test } from "bun:test";
import { sanitizeEntities } from "../pipeline";
import type { Entity } from "../types";

const make = (text: string, label = "organization"): Entity => ({
  start: 0,
  end: text.length,
  label,
  text,
  score: 0.9,
  source: "ner",
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

  test("drops entity that becomes empty after trim", () => {
    expect(sanitizeEntities([make(`".,;!`)])).toHaveLength(0);
  });
});
