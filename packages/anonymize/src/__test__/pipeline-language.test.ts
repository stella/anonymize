import { describe, expect, test } from "bun:test";

import languageScopes from "../data/language-scopes.json";
import {
  normalizePipelineLanguageSelection,
  pipelineLanguageSelectionKey,
  SUPPORTED_LANGUAGES,
} from "../pipeline-language";

describe("pipeline language selection", () => {
  test("derives supported languages from the canonical scope data", () => {
    expect(SUPPORTED_LANGUAGES.join(",")).toBe(
      Object.keys(languageScopes.languages).toSorted().join(","),
    );
  });

  test("defaults to all languages", () => {
    expect(normalizePipelineLanguageSelection(undefined)).toEqual({
      type: "all",
    });
    expect(normalizePipelineLanguageSelection("all")).toEqual({ type: "all" });
    expect(
      Reflect.apply(normalizePipelineLanguageSelection, undefined, [" ALL "]),
    ).toEqual({ type: "all" });
  });

  test("normalizes, deduplicates, and sorts language selections", () => {
    const selection = normalizePipelineLanguageSelection(["en", "cs", "en"]);
    expect(selection).toEqual({
      type: "languages",
      languages: ["cs", "en"],
    });
    expect(pipelineLanguageSelectionKey(selection)).toBe("cs,en");
  });

  test("rejects empty and unsupported language selections", () => {
    expect(() =>
      Reflect.apply(normalizePipelineLanguageSelection, undefined, [[]]),
    ).toThrow("must not be empty");
    expect(() =>
      Reflect.apply(normalizePipelineLanguageSelection, undefined, ["nl"]),
    ).toThrow("Unsupported pipeline language");
    expect(() =>
      Reflect.apply(normalizePipelineLanguageSelection, undefined, [
        "toString",
      ]),
    ).toThrow("Unsupported pipeline language");
  });
});
