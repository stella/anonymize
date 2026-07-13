import { library } from "@stll/oxlint-config";

export default library({
  options: {
    reportUnusedDisableDirectives: "off",
  },
  ignorePatterns: [
    ".turbo/",
    ".claude/worktrees/",
    "packages/benchmark/vendor/",
    "packages/*/dist/",
    "packages/anonymize/wasm/dist/",
  ],
  jsPlugins: ["./oxlint.plugin.ts"],
  rules: {
    "stll/no-dynamic-import-specifier": "error",
    "no-non-null-assertion": "off",
    "require-await": "off",
    "typescript/dot-notation": "off",
    "typescript/no-unnecessary-condition": "off",
    "typescript/prefer-nullish-coalescing": "off",
    "typescript/strict-boolean-expressions": "off",
  },
  overrides: [
    {
      files: [".github/tools/**", "eval-html.ts"],
      rules: {
        "no-console": "off",
        "typescript/no-unnecessary-condition": "off",
        "typescript/strict-boolean-expressions": "off",
      },
    },
    {
      files: ["packages/corpus/src/**"],
      rules: {
        "no-console": "off",
      },
    },
    {
      files: ["packages/data/dictionaries/index.ts"],
      rules: {
        "promise/always-return": "off",
        "typescript/no-confusing-void-expression": "off",
      },
    },
    {
      // Computed import() is safe where imports resolve at runtime
      // instead of being bundled: the data package ships its raw
      // dictionary JSON in the tarball (paths pinned by
      // check-packlist), and tests/bench resolve package subpaths
      // from node_modules.
      files: ["packages/data/**", "packages/bench/**", "**/__test__/**"],
      rules: {
        "stll/no-dynamic-import-specifier": "off",
      },
    },
  ],
});
