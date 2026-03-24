import { describe, expect, test } from "bun:test";

import {
  extractDefinedTerms,
  findCoreferenceSpans,
} from "../coreference";
import { buildPlaceholderMap } from "../../redact";
import { DETECTION_SOURCES } from "../../types";
import type { Entity } from "../../types";
import {
  createPipelineContext,
} from "../../context";

const makeEntity = (
  label: string,
  text: string,
  start: number,
): Entity => ({
  label,
  text,
  start,
  end: start + text.length,
  score: 0.95,
  source: "regex",
});

describe("extractDefinedTerms", () => {
  test("skips generic role aliases", async () => {
    const text =
      'Ing. Tomáš Procházka (dále jen „Prodávající") a ' +
      'ABC s.r.o. (dále jen „Kupující")';
    const entities = [
      makeEntity("person", "Ing. Tomáš Procházka", 0),
      makeEntity("organization", "ABC s.r.o.", 47),
    ];
    const terms = await extractDefinedTerms(
      text,
      entities,
    );
    expect(terms).toHaveLength(0);
  });

  test("tracks non-role aliases", async () => {
    const text =
      'Ing. Tomáš Procházka (dále jen „TP")';
    const entities = [
      makeEntity("person", "Ing. Tomáš Procházka", 0),
    ];
    const terms = await extractDefinedTerms(
      text,
      entities,
    );
    const tp = terms.find((t) => t.alias === "TP");
    expect(tp).toBeDefined();
    expect(tp?.label).toBe("person");
    expect(tp?.sourceText).toBe(
      "Ing. Tomáš Procházka",
    );
  });

  test("inherits label from nearest person/org", async () => {
    const text =
      'ABC s.r.o., IČO: 12345678 (dále jen „Firma")';
    const entities = [
      makeEntity("organization", "ABC s.r.o.", 0),
      makeEntity("registration number", "12345678", 17),
    ];
    const terms = await extractDefinedTerms(
      text,
      entities,
    );
    const firma = terms.find((t) => t.alias === "Firma");
    if (firma) {
      expect(firma.label).toBe("organization");
    }
  });

  test("ignores definitions with no nearby person/org", async () => {
    const text = 'splatnost 30 dnů (dále jen „Lhůta")';
    const entities = [makeEntity("date", "30 dnů", 10)];
    const terms = await extractDefinedTerms(
      text,
      entities,
    );
    expect(terms).toHaveLength(0);
  });
});

describe("findCoreferenceSpans", () => {
  test("respects word boundaries", () => {
    const text =
      "Kupující obdržel. Kupujícímu náleží.";
    const terms = [
      {
        alias: "Kupující",
        label: "organization",
        definitionStart: 0,
        sourceText: "ABC s.r.o.",
      },
    ];
    const spans = findCoreferenceSpans(text, terms);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.text).toBe("Kupující");
    expect(spans[0]?.start).toBe(0);
  });

  test("does not match substring", () => {
    const text = "Prodávajícího majetek";
    const terms = [
      {
        alias: "Prodávající",
        label: "person",
        definitionStart: 0,
        sourceText: "Jan Novák",
      },
    ];
    const spans = findCoreferenceSpans(text, terms);
    expect(spans).toHaveLength(0);
  });

  test("matches surrounded by punctuation", () => {
    const text = 'smlouvu s "TP", podepsanou';
    const terms = [
      {
        alias: "TP",
        label: "person",
        definitionStart: 0,
        sourceText: "Ing. Tomáš Procházka",
      },
    ];
    const spans = findCoreferenceSpans(text, terms);
    expect(spans).toHaveLength(1);
  });

  test("matches at end of text", () => {
    const text = "Smlouva s TP";
    const terms = [
      {
        alias: "TP",
        label: "person",
        definitionStart: 0,
        sourceText: "Ing. Tomáš Procházka",
      },
    ];
    const spans = findCoreferenceSpans(text, terms);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.text).toBe("TP");
  });

  test("coref shares same label as source entity", () => {
    const text = "TP podepsal. TP odešel.";
    const terms = [
      {
        alias: "TP",
        label: "person",
        definitionStart: 0,
        sourceText: "Ing. Tomáš Procházka",
      },
    ];
    const spans = findCoreferenceSpans(text, terms);
    expect(spans).toHaveLength(2);
    for (const s of spans) {
      expect(s.label).toBe("person");
    }
  });

  test("populates corefSourceMap for placeholder linking", () => {
    const ctx = createPipelineContext();
    const text = "Smlouva s TP";
    const terms = [
      {
        alias: "TP",
        label: "person",
        definitionStart: 0,
        sourceText: "Ing. Tomáš Procházka",
      },
    ];
    const spans = findCoreferenceSpans(
      text,
      terms,
      ctx,
    );
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(ctx.corefSourceMap.get(span)).toBe(
      "Ing. Tomáš Procházka",
    );
  });

  test("coref alias gets same placeholder as source entity", () => {
    const ctx = createPipelineContext();
    // Source entity: "Ing. Tomáš Procházka" at position 0
    const sourceEntity: Entity = {
      start: 0,
      end: 20,
      label: "person",
      text: "Ing. Tomáš Procházka",
      score: 0.95,
      source: DETECTION_SOURCES.NER,
    };

    // Coref alias "TP" found later in text
    const text =
      "Ing. Tomáš Procházka uzavřel smlouvu." +
      " TP podepsal.";
    const terms = [
      {
        alias: "TP",
        label: "person",
        definitionStart: 0,
        sourceText: "Ing. Tomáš Procházka",
      },
    ];
    const corefSpans = findCoreferenceSpans(
      text,
      terms,
      ctx,
    );
    expect(corefSpans).toHaveLength(1);

    // Build placeholder map with both source and coref
    const allEntities = [sourceEntity, ...corefSpans];
    const placeholderMap = buildPlaceholderMap(
      allEntities,
      ctx,
    );

    const sourceKey = `person\0Ing. Tomáš Procházka`;
    const corefKey = `person\0TP`;

    // Both must get the same placeholder number
    expect(placeholderMap.get(sourceKey)).toBe(
      "[PERSON_1]",
    );
    expect(placeholderMap.get(corefKey)).toBe(
      "[PERSON_1]",
    );
  });
});
