/** @param {string} source */
export const parseJsonValue = (source) => {
  /** @type {unknown} */
  const value = JSON.parse(source);
  return value;
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isJsonObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {string} source */
export const parseJsonObject = (source) => {
  const value = parseJsonValue(source);
  if (!isJsonObject(value)) throw new TypeError("Expected a JSON object");
  return value;
};

/** @param {string} source */
export const parseStringList = (source) => {
  const value = parseJsonValue(source);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new TypeError("Expected a JSON array of strings");
  return value;
};

/** @param {unknown} value */
const packFile = (value) => {
  if (
    !isJsonObject(value) ||
    typeof value.path !== "string" ||
    typeof value.size !== "number" ||
    !Number.isFinite(value.size) ||
    value.size < 0
  )
    throw new TypeError("Invalid npm pack file metadata");
  return { path: value.path, size: value.size };
};

/** @param {string} source */
export const parseNpmPack = (source) => {
  const value = parseJsonValue(source);
  if (!Array.isArray(value)) throw new TypeError("Expected npm pack metadata");
  const first = value.at(0);
  if (
    !isJsonObject(first) ||
    !Array.isArray(first.files) ||
    typeof first.unpackedSize !== "number" ||
    !Number.isFinite(first.unpackedSize) ||
    first.unpackedSize < 0
  )
    throw new TypeError("Invalid npm pack metadata");
  return { files: first.files.map(packFile), unpackedSize: first.unpackedSize };
};
