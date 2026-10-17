import { library } from "@stll/oxlint-config";
import {
  portableSafetyPluginSpecifiers,
  portableSafetyRules,
} from "@stll/oxlint-plugin";

export default library({
  // Four vendored upstream files are outside the repository's lint policy.
  ignorePatterns: ["packages/benchmark/vendor/"],
  jsPlugins: [...portableSafetyPluginSpecifiers, "./oxlint.plugin.ts"],
  rules: {
    ...portableSafetyRules,
    "stll/no-dynamic-import-specifier": "error",
  },
  overrides: [
    {
      // These additional transport checks apply to shipped TypeScript;
      // malformed runtime fixtures retain the complete portable safety pack.
      files: ["**/*.{ts,tsx,mts,cts}"],
      excludeFiles: ["**/__test__/**", "**/*.test.ts"],
      rules: {
        "stll/no-double-assertion": "error",
        "stll/no-unchecked-json-parse-typing": "error",
      },
    },
  ],
});
