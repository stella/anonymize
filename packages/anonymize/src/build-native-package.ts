import type { PipelineConfig } from "./types";
import { applyPipelineLanguageScope } from "./language-scope";

type DictionaryBundleOptions = {
  countries?: readonly string[];
  cityCountries?: readonly string[];
  nameLanguages?: readonly string[];
};

// @stll/anonymize-data 0.0.10 treats an empty language list as unscoped.
// A non-empty unsupported scope uses its existing "no matching corpus" path.
const EMPTY_NAME_CORPUS_SCOPE = ["und"] as const;

export const defaultDictionaryBundleOptions = (
  config: PipelineConfig,
): DictionaryBundleOptions => ({
  ...(config.denyListCountries === undefined
    ? {}
    : {
        countries: config.denyListCountries,
        cityCountries: config.denyListCountries,
      }),
  ...(config.nameCorpusLanguages === undefined
    ? {}
    : {
        nameLanguages:
          config.nameCorpusLanguages.length === 0
            ? EMPTY_NAME_CORPUS_SCOPE
            : config.nameCorpusLanguages,
      }),
});

export { applyPipelineLanguageScope };
