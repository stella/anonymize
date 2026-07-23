import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findInCodeVocabularies,
  isNaturalLanguageWord,
} from "./check-in-code-vocabulary.mjs";

const sourceArray = (identifier, values, prefix = "") =>
  `${prefix}const ${identifier} = [${values.map(JSON.stringify).join(", ")}];`;

await describe("in-code vocabulary script detection", async () => {
  const caselessVocabularies = {
    Arabic: ["اِسْم", "عنوان", "مدينة", "محكمة", "شركة", "مدير"],
    Chinese: ["姓名", "地址", "城市", "法院", "公司", "董事"],
    Japanese: ["氏名", "住所", "まち", "裁判所", "会社", "ディレクター"],
    Thai: ["ชื่อ", "ที่อยู่", "เมือง", "ศาล", "บริษัท", "กรรมการ"],
  };

  for (const [script, words] of Object.entries(caselessVocabularies)) {
    await it(`detects ${script} vocabulary`, () => {
      const findings = findInCodeVocabularies(
        "crates/anonymize-core/src/example.rs",
        sourceArray("WORDS", words),
      );
      assert.equal(findings.length, 1);
      assert.deepEqual(findings[0].words, words);
    });
  }

  await it("keeps cased scripts lowercase and rejects identifier casing", () => {
    assert.equal(isNaturalLanguageWord("straße"), true);
    assert.equal(isNaturalLanguageWord("École"), false);
    assert.equal(isNaturalLanguageWord("camelCase"), false);
    assert.equal(isNaturalLanguageWord("HTTPServer"), false);
  });

  await it("detects single-quoted TypeScript vocabulary", () => {
    const source =
      "const WORDS = ['vendor', 'supplier', 'customer', 'partner', 'manager', 'director'];";
    const findings = findInCodeVocabularies(
      "packages/anonymize/src/example.ts",
      source,
    );
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0].words, [
      "vendor",
      "supplier",
      "customer",
      "partner",
      "manager",
      "director",
    ]);
  });
});

await describe("in-code vocabulary false-positive controls", async () => {
  await it("rejects codes, identifiers, regexes, and source fragments", () => {
    const sources = [
      sourceArray("CODES", [
        "en_US",
        "zh_CN",
        "ar_SA",
        "th_TH",
        "ja_JP",
        "UTF_8",
      ]),
      sourceArray("IDENTIFIERS", [
        "camelCase",
        "PascalCase",
        "snake_case",
        "field.name",
        "path/to",
        "module::item",
      ]),
      sourceArray("REGEXES", [
        "\\p{L}+",
        "[A-Z]",
        "^foo$",
        "bar.*",
        "(?:x)",
        "a|b",
      ]),
    ].join("\n");
    assert.deepEqual(
      findInCodeVocabularies("packages/anonymize/src/example.ts", sources),
      [],
    );
  });

  await it("retains threshold and word-fraction guards", () => {
    const belowThreshold = sourceArray("WORDS", [
      "姓名",
      "地址",
      "城市",
      "法院",
      "会社",
    ]);
    const belowFraction = sourceArray("WORDS", [
      "اسم",
      "عنوان",
      "مدينة",
      "محكمة",
      "شركة",
      "مدير",
      "field.name",
      "path/to",
    ]);
    assert.deepEqual(
      findInCodeVocabularies(
        "crates/anonymize-core/src/example.rs",
        `${belowThreshold}\n${belowFraction}`,
      ),
      [],
    );
  });

  await it("retains named and inline exceptions", () => {
    const localeCodes = sourceArray("NONWESTERN_LOCALE_KEYS", [
      "ar-eg",
      "zh-cn",
      "th-th",
      "ja-jp",
      "ko-kr",
      "he-il",
    ]);
    const inline = sourceArray(
      "WORDS",
      ["اسم", "عنوان", "مدينة", "محكمة", "شركة", "مدير"],
      "// vocab-allow: coupled morphology rule\n",
    );
    assert.deepEqual(
      findInCodeVocabularies(
        "crates/anonymize-core/src/example.rs",
        `${localeCodes}\n${inline}`,
      ),
      [],
    );
  });
});
