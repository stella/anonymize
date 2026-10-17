import process from "node:process";

/**
 * @param {string} platform
 * @param {() => unknown} [readReport]
 */
export const detectNativeLibc = (
  platform,
  readReport = () => process.report.getReport(),
) => {
  if (platform !== "linux") return undefined;
  const report = readReport();
  if (
    typeof report !== "object" ||
    report === null ||
    Array.isArray(report) ||
    !("header" in report)
  )
    return "musl";
  const { header } = report;
  if (
    typeof header !== "object" ||
    header === null ||
    Array.isArray(header) ||
    !("glibcVersionRuntime" in header)
  )
    return "musl";
  const { glibcVersionRuntime } = header;
  return typeof glibcVersionRuntime === "string" &&
    glibcVersionRuntime.length > 0
    ? "gnu"
    : "musl";
};
