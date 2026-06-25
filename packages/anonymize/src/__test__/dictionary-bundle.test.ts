import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { loadDictionaryBundle } from "../../../data/dictionaries/index";

describe("dictionary bundle scoping", () => {
  test("empty country scope keeps default city dictionaries", async () => {
    const bundle = await loadDictionaryBundle({ countries: [] });

    expect(bundle.cities.length).toBeGreaterThan(0);
    expect(Object.keys(bundle.citiesByCountry)).toContain("CZ");
  });

  test("unsupported name language scope falls back to packaged names", async () => {
    const bundle = await loadDictionaryBundle({ nameLanguages: ["pt-br"] });

    expect(Object.keys(bundle.firstNames).length).toBeGreaterThan(0);
    expect(Object.keys(bundle.surnames).length).toBeGreaterThan(0);
  });
});
