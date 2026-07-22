import type { NativePreparedSearchConfig } from "@stll/anonymize";

const EMPTY_SLICE = { start: 0, end: 0 } as const;

/** Keep the assembler's built-in regex patterns and remove every other lane. */
export const regexDetectorConfig = (
  assembled: NativePreparedSearchConfig,
): NativePreparedSearchConfig => {
  const regexEnd = assembled.regex_patterns.length;
  const config: NativePreparedSearchConfig = {
    regex_patterns: assembled.regex_patterns,
    custom_regex_patterns: [],
    literal_patterns: [],
    regex_options: assembled.regex_options,
    custom_regex_options: assembled.custom_regex_options,
    literal_options: assembled.literal_options,
    literal_patterns_from_deny_list_data: false,
    allowed_labels: assembled.allowed_labels,
    threshold: assembled.threshold,
    confidence_boost: false,
    slices: {
      regex: assembled.slices.regex,
      custom_regex: EMPTY_SLICE,
      legal_forms: { start: regexEnd, end: regexEnd },
      triggers: { start: regexEnd, end: regexEnd },
      deny_list: EMPTY_SLICE,
      street_types: EMPTY_SLICE,
      gazetteer: EMPTY_SLICE,
      countries: EMPTY_SLICE,
      hotwords: EMPTY_SLICE,
    },
    regex_meta: assembled.regex_meta,
    custom_regex_meta: [],
  };
  assertRegexDetectorConfig(config);
  return config;
};

export const assertRegexDetectorConfig = (
  config: NativePreparedSearchConfig,
): void => {
  const forbiddenSupport = [
    config.address_seed_data,
    config.address_context_data,
    config.signature_data,
    config.date_data,
    config.monetary_data,
    config.trigger_data,
    config.legal_form_data,
    config.deny_list_data,
    config.gazetteer_data,
    config.country_data,
    config.hotword_data,
    config.coreference_data,
    config.name_corpus_data,
  ];
  if (
    config.regex_patterns.length === 0 ||
    config.regex_meta.length === 0 ||
    config.literal_patterns.length !== 0 ||
    config.custom_regex_patterns.length !== 0 ||
    forbiddenSupport.some((support) => support !== undefined)
  ) {
    throw new Error("stella regex-detector config contains a non-regex lane");
  }
};
