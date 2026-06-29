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

export const SHARED_NATIVE_SDK_DEFAULT_PACKAGE_FUNCTIONS = [
  "read_default_native_pipeline_package_file",
  "create_native_pipeline_from_default_package",
  "get_default_native_pipeline",
  "preload_default_native_pipeline",
] as const;

export const PYTHON_NATIVE_SDK_DEFAULT_PACKAGE_FUNCTIONS =
  SHARED_NATIVE_SDK_DEFAULT_PACKAGE_FUNCTIONS;

export const PYTHON_NATIVE_SDK_DEFAULT_PACKAGE_NAMES = [
  "DEFAULT_NATIVE_PIPELINE_WARMUPS",
  "DefaultNativePipelineWarmup",
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
