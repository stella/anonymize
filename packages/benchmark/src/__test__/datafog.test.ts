import { describe, expect, test } from "bun:test";

import {
  DATAFOG_PROVIDER,
  PYTHON_BENCHMARK_PROVIDERS,
} from "../adapters/python-providers";
import { parsePythonResult } from "../adapters/python";
import { DATAFOG_MAPPING, supportedLabels } from "../taxonomy";

describe("DataFog benchmark provider", () => {
  test("is registered in every sealed runner", () => {
    const sealedAdapter = PYTHON_BENCHMARK_PROVIDERS.find(
      ({ name }) => name === "datafog",
    );

    expect(sealedAdapter).toBe(DATAFOG_PROVIDER);
    expect(DATAFOG_PROVIDER).toEqual({
      name: "datafog",
      venvDir: ".venv-datafog",
      script: "datafog_adapter.py",
    });
  });

  test("maps only labels emitted by the model-free regex engine", () => {
    expect([...supportedLabels(DATAFOG_MAPPING)].sort()).toEqual([
      "address",
      "date",
      "email",
      "id-number",
      "phone",
    ]);
    expect(DATAFOG_MAPPING["DE_TAX_ID"]).toBe("id-number");
    expect(DATAFOG_MAPPING["DE_POSTAL_CODE"]).toBe("address");
    expect(DATAFOG_MAPPING["IP_ADDRESS"]).toBeNull();
    expect(DATAFOG_MAPPING["PERSON"]).toBeUndefined();
    expect(DATAFOG_MAPPING["ORGANIZATION"]).toBeUndefined();
  });

  test("treats malformed provider output as a fatal protocol error", () => {
    expect(() => parsePythonResult(null)).toThrow("protocol error");
    expect(() =>
      parsePythonResult({
        version: "4.8.0",
        initSeconds: 0,
        coldSeconds: 0.1,
        warmSeconds: 0.1,
        totalChars: 5,
        results: [
          {
            id: "doc",
            entities: [{ start: 4, end: 2, label: "EMAIL", text: "x" }],
          },
        ],
      }),
    ).toThrow("entity offsets");
  });
});
