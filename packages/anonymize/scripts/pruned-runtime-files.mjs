import { copyFileSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {string} entry */
const validatePath = (entry) => {
  if (
    entry === "" ||
    entry.includes("\\") ||
    entry.includes("\0") ||
    /^[A-Za-z]:/u.test(entry) ||
    entry
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error(`Invalid published file path: ${entry}`);
  return entry;
};

/** @param {string} source */
export const parsePublishedFiles = (source) => {
  /** @type {unknown} */
  const value = JSON.parse(source);
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !record(value[0]) ||
    !Array.isArray(value[0]["files"])
  )
    throw new Error("Expected one npm pack result with files");
  /** @type {Set<string>} */
  const files = new Set();
  for (const entry of value[0]["files"]) {
    if (!record(entry) || typeof entry["path"] !== "string")
      throw new Error("Expected npm pack file paths");
    const file = validatePath(entry["path"]);
    if (files.has(file))
      throw new Error(`Duplicate published file path: ${file}`);
    files.add(file);
  }
  if (!files.has("package.json"))
    throw new Error("Published files must include package.json");
  return [...files];
};

/** @param {{sourceRoot: string, targetRoot: string, files: readonly string[]}} options */
export const copyPublishedFiles = ({ sourceRoot, targetRoot, files }) => {
  for (const file of files) {
    validatePath(file);
    const parts = file.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const source = path.join(sourceRoot, ...parts.slice(0, index));
      const entry = lstatSync(source);
      if (
        entry.isSymbolicLink() ||
        (index === parts.length ? !entry.isFile() : !entry.isDirectory())
      )
        throw new Error(
          `Published path must be a regular file without symlinks: ${file}`,
        );
    }
  }
  for (const file of files) {
    const target = path.join(targetRoot, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(sourceRoot, file), target);
  }
};
