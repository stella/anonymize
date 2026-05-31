import { library } from "@stll/oxlint-config";

export default library({
  options: {
    reportUnusedDisableDirectives: "off",
  },
  ignorePatterns: [
    ".turbo/",
    "packages/*/dist/",
    "packages/anonymize/wasm/dist/",
  ],
  rules: {
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
      files: ["packages/data/dictionaries/index.ts"],
      rules: {
        "promise/always-return": "off",
        "typescript/no-confusing-void-expression": "off",
      },
    },
  ],
});
