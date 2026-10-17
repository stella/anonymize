/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const NATIVE_LIBRARY_FILES = Object.freeze({
  darwin: "libstella_anonymize_napi.dylib",
  linux: "libstella_anonymize_napi.so",
  win32: "stella_anonymize_napi.dll",
});

/**
 * @param {string} platform
 * @returns {platform is keyof typeof NATIVE_LIBRARY_FILES}
 */
const isNativeBuildPlatform = (platform) =>
  Object.hasOwn(NATIVE_LIBRARY_FILES, platform);

/** @param {string} platform */
export const nativeLibraryName = (platform) => {
  if (!isNativeBuildPlatform(platform))
    throw new Error(`Unsupported native build platform: ${platform}`);
  return NATIVE_LIBRARY_FILES[platform];
};

/** @param {unknown} manifest */
export const assertBuiltCapabilities = (manifest) => {
  if (
    !isRecord(manifest) ||
    manifest["schemaVersion"] !== 2 ||
    !Array.isArray(manifest["entities"]) ||
    manifest["entities"].length === 0
  )
    throw new TypeError("dist capability manifest is missing or invalid");
};

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
const gazetteerValues = (value) => {
  if (!Array.isArray(value))
    throw new TypeError("Native package gazetteerEntries must be an array");
  return value;
};

/** @param {unknown} value */
export const readNativePackageInput = (value) => {
  if (!isRecord(value))
    throw new TypeError("Native package config export must be an object");
  if (!("config" in value))
    return { config: value, gazetteerEntries: gazetteerValues([]) };
  const config = value["config"];
  if (!isRecord(config))
    throw new TypeError("Native package config must be an object");
  return {
    config,
    gazetteerEntries: gazetteerValues(value["gazetteerEntries"] ?? []),
  };
};
