export const SHARED_NATIVE_SDK_CORE_TOP_LEVEL_FUNCTIONS = [
  "prepare_search_package",
  "load_prepared_package",
  "native_package_version",
  "normalize_for_search",
  "redact_text",
  "redact_text_json",
  "diagnostics_json",
] as const;

export const SHARED_NATIVE_SDK_TOP_LEVEL_FUNCTIONS = [
  ...SHARED_NATIVE_SDK_CORE_TOP_LEVEL_FUNCTIONS,
  "load_prepared_package_file",
] as const;

export const SHARED_NATIVE_SDK_PREPARED_METHODS = [
  "redact_text",
  "redact_text_json",
  "diagnostics_json",
  "prepare_diagnostics_json",
  "warm_lazy_regex",
  "warm_lazy_regex_diagnostics_json",
] as const;

export const SHARED_NATIVE_SDK_CLASS_NAMES = [
  "PreparedAnonymizer",
  "PreparedSearch",
] as const;
