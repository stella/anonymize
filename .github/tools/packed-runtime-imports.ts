import { posix } from "node:path";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isRuntimeScript = (path: string) =>
  /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path) && !/\.d\.[cm]?ts$/u.test(path);

const exportTargets = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([condition, target]) =>
    condition === "types" || condition === "typings"
      ? []
      : exportTargets(target),
  );
};

const packagePath = (path: string) => {
  const normalized = posix.normalize(path);
  if (
    posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  )
    throw new Error(`Runtime import escapes the package: ${path}`);
  return normalized;
};

type PackedRuntimeImportsOptions = {
  manifest: unknown;
  packedFiles: ReadonlySet<string>;
  readSource: (path: string) => string | undefined;
};

/** Check shipped scripts without importing or executing package code. */
export const assertPackedRuntimeImports = ({
  manifest,
  packedFiles,
  readSource,
}: PackedRuntimeImportsOptions) => {
  if (!isRecord(manifest))
    throw new Error("Expected a package manifest object");
  const bin = manifest["bin"];
  const bins = isRecord(bin) ? Object.values(bin) : [bin];
  const binPaths = [];
  for (const entry of bin === undefined ? [] : bins) {
    if (typeof entry !== "string")
      throw new Error("Expected package bin paths to be strings");
    binPaths.push(entry);
  }
  const roots = [
    ...binPaths,
    ...exportTargets(manifest["exports"]),
    ...exportTargets(manifest["main"]),
    ...[...packedFiles].filter(isRuntimeScript),
  ];
  const pending = roots.map(packagePath);
  const visited = new Set<string>();
  const scanner = new Bun.Transpiler({ loader: "tsx" });
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined) throw new Error("Missing pending runtime path");
    if (visited.has(path)) continue;
    if (!packedFiles.has(path))
      throw new Error(`Runtime file is not packed: ${path}`);
    visited.add(path);
    if (!isRuntimeScript(path)) continue;
    const source = readSource(path);
    if (source === undefined)
      throw new Error(`Packed runtime source is missing: ${path}`);
    for (const dependency of scanner.scanImports(source)) {
      if (
        dependency.kind !== "import-statement" &&
        dependency.kind !== "require-call" &&
        dependency.kind !== "dynamic-import"
      )
        continue;
      const specifier = dependency.path;
      if (specifier.startsWith("#"))
        throw new Error(
          `Package import mapping requires resolution: ${path} -> ${specifier}`,
        );
      if (specifier.startsWith("/") || specifier.startsWith("file:"))
        throw new Error(
          `Runtime import escapes the package: ${path} -> ${specifier}`,
        );
      if (!specifier.startsWith(".")) continue;
      const target = packagePath(posix.join(posix.dirname(path), specifier));
      const candidates =
        dependency.kind === "require-call"
          ? [
              target,
              ...[
                ".js",
                ".json",
                ".node",
                "/index.js",
                "/index.json",
                "/index.node",
              ].map((suffix) => target + suffix),
            ]
          : [target];
      const resolved = candidates.find((candidate) =>
        packedFiles.has(candidate),
      );
      if (resolved === undefined)
        throw new Error(
          `Static runtime import is not packed: ${path} -> ${specifier}`,
        );
      pending.push(resolved);
    }
  }
  return visited;
};
