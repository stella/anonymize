/**
 * Repo-local oxlint rules, loaded through `jsPlugins` in
 * oxlint.config.ts (ESLint-compatible plugin shape).
 */

type ImportExpressionSource = {
  type: string;
  value?: unknown;
  expressions?: readonly unknown[];
};

type ImportExpressionNode = {
  type: "ImportExpression";
  source: ImportExpressionSource;
};

type RuleContext = {
  report: (descriptor: { node: unknown; messageId: string }) => void;
};

/**
 * Bundled packages must use statically resolvable import specifiers:
 * a computed specifier survives bundling as a runtime-relative path
 * that does not exist in dist (the published artifact), failing only
 * at runtime for package consumers. Contexts that resolve imports at
 * runtime instead of bundling (tests, the data package, bench) opt
 * out via overrides in oxlint.config.ts.
 */
const noDynamicImportSpecifier = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow computed dynamic import specifiers in bundled packages",
    },
    messages: {
      dynamicSpecifier:
        "Computed import() specifiers cannot be resolved by the bundler and break in dist. " +
        "Use a registry of literal import specifiers instead " +
        "(see NONWESTERN_NAME_IMPORTS in packages/anonymize/src/detectors/names.ts " +
        "or the language registries in packages/anonymize/src/util/lang-loader.ts).",
    },
    schema: [],
  },
  create: (context: RuleContext) => ({
    ImportExpression: (node: ImportExpressionNode) => {
      const { source } = node;
      if (source.type === "Literal" && typeof source.value === "string") {
        return;
      }
      if (
        source.type === "TemplateLiteral" &&
        (source.expressions?.length ?? 0) === 0
      ) {
        return;
      }
      context.report({ node: source, messageId: "dynamicSpecifier" });
    },
  }),
};

const plugin = {
  meta: { name: "stll" },
  rules: {
    "no-dynamic-import-specifier": noDynamicImportSpecifier,
  },
};

export default plugin;
